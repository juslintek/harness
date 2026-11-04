//! Bounded one-shot commands: `bunRunner` of discover.ts and `spawnBounded` of keys.ts. The child
//! leads its own process group, so a timeout takes down the whole tree and not only the leader that
//! Bun's `proc.kill()` reaches. Built on `runtimes/process.zig`, which turns stdout into lines.
//!
//! Output differences from Bun that matter only for odd commands: stdout comes back as its
//! non-blank lines, trimmed and each ended by "\n", an unterminated last line is dropped (the line
//! reader of the ACP lane does the same), and stderr is its last 2000 bytes.
const std = @import("std");
const process_mod = @import("../runtimes/process.zig");
const specs = @import("specs.zig");

const Io = std.Io;
const Process = process_mod.Process;

/// What `bunRunner` reports when the command cannot be started.
pub const not_found_code: i32 = 127;
/// `TIMED_OUT` of keys.ts, for callers that fold a timeout into an exit code.
pub const timed_out_code: i32 = 124;

/// SIGTERM to SIGKILL for a command that is over its time.
pub const kill_grace_ms: i64 = 500;
/// After SIGKILL, a process outside the group may still hold the pipes; stop reading then.
const reader_force_ms: i64 = 2000;
const max_line_bytes: usize = 1024 * 1024;

pub const Out = struct { code: i32, stdout: []const u8, stderr: []const u8 };

/// `TimedOut` is the `timed out after N ms` error of `bunRunner`.
pub const Error = error{ TimedOut, OutOfMemory, Canceled };

pub const Runner = struct {
    ctx: *anyopaque,
    run_fn: *const fn (
        ctx: *anyopaque,
        arena: std.mem.Allocator,
        argv: []const []const u8,
        timeout_ms: i64,
        env: []const specs.EnvPair,
    ) Error!Out,

    /// `env` is added to the server's environment for this one command.
    pub fn run(
        runner: Runner,
        arena: std.mem.Allocator,
        argv: []const []const u8,
        timeout_ms: i64,
        env: []const specs.EnvPair,
    ) Error!Out {
        return runner.run_fn(runner.ctx, arena, argv, timeout_ms, env);
    }
};

/// The real thing: spawns the command with `base_env` plus the extras.
pub const ProcessRunner = struct {
    gpa: std.mem.Allocator,
    io: Io,
    base_env: *const std.process.Environ.Map,
    /// How long a killed command gets between SIGTERM and SIGKILL. Tests shorten it.
    grace_ms: i64 = kill_grace_ms,

    pub fn runner(self: *ProcessRunner) Runner {
        return .{ .ctx = self, .run_fn = runOne };
    }

    fn runOne(ctx: *anyopaque, arena: std.mem.Allocator, argv: []const []const u8, timeout_ms: i64, extra: []const specs.EnvPair) Error!Out {
        const self: *ProcessRunner = @ptrCast(@alignCast(ctx));
        return self.execute(arena, argv, timeout_ms, extra);
    }

    pub const Event = union(enum) {
        lines: Error!void,
        exited: std.process.Child.WaitError!std.process.Child.Term,
        timeout: Io.Cancelable!void,
        grace: Io.Cancelable!void,
        force: Io.Cancelable!void,
    };

    fn execute(self: *ProcessRunner, arena: std.mem.Allocator, argv: []const []const u8, timeout_ms: i64, extra: []const specs.EnvPair) Error!Out {
        const io = self.io;
        var env = try self.base_env.clone(self.gpa);
        defer env.deinit();
        for (extra) |pair| try env.put(pair.name, pair.value);

        const process = Process.spawn(self.gpa, io, .{
            .argv = argv,
            .cwd = ".",
            .env = &env,
            .max_line = max_line_bytes,
        }) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return .{ .code = not_found_code, .stdout = "", .stderr = @errorName(err) },
        };
        defer process.destroy();
        // stdin is "ignore" in TS: the command sees end of file at once.
        if (process.child.stdin) |stdin| {
            stdin.close(io);
            process.child.stdin = null;
        }

        var text: std.ArrayList(u8) = .empty;
        defer text.deinit(self.gpa);

        var buffer: [8]Event = undefined;
        var select: Io.Select(Event) = .init(io, &buffer);
        defer select.cancelDiscard();
        // The wait goes last: if it cannot start the child is untouched and `destroy` ends its
        // group. Once it runs it is never cancelled, as that would leave the leader unreaped.
        select.concurrent(.timeout, sleepMs, .{ io, timeout_ms }) catch return error.Canceled;
        select.concurrent(.lines, collect, .{ process, &text, self.gpa }) catch return error.Canceled;
        select.concurrent(.exited, waitExit, .{process}) catch return error.Canceled;

        var term: ?std.process.Child.Term = null;
        var eof = false;
        var over_time = false;
        while (term == null or !eof) {
            const event = select.await() catch return abort(process, &select);
            switch (event) {
                .lines => |result| {
                    result catch return abort(process, &select);
                    eof = true;
                },
                .exited => |result| term = result catch {
                    process.term = .{ .unknown = 0 };
                    return .{ .code = not_found_code, .stdout = "", .stderr = "wait failed" };
                },
                .timeout => |result| {
                    result catch return abort(process, &select);
                    if (term != null) continue;
                    over_time = true;
                    process_mod.signalGroup(process.pgid, .TERM);
                    select.concurrent(.grace, sleepMs, .{ io, self.grace_ms }) catch return abort(process, &select);
                },
                .grace => |result| {
                    result catch return abort(process, &select);
                    process_mod.signalGroup(process.pgid, .KILL);
                    select.concurrent(.force, sleepMs, .{ io, reader_force_ms }) catch return abort(process, &select);
                },
                .force => |result| {
                    result catch return abort(process, &select);
                    // Whoever still holds the pipes is outside the group; the leader is reaped once
                    // the readers are gone.
                    process.readers.cancel(io);
                    process.lines.close(io);
                },
            }
        }
        const ended = term.?;
        // Reaped: `destroy` must not signal or wait again, and a member of the group that
        // outlived the leader must not outlive the probe either.
        process.term = ended;
        if (process_mod.groupExists(process.pgid)) process_mod.signalGroup(process.pgid, .KILL);

        const code: i32 = switch (ended) {
            // Bun sets signalCode for a child killed by a signal, which `bunRunner` reports as a timeout.
            .signal => return error.TimedOut,
            .exited => |exit_code| exit_code,
            .stopped, .unknown => 1,
        };
        if (over_time) return error.TimedOut;
        const stderr_tail = try process.stderrTail(self.gpa);
        defer self.gpa.free(stderr_tail);
        return .{
            .code = code,
            .stdout = try arena.dupe(u8, text.items),
            .stderr = try arena.dupe(u8, stderr_tail),
        };
    }
};

/// A cancelled or broken run: end the group, then let the wait finish so the leader is reaped
/// and `destroy` has nothing left to signal.
fn abort(process: *Process, select: *Io.Select(ProcessRunner.Event)) Error {
    const io = process.io;
    const previous = io.swapCancelProtection(.blocked);
    defer _ = io.swapCancelProtection(previous);
    process_mod.signalGroup(process.pgid, .KILL);
    process.lines.close(io);
    while (true) switch (select.await() catch return error.Canceled) {
        .exited => |result| {
            process.term = result catch .{ .unknown = 0 };
            return error.Canceled;
        },
        else => {},
    };
}

fn collect(process: *Process, text: *std.ArrayList(u8), gpa: std.mem.Allocator) Error!void {
    while (true) {
        const line = process.lines.getOne(process.io) catch |err| switch (err) {
            error.Closed => return,
            error.Canceled => return error.Canceled,
        };
        switch (line) {
            .text => |bytes| {
                defer process.gpa.free(bytes);
                try text.appendSlice(gpa, bytes);
                try text.append(gpa, '\n');
            },
            .eof, .failed => return,
        }
    }
}

/// Resolves once both pipes are drained: `Child.wait` closes them, so the readers must be done
/// before the leader is reaped (the order `Process.terminate` keeps too).
fn waitExit(process: *Process) std.process.Child.WaitError!std.process.Child.Term {
    try process.stdout_done.wait(process.io);
    try process.stderr_done.wait(process.io);
    return process.child.wait(process.io);
}

fn sleepMs(io: Io, ms: i64) Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

const testing = std.testing;

fn testEnv() !std.process.Environ.Map {
    var env = std.process.Environ.Map.init(testing.allocator);
    errdefer env.deinit();
    try env.put("PATH", "/usr/bin:/bin:/opt/homebrew/bin");
    return env;
}

fn sh(runner: *ProcessRunner, arena: std.mem.Allocator, script: []const u8, timeout_ms: i64, env: []const specs.EnvPair) Error!Out {
    return runner.runner().run(arena, &.{ "/bin/sh", "-c", script }, timeout_ms, env);
}

fn expectGone(pid: std.posix.pid_t) !void {
    for (0..200) |_| {
        if (!process_mod.pidExists(pid)) return;
        try testing.io.sleep(.fromMilliseconds(10), .awake);
    }
    return error.StillAlive;
}

fn readPid(arena: std.mem.Allocator, dir: Io.Dir) !std.posix.pid_t {
    const text = try dir.readFileAlloc(testing.io, "pid", arena, .limited(64));
    return std.fmt.parseInt(std.posix.pid_t, std.mem.trim(u8, text, "\n"), 10);
}

test "agents: a command's output and exit status come back" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var env = try testEnv();
    defer env.deinit();
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env };
    const out = try sh(&runner, arena.allocator(), "echo 1.2.3; echo oops >&2; exit 3", 5000, &.{});
    try testing.expectEqual(@as(i32, 3), out.code);
    try testing.expectEqualStrings("1.2.3\n", out.stdout);
    try testing.expectEqualStrings("oops\n", out.stderr);
}

test "agents: a missing executable is code 127 and a closed stdin ends cat" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var env = try testEnv();
    defer env.deinit();
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env };
    const missing = try runner.runner().run(arena.allocator(), &.{"definitely-not-installed-xyz"}, 5000, &.{});
    try testing.expectEqual(not_found_code, missing.code);
    const cat = try runner.runner().run(arena.allocator(), &.{"cat"}, 5000, &.{});
    try testing.expectEqual(@as(i32, 0), cat.code);
}

test "agents: the extra environment reaches the command" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var env = try testEnv();
    defer env.deinit();
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env };
    const out = try sh(&runner, arena.allocator(), "echo \"$CODEX_HOME:$PATH\"", 5000, &.{.{ .name = "CODEX_HOME", .value = "/h/.codex" }});
    try testing.expectEqualStrings("/h/.codex:/usr/bin:/bin:/opt/homebrew/bin\n", out.stdout);
}

test "agents: a command that closes stdout and then exits normally is not killed" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var env = try testEnv();
    defer env.deinit();
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env };
    const out = try sh(&runner, arena.allocator(), "echo hi; exec >&- 2>&-; sleep 0.3; exit 0", 5000, &.{});
    try testing.expectEqual(@as(i32, 0), out.code);
    try testing.expectEqualStrings("hi\n", out.stdout);
}

test "agents: a timeout kills the leader and its grandchild" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var env = try testEnv();
    defer env.deinit();
    var dir_buf: [Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = dir_buf[0..try tmp.dir.realPath(testing.io, &dir_buf)];
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env, .grace_ms = 100 };
    const script = "sleep 30 & echo $! > \"$DIR/pid\"; wait";
    try testing.expectError(error.TimedOut, sh(&runner, arena.allocator(), script, 300, &.{.{ .name = "DIR", .value = dir_path }}));
    try expectGone(try readPid(arena.allocator(), tmp.dir));
}

test "agents: a grandchild that ignores SIGTERM is killed with the group on timeout" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var env = try testEnv();
    defer env.deinit();
    var dir_buf: [Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = dir_buf[0..try tmp.dir.realPath(testing.io, &dir_buf)];
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env, .grace_ms = 100 };
    const script = "sh -c 'trap \"\" TERM; echo $$ > \"$DIR/pid\"; exec sleep 30' & trap '' TERM; wait";
    try testing.expectError(error.TimedOut, sh(&runner, arena.allocator(), script, 400, &.{.{ .name = "DIR", .value = dir_path }}));
    try expectGone(try readPid(arena.allocator(), tmp.dir));
}

test "agents: a member of the group that outlives a normal exit is killed" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var env = try testEnv();
    defer env.deinit();
    var dir_buf: [Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = dir_buf[0..try tmp.dir.realPath(testing.io, &dir_buf)];
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env };
    const out = try sh(&runner, arena.allocator(), "sleep 30 >/dev/null 2>&1 & echo $! > \"$DIR/pid\"; echo done", 5000, &.{.{ .name = "DIR", .value = dir_path }});
    try testing.expectEqual(@as(i32, 0), out.code);
    try expectGone(try readPid(arena.allocator(), tmp.dir));
}

test "agents: a child killed by a signal is reported as timed out, like bunRunner" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var env = try testEnv();
    defer env.deinit();
    var runner: ProcessRunner = .{ .gpa = testing.allocator, .io = testing.io, .base_env = &env };
    try testing.expectError(error.TimedOut, sh(&runner, arena.allocator(), "kill -9 $$", 5000, &.{}));
}
