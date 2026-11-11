//! Tests of the orchestrator in check.zig against an in-memory database, a stub Ollaya and a real
//! L1 scope in a temporary directory. A human is a second thread that decides the pending row.
const std = @import("std");
const Fixture = @import("../auth/fixture.zig").Fixture;
const State = @import("../app.zig").State;
const ids = @import("../ids.zig");
const sqlite = @import("../db/sqlite.zig");
const approvals = @import("approvals.zig");
const check = @import("check.zig");
const client_mod = @import("../laya/client.zig");
const stub_mod = @import("laya_stub.zig");
const types = @import("../runtimes/types.zig");

const testing = std.testing;
const io = testing.io;

const benign = "{\"model\":\"laya:en\",\"state_truncated\":false,\"answers\":{\"destructive\":{\"type\":\"noul\",\"noul\":0.1}," ++
    "\"exfiltration\":{\"type\":\"noul\",\"noul\":0.1},\"out_of_scope\":{\"type\":\"noul\",\"noul\":0.1}," ++
    "\"risk\":{\"type\":\"score\",\"probabilities\":{\"0\":0.8,\"1\":0.15,\"2\":0.05}}}}";
const destructive = "{\"model\":\"laya:en\",\"state_truncated\":false,\"answers\":{\"destructive\":{\"type\":\"noul\",\"noul\":0.99}," ++
    "\"exfiltration\":{\"type\":\"noul\",\"noul\":0.1},\"out_of_scope\":{\"type\":\"noul\",\"noul\":0.1}," ++
    "\"risk\":{\"type\":\"score\",\"probabilities\":{\"0\":0.8,\"1\":0.15,\"2\":0.05}}}}";

const Rig = struct {
    fx: *Fixture,
    tmp: testing.TmpDir,
    root: []u8,
    home: []u8,
    stub: *stub_mod.Stub,
    client: client_mod.Client,
    url: [64]u8 = undefined,

    fn create(replies: []const stub_mod.Reply) !*Rig {
        const self = try testing.allocator.create(Rig);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, io);
        errdefer self.fx.destroy();
        self.tmp = testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        try self.tmp.dir.createDirPath(io, "root");
        try self.tmp.dir.createDirPath(io, "home");
        var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const base = buf[0..try self.tmp.dir.realPath(io, &buf)];
        self.root = try std.fmt.allocPrint(testing.allocator, "{s}/root", .{base});
        errdefer testing.allocator.free(self.root);
        self.home = try std.fmt.allocPrint(testing.allocator, "{s}/home", .{base});
        errdefer testing.allocator.free(self.home);
        self.stub = try stub_mod.Stub.start(replies);
        errdefer self.stub.stop();
        self.client = client_mod.Client.init(testing.allocator, io, self.stub.url(&self.url));
        return self;
    }

    fn destroy(self: *Rig) void {
        self.stub.stop();
        testing.allocator.free(self.root);
        testing.allocator.free(self.home);
        self.tmp.cleanup();
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn run(self: *Rig) check.Run {
        return .{ .id = "run1", .prompt = "Add retry logic", .scope = .{ .root = self.root, .home = self.home, .default_branch = "main" } };
    }

    fn count(self: *Rig, sql: [:0]const u8) !i64 {
        return self.fx.app.withLock(sql, countLocked);
    }

    /// The first approval row's column, or null when there is none.
    fn firstApproval(self: *Rig, a: std.mem.Allocator, column: []const u8) !?[]const u8 {
        return self.fx.app.withLock(ColumnArgs{ .a = a, .column = column }, columnLocked);
    }

    /// A human deciding: the connection is shared with the waiting thread, so under the lock.
    fn decide(self: *Rig, id: []const u8, decision: approvals.Decision) !bool {
        return self.fx.app.withLock(DecideArgs{ .id = id, .decision = decision, .now = ids.nowMs(io) }, decideLocked);
    }
};

fn dbOf(state: *State) !sqlite.Db {
    return .{ .handle = state.db orelse return error.NoDatabase };
}

fn countLocked(sql: [:0]const u8, state: *State) !i64 {
    const stmt = try (try dbOf(state)).prepare(sql);
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

const ColumnArgs = struct { a: std.mem.Allocator, column: []const u8 };

fn columnLocked(args: ColumnArgs, state: *State) !?[]const u8 {
    const sql = try std.fmt.allocPrint(args.a, "SELECT {s} FROM approvals LIMIT 1", .{args.column});
    const stmt = try (try dbOf(state)).prepare(sql);
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    return try stmt.textAlloc(args.a, 0);
}

const DecideArgs = struct { id: []const u8, decision: approvals.Decision, now: i64 };

fn decideLocked(args: DecideArgs, state: *State) !bool {
    return approvals.decide(try dbOf(state), args.id, args.decision, "user:test", args.now);
}

/// One `checkAction` running on its own thread, so the test can play the human.
const Job = struct {
    arena: std.heap.ArenaAllocator,
    rig: *Rig,
    ask: types.Ask,
    opts: check.Options,
    out: ?check.Error!check.Outcome = null,
    group: std.Io.Group = .init,

    fn start(rig: *Rig, ask: types.Ask, opts: check.Options) !*Job {
        const job = try testing.allocator.create(Job);
        job.* = .{ .arena = .init(testing.allocator), .rig = rig, .ask = ask, .opts = opts };
        try job.group.concurrent(io, work, .{job});
        return job;
    }

    fn work(job: *Job) void {
        job.out = check.checkAction(job.arena.allocator(), &job.rig.fx.app, &job.rig.client, job.rig.run(), job.ask, job.opts);
    }

    fn finish(job: *Job) check.Error!check.Outcome {
        job.group.await(io) catch {};
        return job.out.?;
    }

    fn destroy(job: *Job) void {
        job.arena.deinit();
        testing.allocator.destroy(job);
    }
};

/// Waits until the approval row exists, then decides it as a human would.
fn decideWhenPending(rig: *Rig, decision: approvals.Decision) !void {
    for (0..200) |_| {
        const pending = try rig.count("SELECT count(*) FROM approvals WHERE status = 'pending'");
        if (pending == 1) break;
        try io.sleep(.fromMilliseconds(25), .awake);
    } else return error.NoApprovalAppeared;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const id = (try rig.firstApproval(arena.allocator(), "id")).?;
    try testing.expect(try rig.decide(id, decision));
}

fn expireRunLocked(run_id: []const u8, state: *State) !void {
    _ = try approvals.expireRun(try dbOf(state), run_id);
}

const mystery: types.Ask = .{ .kind = .other, .tool_name = "Mystery" };
const test_command: types.Ask = .{ .kind = .execute, .command = "bun test src/webhook.test.ts" };

test "guard check: an L1 deny is logged and reaches neither Laya nor a human" {
    const rig = try Rig.create(&.{.{ .body = benign }});
    defer rig.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const out = try check.checkAction(arena.allocator(), &rig.fx.app, &rig.client, rig.run(), .{ .kind = .execute, .command = "rm -rf /" }, .{});
    try testing.expectEqual(types.Verdict.deny, out.verdict);
    try testing.expectEqual(check.Layer.L1, out.layer);
    try testing.expect(out.approval_id == null);
    try testing.expectEqual(@as(u32, 0), rig.stub.hits.load(.monotonic));
    try testing.expectEqual(@as(i64, 0), try rig.count("SELECT count(*) FROM approvals"));
    try testing.expectEqual(@as(i64, 1), try rig.count("SELECT count(*) FROM events WHERE kind = 'guard' AND guard_layer = 'L1' AND guard_verdict = 'deny' AND run_id = 'run1'"));
}

test "guard check: an L1 allow of a read stays with L1" {
    const rig = try Rig.create(&.{.{ .body = benign }});
    defer rig.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try std.fmt.allocPrint(a, "{s}/a.txt", .{rig.root});
    const out = try check.checkAction(a, &rig.fx.app, &rig.client, rig.run(), .{ .kind = .read, .paths = &.{path} }, .{});
    try testing.expectEqual(types.Verdict.allow, out.verdict);
    try testing.expectEqual(check.Layer.L1, out.layer);
    try testing.expectEqual(@as(u32, 0), rig.stub.hits.load(.monotonic));
}

test "guard check: a command L1 allows goes to Laya, and a calm answer lets it run" {
    const rig = try Rig.create(&.{.{ .body = benign }});
    defer rig.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const out = try check.checkAction(arena.allocator(), &rig.fx.app, &rig.client, rig.run(), test_command, .{});
    try testing.expectEqual(types.Verdict.allow, out.verdict);
    try testing.expectEqual(check.Layer.L2, out.layer);
    try testing.expectEqual(@as(u32, 1), rig.stub.hits.load(.monotonic));
    try testing.expectEqual(@as(i64, 2), try rig.count("SELECT count(*) FROM events WHERE kind = 'guard' AND run_id = 'run1'"));
    try testing.expectEqual(@as(i64, 0), try rig.count("SELECT count(*) FROM approvals"));
}

test "guard check: an L2 ask opens an approval with the L2 verdict and waits for approve" {
    const rig = try Rig.create(&.{.{ .body = destructive }});
    defer rig.destroy();
    const job = try Job.start(rig, test_command, .{});
    defer job.destroy();
    try decideWhenPending(rig, .approve);
    const out = try job.finish();
    try testing.expectEqual(types.Verdict.allow, out.verdict);
    try testing.expectEqual(check.Layer.L3, out.layer);
    try testing.expectEqualStrings("approved", out.reason);
    try testing.expect(out.approval_id != null);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const l2 = (try rig.firstApproval(arena.allocator(), "l2")).?;
    try testing.expect(std.mem.find(u8, l2, "\"source\":\"laya\"") != null);
    try testing.expectEqual(@as(i64, 3), try rig.count("SELECT count(*) FROM events WHERE kind = 'guard' AND run_id = 'run1'"));
    try testing.expectEqual(@as(i64, 1), try rig.count("SELECT count(*) FROM events WHERE guard_layer = 'L3' AND guard_verdict = 'allow'"));
}

test "guard check: a denial is a deny" {
    const rig = try Rig.create(&.{});
    defer rig.destroy();
    const job = try Job.start(rig, mystery, .{});
    defer job.destroy();
    try decideWhenPending(rig, .deny);
    const out = try job.finish();
    try testing.expectEqual(types.Verdict.deny, out.verdict);
    try testing.expectEqualStrings("denied", out.reason);
    try testing.expectEqualStrings("other.any", out.rule.?);
    try testing.expectEqual(@as(i64, 1), try rig.count("SELECT count(*) FROM events WHERE guard_layer = 'L3' AND guard_verdict = 'deny' AND guard_rule = 'other.any'"));
}

test "guard check: no decision before the expiry is a deny and the row expires" {
    const rig = try Rig.create(&.{});
    defer rig.destroy();
    const job = try Job.start(rig, mystery, .{ .approval_timeout_ms = 150 });
    defer job.destroy();
    const out = try job.finish();
    try testing.expectEqual(types.Verdict.deny, out.verdict);
    try testing.expectEqualStrings("approval_timeout", out.reason);
    try testing.expectEqual(@as(i64, 1), try rig.count("SELECT count(*) FROM approvals WHERE status = 'expired'"));
}

test "guard check: a canceled wait leaves the row pending and the caller gets Canceled" {
    const rig = try Rig.create(&.{});
    defer rig.destroy();
    const job = try Job.start(rig, mystery, .{});
    defer job.destroy();
    for (0..200) |_| {
        if (try rig.count("SELECT count(*) FROM approvals") == 1) break;
        try io.sleep(.fromMilliseconds(25), .awake);
    }
    job.group.cancel(io);
    try testing.expectError(error.Canceled, job.out.?);
    try testing.expectEqual(@as(i64, 1), try rig.count("SELECT count(*) FROM approvals WHERE status = 'pending'"));
    // The run ending expires it, as `Links.expire_approvals` does.
    try rig.fx.app.withLock(@as([]const u8, "run1"), expireRunLocked);
    try testing.expectEqual(@as(i64, 1), try rig.count("SELECT count(*) FROM approvals WHERE status = 'expired'"));
}

test "guard check: secrets are removed from the stored command, title and paths" {
    const rig = try Rig.create(&.{});
    defer rig.destroy();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
    const job = try Job.start(rig, .{
        .kind = .other,
        .command = "deploy --token=" ++ secret,
        .paths = &.{"/tmp/" ++ secret},
        .tool_name = "Mystery",
        .title = "use " ++ secret,
    }, .{ .approval_timeout_ms = 150 });
    defer job.destroy();
    _ = try job.finish();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const stored = (try rig.firstApproval(arena.allocator(), "action")).?;
    try testing.expect(std.mem.find(u8, stored, "abcdefghijklmnop") == null);
    try testing.expect(std.mem.find(u8, stored, "[REDACTED") != null);
    try testing.expect(std.mem.startsWith(u8, stored, "{\"kind\":\"other\",\"command\":"));
    try testing.expectEqual(@as(i64, 0), try rig.count("SELECT count(*) FROM events WHERE command LIKE '%abcdefghijklmnop%'"));
}

test "guard check: bytes that are not UTF-8 are stored as text, never as an array of numbers" {
    const rig = try Rig.create(&.{});
    defer rig.destroy();
    const job = try Job.start(rig, .{
        .kind = .other,
        .command = "run \xff\xfe now",
        .paths = &.{"/tmp/\xc3"},
        .tool_name = "Mystery",
        .title = "t\x80",
    }, .{ .approval_timeout_ms = 100 });
    defer job.destroy();
    _ = try job.finish();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const stored = (try rig.firstApproval(a, "action")).?;
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, a, stored, .{});
    try testing.expectEqualStrings("run \u{fffd}\u{fffd} now", parsed.object.get("command").?.string);
    try testing.expectEqualStrings("/tmp/\u{fffd}", parsed.object.get("paths").?.array.items[0].string);
    try testing.expectEqualStrings("t\u{fffd}", parsed.object.get("title").?.string);
}

const Pending = struct {
    var seen: [36]u8 = undefined;
    var count: usize = 0;
    fn on(_: ?*anyopaque, id: []const u8) void {
        @memcpy(&seen, id);
        count += 1;
    }
};

test "guard check: the pending callback gets the id of the approval row" {
    const rig = try Rig.create(&.{});
    defer rig.destroy();
    Pending.count = 0;
    const job = try Job.start(rig, mystery, .{ .approval_timeout_ms = 100, .on_pending = Pending.on });
    defer job.destroy();
    const out = try job.finish();
    try testing.expectEqual(@as(usize, 1), Pending.count);
    try testing.expectEqualStrings(out.approval_id.?, &Pending.seen);
}
