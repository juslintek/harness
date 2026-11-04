//! A child process in its own process group, with its stdout turned into NDJSON lines on a queue
//! and its stderr kept as a tail. TS: Bun.spawn with `detached: true` plus the readers and
//! `terminate` of code/src/server/features/runtimes/acp-rpc.ts.
//!
//! The pipes are closed by `Child.wait`, so both reader tasks must have reached end of stream
//! (or been cancelled) before the leader is reaped. `terminate` keeps that order and escalates to
//! SIGKILL for as long as the group still exists.
const std = @import("std");
const ndjson = @import("ndjson.zig");

const Io = std.Io;
const pid_t = std.posix.pid_t;

pub const stderr_tail_bytes = 2000;
const queue_depth = 64;
const group_poll_ms = 10;
/// How long the readers get to see end of stream after SIGKILL before they are cancelled.
const reader_force_ms = 2000;

pub const Line = union(enum) {
    /// Owned by the receiver, allocated with the process's allocator.
    text: []u8,
    eof,
    failed: anyerror,
};

pub const Options = struct {
    argv: []const []const u8,
    cwd: []const u8,
    env: *const std.process.Environ.Map,
    max_line: usize = ndjson.default_max_line,
    /// Every complete stdout line is appended here, like acp-tee.ts.
    tee_path: ?[]const u8 = null,
    /// Test hook: counts every close of the tee file, to prove it has exactly one owner.
    tee_close_counter: ?*std.atomic.Value(u32) = null,
    /// Test hook: that many `terminate` calls fail with GroupSurvivedKill without signalling.
    inject_terminate_failures: u32 = 0,
};

pub const Process = struct {
    gpa: std.mem.Allocator,
    io: Io,
    child: std.process.Child,
    pgid: pid_t,
    max_line: usize,
    lines_buffer: [queue_depth]Line = undefined,
    lines: Io.Queue(Line),
    readers: Io.Group = .init,
    stdout_done: Io.Event = .unset,
    stderr_done: Io.Event = .unset,
    tail_mutex: Io.Mutex = .init,
    tail: [stderr_tail_bytes]u8 = undefined,
    tail_len: usize = 0,
    skipped: std.atomic.Value(usize) = .init(0),
    tee: ?Tee = null,
    tee_close_counter: ?*std.atomic.Value(u32) = null,
    terminate_failures_left: u32 = 0,
    term: ?std.process.Child.Term = null,

    const Tee = struct { file: Io.File, offset: u64 = 0 };

    /// Starts the child as the leader of a new process group and both reader tasks. The caller
    /// owns the result and ends it with `destroy`.
    pub fn spawn(gpa: std.mem.Allocator, io: Io, options: Options) !*Process {
        const process = try gpa.create(Process);
        errdefer gpa.destroy(process);
        process.* = .{
            .gpa = gpa,
            .io = io,
            .child = undefined,
            .pgid = undefined,
            .max_line = options.max_line,
            .lines = undefined,
        };
        process.lines = .init(&process.lines_buffer);
        process.tee_close_counter = options.tee_close_counter;
        process.terminate_failures_left = options.inject_terminate_failures;
        if (options.tee_path) |path| process.tee = try openTee(io, path, options.tee_close_counter);
        errdefer if (process.tee) |tee| closeTee(tee.file, io, options.tee_close_counter);
        process.child = try std.process.spawn(io, .{
            .argv = options.argv,
            .cwd = .{ .path = options.cwd },
            .environ_map = options.env,
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .pipe,
            .pgid = 0,
        });
        process.pgid = process.child.id.?;
        errdefer process.abortStart();
        try process.readers.concurrent(io, stdoutPump, .{process});
        try process.readers.concurrent(io, stderrPump, .{process});
        return process;
    }

    /// The file is closed here when it cannot be sized; after that `spawn` owns it.
    fn openTee(io: Io, path: []const u8, counter: ?*std.atomic.Value(u32)) !Tee {
        const file = try Io.Dir.cwd().createFile(io, path, .{ .truncate = false });
        errdefer closeTee(file, io, counter);
        return .{ .file = file, .offset = try file.length(io) };
    }

    fn closeTee(file: Io.File, io: Io, counter: ?*std.atomic.Value(u32)) void {
        file.close(io);
        if (counter) |count| _ = count.fetchAdd(1, .monotonic);
    }

    /// Failure path of `spawn`: nothing may outlive it, not the group and not a started reader.
    fn abortStart(process: *Process) void {
        signalGroup(process.pgid, .KILL);
        process.readers.cancel(process.io);
        process.child.kill(process.io);
    }

    /// Ends the run's process: terminates it when that has not happened, frees queued lines and
    /// closes the tee. Safe after `terminate`.
    pub fn destroy(process: *Process) void {
        const io = process.io;
        if (process.term == null) {
            _ = process.terminate(0) catch |err| {
                // The group may be alive and this record is its only owner: leak it rather than
                // free state a later retry needs.
                std.log.err("process group {d} not ended, record kept: {t}", .{ process.pgid, err });
                return;
            };
        }
        process.readers.cancel(io);
        process.lines.close(io);
        while (process.lines.getOneUncancelable(io)) |line| {
            switch (line) {
                .text => |text| process.gpa.free(text),
                .eof, .failed => {},
            }
        } else |err| switch (err) {
            error.Closed => {},
        }
        if (process.tee) |tee| closeTee(tee.file, io, process.tee_close_counter);
        const gpa = process.gpa;
        gpa.destroy(process);
    }

    /// One newline-terminated message to the child's stdin. The loop that owns the process is the
    /// only writer.
    pub fn writeLine(process: *Process, bytes: []const u8) !void {
        const stdin = process.child.stdin orelse return error.StdinClosed;
        try stdin.writeStreamingAll(process.io, bytes);
        try stdin.writeStreamingAll(process.io, "\n");
    }

    /// The last bytes the child wrote to stderr, owned by the caller.
    pub fn stderrTail(process: *Process, gpa: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
        process.tail_mutex.lockUncancelable(process.io);
        defer process.tail_mutex.unlock(process.io);
        return gpa.dupe(u8, process.tail[0..process.tail_len]);
    }

    pub fn skippedLines(process: *Process) usize {
        return process.skipped.load(.monotonic);
    }

    const Wait = union(enum) {
        out: Io.Cancelable!void,
        err: Io.Cancelable!void,
        grace: Io.Cancelable!void,
        force: Io.Cancelable!void,
        exited: std.process.Child.WaitError!std.process.Child.Term,
    };

    /// SIGTERM to the group, SIGKILL once `grace_ms` has passed and again for as long as any
    /// member of the group is alive. Returns how the leader ended and has reaped it, so no zombie
    /// is left. Not cancelable: it is the cleanup path.
    pub fn terminate(process: *Process, grace_ms: i64) !std.process.Child.Term {
        if (process.term) |term| return term;
        if (process.terminate_failures_left > 0) {
            process.terminate_failures_left -= 1;
            return error.GroupSurvivedKill;
        }
        const io = process.io;
        const previous = io.swapCancelProtection(.blocked);
        defer _ = io.swapCancelProtection(previous);

        // Nobody reads the queue any more, and a reader blocked on a full queue would never see
        // the end of its stream.
        process.lines.close(io);

        // A closed stdin is how most agents learn the conversation is over.
        if (process.child.stdin) |stdin| {
            stdin.close(io);
            process.child.stdin = null;
        }
        signalGroup(process.pgid, .TERM);
        var killed = false;

        var buffer: [8]Wait = undefined;
        var select: Io.Select(Wait) = .init(io, &buffer);
        defer select.cancelDiscard();
        try select.concurrent(.out, waitEvent, .{ io, &process.stdout_done });
        try select.concurrent(.err, waitEvent, .{ io, &process.stderr_done });
        try select.concurrent(.grace, sleepMs, .{ io, grace_ms });
        var finished: u8 = 0;
        while (finished < 2) switch (try select.await()) {
            .out, .err => finished += 1,
            .grace => {
                signalGroup(process.pgid, .KILL);
                killed = true;
                try select.concurrent(.force, sleepMs, .{ io, reader_force_ms });
            },
            .force => {
                // A process outside the group keeps a pipe open: stop reading rather than hang.
                process.readers.cancel(io);
                break;
            },
            .exited => unreachable,
        };
        select.cancelDiscard();

        const term = try process.reap(grace_ms, &killed);
        process.term = term;
        return term;
    }

    fn reap(process: *Process, grace_ms: i64, killed: *bool) !std.process.Child.Term {
        const io = process.io;
        var buffer: [4]Wait = undefined;
        var select: Io.Select(Wait) = .init(io, &buffer);
        defer select.cancelDiscard();
        try select.concurrent(.exited, waitChild, .{ io, &process.child });
        if (!killed.*) try select.concurrent(.grace, sleepMs, .{ io, grace_ms });
        const term = while (true) switch (try select.await()) {
            .exited => |result| break try result,
            .grace => {
                signalGroup(process.pgid, .KILL);
                killed.* = true;
            },
            .out, .err, .force => unreachable,
        };
        // The leader is gone; a grandchild may have ignored SIGTERM.
        var waited: i64 = 0;
        while (groupExists(process.pgid)) : (waited += group_poll_ms) {
            if (waited >= grace_ms) {
                signalGroup(process.pgid, .KILL);
                killed.* = true;
                break;
            }
            try io.sleep(.fromMilliseconds(group_poll_ms), .awake);
        }
        if (killed.*) try process.awaitGroupGone();
        return term;
    }

    fn awaitGroupGone(process: *Process) !void {
        var waited: i64 = 0;
        while (groupExists(process.pgid)) : (waited += group_poll_ms) {
            if (waited >= reader_force_ms) return error.GroupSurvivedKill;
            signalGroup(process.pgid, .KILL);
            try process.io.sleep(.fromMilliseconds(group_poll_ms), .awake);
        }
    }

    fn stdoutPump(process: *Process) void {
        defer process.stdout_done.set(process.io);
        var buffer: [64 * 1024]u8 = undefined;
        var file_reader = process.child.stdout.?.reader(process.io, &buffer);
        var lines = ndjson.LineReader.init(process.gpa, &file_reader.interface, process.max_line);
        defer lines.deinit();
        while (true) {
            const maybe_line = lines.next() catch |err| {
                process.skipped.store(lines.skipped, .monotonic);
                return process.put(.{ .failed = err });
            };
            process.skipped.store(lines.skipped, .monotonic);
            const line = maybe_line orelse return process.put(.eof);
            process.appendTee(line);
            const copy = process.gpa.dupe(u8, line) catch return process.put(.{ .failed = error.OutOfMemory });
            process.lines.putOne(process.io, .{ .text = copy }) catch |err| {
                process.gpa.free(copy);
                switch (err) {
                    // The consumer is gone or the task was cancelled: stop reading.
                    error.Closed, error.Canceled => return,
                }
            };
        }
    }

    fn put(process: *Process, line: Line) void {
        process.lines.putOne(process.io, line) catch |err| switch (err) {
            error.Closed, error.Canceled => {},
        };
    }

    fn appendTee(process: *Process, line: []const u8) void {
        const tee = &(process.tee orelse return);
        tee.file.writePositionalAll(process.io, line, tee.offset) catch |err| {
            std.log.warn("acp tee write failed: {t}", .{err});
            return;
        };
        tee.offset += line.len;
        tee.file.writePositionalAll(process.io, "\n", tee.offset) catch |err| {
            std.log.warn("acp tee write failed: {t}", .{err});
            return;
        };
        tee.offset += 1;
    }

    fn stderrPump(process: *Process) void {
        defer process.stderr_done.set(process.io);
        var buffer: [4096]u8 = undefined;
        var file_reader = process.child.stderr.?.reader(process.io, &buffer);
        const reader = &file_reader.interface;
        while (true) {
            const chunk = reader.peekGreedy(1) catch return;
            process.appendTail(chunk);
            reader.toss(chunk.len);
        }
    }

    fn appendTail(process: *Process, chunk: []const u8) void {
        process.tail_mutex.lockUncancelable(process.io);
        defer process.tail_mutex.unlock(process.io);
        if (chunk.len >= stderr_tail_bytes) {
            @memcpy(&process.tail, chunk[chunk.len - stderr_tail_bytes ..]);
            process.tail_len = stderr_tail_bytes;
            return;
        }
        const overflow = (process.tail_len + chunk.len) -| stderr_tail_bytes;
        if (overflow > 0) {
            std.mem.copyForwards(u8, process.tail[0 .. process.tail_len - overflow], process.tail[overflow..process.tail_len]);
            process.tail_len -= overflow;
        }
        @memcpy(process.tail[process.tail_len..][0..chunk.len], chunk);
        process.tail_len += chunk.len;
    }
};

fn waitEvent(io: Io, event: *Io.Event) Io.Cancelable!void {
    return event.wait(io);
}

fn sleepMs(io: Io, ms: i64) Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

fn waitChild(io: Io, child: *std.process.Child) std.process.Child.WaitError!std.process.Child.Term {
    return child.wait(io);
}

/// A group that is already gone (ESRCH) is the goal. EPERM is what macOS answers when only a
/// zombie leader is left, which is also nothing to signal.
pub fn signalGroup(pgid: pid_t, sig: std.posix.SIG) void {
    std.posix.kill(-pgid, sig) catch |err| switch (err) {
        error.ProcessNotFound, error.PermissionDenied => {},
        else => std.log.warn("kill({d}, {t}) failed: {t}", .{ -pgid, sig, err }),
    };
}

/// Signal 0 probes without delivering anything. Called after the leader is reaped, when ESRCH
/// means no member is left.
pub fn groupExists(pgid: pid_t) bool {
    std.posix.kill(-pgid, @fromBackingInt(0)) catch return false;
    return true;
}

pub fn pidExists(pid: pid_t) bool {
    std.posix.kill(pid, @fromBackingInt(0)) catch |err| return err == error.PermissionDenied;
    return true;
}

const testing = std.testing;

fn testEnv(gpa: std.mem.Allocator) !std.process.Environ.Map {
    var env = std.process.Environ.Map.init(gpa);
    errdefer env.deinit();
    try env.put("PATH", "/usr/bin:/bin:/opt/homebrew/bin");
    return env;
}

fn shell(gpa: std.mem.Allocator, io: Io, env: *const std.process.Environ.Map, script: []const u8) !*Process {
    return Process.spawn(gpa, io, .{ .argv = &.{ "/bin/sh", "-c", script }, .cwd = "/", .env = env });
}

fn nextText(process: *Process) !?[]u8 {
    return switch (try process.lines.getOne(process.io)) {
        .text => |text| text,
        .eof => null,
        .failed => |err| err,
    };
}

fn openFdCount(io: Io) !usize {
    var dir = try Io.Dir.cwd().openDir(io, "/dev/fd", .{ .iterate = true });
    defer dir.close(io);
    var count: usize = 0;
    var it = dir.iterate();
    while (try it.next(io)) |_| count += 1;
    return count;
}

test "process: stdout lines arrive in order, the exit status is captured" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "printf 'a\\n\\nb\\n'; exit 3");
    defer process.destroy();
    for ([_][]const u8{ "a", "b" }) |want| {
        const got = (try nextText(process)).?;
        defer testing.allocator.free(got);
        try testing.expectEqualStrings(want, got);
    }
    try testing.expect((try nextText(process)) == null);
    const term = try process.terminate(500);
    try testing.expectEqual(@as(u8, 3), term.exited);
}

test "process: stderr keeps only its tail" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "head -c 5000 /dev/zero | tr '\\0' a >&2; printf END >&2; echo done; sleep 30");
    defer process.destroy();
    const done = (try nextText(process)).?;
    defer testing.allocator.free(done);
    _ = try process.terminate(2000);
    const tail = try process.stderrTail(testing.allocator);
    defer testing.allocator.free(tail);
    try testing.expectEqual(@as(usize, stderr_tail_bytes), tail.len);
    try testing.expect(std.mem.endsWith(u8, tail, "aaaEND"));
}

test "process: an oversized line ends the stream with LineTooLong" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try Process.spawn(testing.allocator, io, .{
        .argv = &.{ "/bin/sh", "-c", "head -c 500 /dev/zero | tr '\\0' x; printf '\\nok\\n'; sleep 30" },
        .cwd = "/",
        .env = &env,
        .max_line = 64,
    });
    defer process.destroy();
    try testing.expectError(error.LineTooLong, nextText(process));
    try testing.expectEqual(@as(usize, 1), process.skippedLines());
    _ = try process.terminate(500);
}

test "process: terminate ends the leader and its grandchild with SIGTERM" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "sleep 30 & echo $!; wait");
    defer process.destroy();
    const pid_text = (try nextText(process)).?;
    defer testing.allocator.free(pid_text);
    const grandchild = try std.fmt.parseInt(pid_t, pid_text, 10);
    try testing.expect(pidExists(grandchild));
    const term = try process.terminate(2000);
    try testing.expectEqual(std.posix.SIG.TERM, term.signal);
    try testing.expect(!groupExists(process.pgid));
    try testing.expect(!pidExists(grandchild));
}

test "process: a child that ignores SIGTERM is killed after the grace" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "trap '' TERM; echo ready; while :; do sleep 1; done");
    defer process.destroy();
    const ready = (try nextText(process)).?;
    defer testing.allocator.free(ready);
    const term = try process.terminate(150);
    try testing.expectEqual(std.posix.SIG.KILL, term.signal);
    try testing.expect(!groupExists(process.pgid));
}

test "process: a grandchild that outlives the leader and ignores SIGTERM is still killed" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "sh -c 'trap \"\" TERM; exec sleep 30' & echo $!; wait");
    defer process.destroy();
    const pid_text = (try nextText(process)).?;
    defer testing.allocator.free(pid_text);
    const grandchild = try std.fmt.parseInt(pid_t, pid_text, 10);
    try io.sleep(.fromMilliseconds(100), .awake);
    try testing.expect(pidExists(grandchild));
    _ = try process.terminate(300);
    try testing.expect(!groupExists(process.pgid));
    try testing.expect(!pidExists(grandchild));
}

test "process: repeated spawn and terminate leaks no descriptors" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const before = try openFdCount(io);
    for (0..8) |_| {
        const process = try shell(testing.allocator, io, &env, "echo hi; sleep 30");
        defer process.destroy();
        _ = try process.terminate(500);
    }
    try testing.expectEqual(before, try openFdCount(io));
}

test "process: writeLine reaches the child's stdin" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "read line; echo got:$line");
    defer process.destroy();
    try process.writeLine("ping");
    const got = (try nextText(process)).?;
    defer testing.allocator.free(got);
    try testing.expectEqualStrings("got:ping", got);
    _ = try process.terminate(500);
}

// The slice's other files are reached from main.zig only through this one.
test {
    _ = @import("ndjson.zig");
    _ = @import("types.zig");
    _ = @import("acp_updates.zig");
    _ = @import("acp.zig");
    _ = @import("acp_test.zig");
    _ = @import("launch.zig");
    _ = @import("manager.zig");
    _ = @import("manager_test.zig");
}

test "process: a write after the child exited fails instead of killing the server" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    const process = try shell(testing.allocator, io, &env, "exit 0");
    defer process.destroy();
    try testing.expect((try nextText(process)) == null);
    _ = try process.terminate(500);
    try testing.expectError(error.StdinClosed, process.writeLine("late"));
}

test "process: stdout lines are copied to the tee file" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realPathFileAlloc(io, ".", testing.allocator);
    defer testing.allocator.free(dir);
    const path = try std.fs.path.join(testing.allocator, &.{ dir, "tee.jsonl" });
    defer testing.allocator.free(path);
    const process = try Process.spawn(testing.allocator, io, .{
        .argv = &.{ "/bin/sh", "-c", "printf 'one\\ntwo\\n'" },
        .cwd = "/",
        .env = &env,
        .tee_path = path,
    });
    defer process.destroy();
    while (try nextText(process)) |line| testing.allocator.free(line);
    _ = try process.terminate(500);
    const copied = try Io.Dir.cwd().readFileAlloc(io, path, testing.allocator, .limited(1024));
    defer testing.allocator.free(copied);
    try testing.expectEqualStrings("one\ntwo\n", copied);
}

test "process: a failed spawn leaves no child behind" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    try testing.expectError(error.FileNotFound, Process.spawn(testing.allocator, io, .{
        .argv = &.{"/nonexistent/agent-binary"},
        .cwd = "/",
        .env = &env,
    }));
}

test "process: a failed spawn closes the tee file exactly once" {
    // The descriptor count of the whole process is not stable while other tests run, so the
    // tee's own closes are counted instead.
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realPathFileAlloc(io, ".", testing.allocator);
    defer testing.allocator.free(dir);
    const path = try std.fs.path.join(testing.allocator, &.{ dir, "tee.jsonl" });
    defer testing.allocator.free(path);
    for (0..4) |_| {
        var closes: std.atomic.Value(u32) = .init(0);
        try testing.expectError(error.FileNotFound, Process.spawn(testing.allocator, io, .{
            .argv = &.{"/nonexistent/agent-binary"},
            .cwd = "/",
            .env = &env,
            .tee_path = path,
            .tee_close_counter = &closes,
        }));
        try testing.expectEqual(@as(u32, 1), closes.load(.acquire));
    }
}

test "process: a started process closes the tee file once in destroy" {
    const io = testing.io;
    var env = try testEnv(testing.allocator);
    defer env.deinit();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realPathFileAlloc(io, ".", testing.allocator);
    defer testing.allocator.free(dir);
    const path = try std.fs.path.join(testing.allocator, &.{ dir, "tee.jsonl" });
    defer testing.allocator.free(path);
    var closes: std.atomic.Value(u32) = .init(0);
    const process = try Process.spawn(testing.allocator, io, .{
        .argv = &.{ "/bin/sh", "-c", "exit 0" },
        .cwd = "/",
        .env = &env,
        .tee_path = path,
        .tee_close_counter = &closes,
    });
    _ = try process.terminate(500);
    try testing.expectEqual(@as(u32, 0), closes.load(.acquire));
    process.destroy();
    try testing.expectEqual(@as(u32, 1), closes.load(.acquire));
}
