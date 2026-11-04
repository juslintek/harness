//! Run lifecycle tests against the fake agent: the module-level counterpart of the conformance
//! scenario C1-run-fake-say, which needs the session routes of Z3. They run a real migrated
//! database behind App.withLock and a real bun child per run.
const std = @import("std");
const app_mod = @import("../app.zig");
const sqlite = @import("../db/sqlite.zig");
const migrate = @import("../db/migrate.zig");
const manager = @import("manager.zig");
const types = @import("types.zig");
const kit = @import("testkit.zig");
const process = @import("process.zig");
const launch = @import("launch.zig");

const Io = std.Io;
const testing = std.testing;

const Collector = struct {
    mutex: Io.Mutex = .init,
    io: Io,
    gpa: std.mem.Allocator,
    run_bodies: std.ArrayList([]u8) = .empty,
    messages: usize = 0,
    usage_records: usize = 0,
    conversation: ?[]u8 = null,
    verdict: types.Verdict = .deny,
    asked: usize = 0,
    expired: usize = 0,
    released: usize = 0,
    fail_usage: bool = false,
    /// Set when the usage callback is entered; it then waits for `usage_gate`.
    usage_entered: Io.Event = .unset,
    usage_gate: ?*Io.Event = null,
    errors: usize = 0,
    last_error: [128]u8 = undefined,
    last_error_len: usize = 0,

    fn deinit(c: *Collector) void {
        for (c.run_bodies.items) |b| c.gpa.free(b);
        c.run_bodies.deinit(c.gpa);
        if (c.conversation) |s| c.gpa.free(s);
    }

    fn links(c: *Collector) manager.Links {
        return .{
            .ctx = c,
            .on_event = onEvent,
            .decide = decide,
            .record_usage = recordUsage,
            .expire_approvals = expire,
            .release_run = release,
            .report_error = report,
        };
    }

    fn from(ctx: ?*anyopaque) *Collector {
        return @ptrCast(@alignCast(ctx.?));
    }

    fn onEvent(ctx: ?*anyopaque, event: types.NewEvent) void {
        const c = from(ctx);
        c.mutex.lockUncancelable(c.io);
        defer c.mutex.unlock(c.io);
        if (event.kind == .message) c.messages += 1;
        if (event.kind != .run) return;
        const copy = c.gpa.dupe(u8, event.body orelse "") catch return;
        c.run_bodies.append(c.gpa, copy) catch c.gpa.free(copy);
    }

    fn decide(ctx: ?*anyopaque, _: []const u8, _: types.Ask) anyerror!types.Verdict {
        const c = from(ctx);
        c.mutex.lockUncancelable(c.io);
        defer c.mutex.unlock(c.io);
        c.asked += 1;
        return c.verdict;
    }

    fn recordUsage(ctx: ?*anyopaque, _: sqlite.Db, _: []const u8, _: []const u8, conversation_id: ?[]const u8, usage: []const types.UsageRecord) anyerror!void {
        const c = from(ctx);
        if (c.fail_usage) return error.UsageDown;
        if (c.usage_gate) |gate| {
            c.usage_entered.set(c.io);
            gate.waitUncancelable(c.io);
        }
        c.usage_records += usage.len;
        if (conversation_id) |id| {
            const copy = try c.gpa.dupe(u8, id);
            if (c.conversation) |old| c.gpa.free(old);
            c.conversation = copy;
        }
    }

    fn expire(ctx: ?*anyopaque, _: sqlite.Db, _: []const u8) void {
        const c = from(ctx);
        c.expired += 1;
    }

    fn report(ctx: ?*anyopaque, message: []const u8) void {
        const c = from(ctx);
        c.mutex.lockUncancelable(c.io);
        defer c.mutex.unlock(c.io);
        c.errors += 1;
        c.last_error_len = @min(message.len, c.last_error.len);
        @memcpy(c.last_error[0..c.last_error_len], message[0..c.last_error_len]);
    }

    fn release(ctx: ?*anyopaque, _: sqlite.Db, _: []const u8) void {
        const c = from(ctx);
        c.released += 1;
    }

    fn runBodiesOf(c: *Collector, gpa: std.mem.Allocator) ![]u8 {
        c.mutex.lockUncancelable(c.io);
        defer c.mutex.unlock(c.io);
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        for (c.run_bodies.items) |body| {
            try out.appendSlice(gpa, body);
            try out.append(gpa, '|');
        }
        return out.toOwnedSlice(gpa);
    }
};

const Harness = struct {
    app: app_mod.App,
    db: sqlite.Db,
    collector: Collector,
    parent: std.process.Environ.Map,
    mgr: manager.Manager,
    fake: *kit.Fake,
    extra: [2]launch.Extra,

    fn setDb(handle: @FieldType(app_mod.State, "db"), state: *app_mod.State) void {
        state.db = handle;
    }

    fn init(script_json: []const u8) !*Harness {
        return initWith(script_json, testing.allocator);
    }

    /// `app_gpa` serves the App and so the manager; everything else uses the testing allocator.
    fn initWith(script_json: []const u8, app_gpa: std.mem.Allocator) !*Harness {
        const gpa = testing.allocator;
        const h = try gpa.create(Harness);
        errdefer gpa.destroy(h);
        h.app = app_mod.App.init(app_gpa, testing.io);
        h.db = try sqlite.Db.open(gpa, ":memory:");
        errdefer h.db.close();
        _ = try migrate.run(h.db, &migrate.embedded);
        h.app.withLock(h.db.handle, setDb);
        h.collector = .{ .io = testing.io, .gpa = gpa };
        errdefer h.collector.deinit();
        h.parent = std.process.Environ.Map.init(gpa);
        errdefer h.parent.deinit();
        try h.parent.put("PATH", kit.testPath());
        try h.parent.put("ANTHROPIC_API_KEY", "must-not-reach-the-agent");
        h.mgr = manager.Manager.init(&h.app, h.collector.links(), &h.parent);
        errdefer h.mgr.deinit();
        h.fake = try kit.Fake.init(gpa, testing.io, script_json);
        h.extra = .{
            .{ .key = "FAKE_AGENT_SCRIPT", .value = h.fake.env.get("FAKE_AGENT_SCRIPT").? },
            .{ .key = "FAKE_AGENT_PIDFILE", .value = h.fake.pid_file },
        };
        return h;
    }

    fn deinit(h: *Harness) void {
        h.fake.deinit();
        h.mgr.deinit();
        h.parent.deinit();
        h.collector.deinit();
        h.db.close();
        testing.allocator.destroy(h);
    }

    fn input(h: *Harness) manager.StartInput {
        return .{
            .spec = .{
                .id = "fake",
                .argv = &h.fake.argv,
                .mode_option = .{ .config_id = "mode", .value = "default" },
            },
            .repo = h.fake.dir,
            .prompt = "say hello",
            .extra_env = &h.extra,
        };
    }

    const Fetch = struct { id: []const u8, a: std.mem.Allocator };

    fn fetchLocked(ctx: Fetch, state: *app_mod.State) !?manager.RunRow {
        return manager.getRun(.{ .handle = state.db.? }, ctx.a, ctx.id);
    }

    fn row(h: *Harness, a: std.mem.Allocator, id: []const u8) !manager.RunRow {
        return (try h.app.withLock(Fetch{ .id = id, .a = a }, fetchLocked)).?;
    }

    fn countLocked(sql: [:0]const u8, state: *app_mod.State) !i64 {
        const stmt = try (sqlite.Db{ .handle = state.db.? }).prepare(sql);
        defer stmt.finalize();
        _ = try stmt.step();
        return stmt.int(0);
    }

    fn count(h: *Harness, sql: [:0]const u8) !i64 {
        return h.app.withLock(sql, countLocked);
    }

    const Queued = struct { id: []const u8 };

    fn queuedLocked(ctx: Queued, state: *app_mod.State) !void {
        try manager.insertRun(.{ .handle = state.db.? }, .{ .id = ctx.id, .agent_id = "fake", .repo = "/r", .prompt = "p" }, 1);
    }

    /// A run row that no lane owns, for finalize tests.
    fn insertQueued(h: *Harness, id: []const u8) !void {
        try h.app.withLock(Queued{ .id = id }, queuedLocked);
    }

    fn pidsLocked(a: std.mem.Allocator, state: *app_mod.State) ![]std.posix.pid_t {
        const stmt = try (sqlite.Db{ .handle = state.db.? }).prepare("SELECT pid FROM runs WHERE pid IS NOT NULL");
        defer stmt.finalize();
        var list: std.ArrayList(std.posix.pid_t) = .empty;
        errdefer list.deinit(a);
        while (try stmt.step()) try list.append(a, std.math.cast(std.posix.pid_t, stmt.int(0)) orelse continue);
        return list.toOwnedSlice(a);
    }

    fn pids(h: *Harness, a: std.mem.Allocator) ![]std.posix.pid_t {
        return h.app.withLock(a, pidsLocked);
    }

    const Begin = struct { id: []const u8 };

    fn beginLocked(ctx: Begin, state: *app_mod.State) !void {
        const db = sqlite.Db{ .handle = state.db.? };
        _ = try manager.setStarting(db, ctx.id, null, null);
        _ = try manager.markRunning(db, ctx.id, 5);
    }

    /// The starting and running transitions a lane start performs, on a run someone else owns.
    fn begin(h: *Harness, id: []const u8) !void {
        try h.app.withLock(Begin{ .id = id }, beginLocked);
    }

    fn waitForMessage(h: *Harness) !void {
        for (0..1000) |_| {
            if (h.collector.messages > 0) return;
            try testing.io.sleep(.fromMilliseconds(10), .awake);
        }
        return error.NoMessage;
    }
};

fn expectAgentGone(h: *Harness) !void {
    const pid = try h.fake.agentPid(testing.io);
    try testing.expect(!process.pidExists(pid));
    try testing.expect(!process.groupExists(pid));
}

test "manager: a run completes, its row, events and usage persist and the agent is gone" {
    const h = try Harness.init(
        \\[{"say":"hello from the fake agent"},{"usage":{"inputTokens":3,"outputTokens":5}}]
    );
    defer h.deinit();
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.completed, row.state);
    try testing.expect(row.reason == null);
    try testing.expect(row.started_at != null and row.ended_at != null);
    try testing.expect(row.ended_at.? >= row.started_at.?);
    try testing.expectEqualStrings("fake", row.agent_id);
    try testing.expectEqualStrings("say hello", row.prompt);

    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'message' AND agent = 'fake'"));
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM runs WHERE pid IS NOT NULL"));
    try testing.expectEqual(@as(usize, 1), h.collector.usage_records);
    try testing.expectEqualStrings("fake-session", h.collector.conversation.?);
    try testing.expectEqual(@as(usize, 1), h.collector.released);
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    const bodies = try h.collector.runBodiesOf(testing.allocator);
    defer testing.allocator.free(bodies);
    try testing.expectEqualStrings("completed|", bodies);
    try expectAgentGone(h);
}

test "manager: the agent runs with a scrubbed environment" {
    const h = try Harness.init(
        \\[{"writeFile":"/nonexistent-dir/x"}]
    );
    defer h.deinit();
    _ = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    // The fake agent has no way to print its environment; the unit test in launch.zig covers the
    // scrub, and this run proves the minimal environment is enough to start an agent.
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM runs WHERE state = 'completed'"));
}

test "manager: a crash fails the run with the agent's stderr" {
    const h = try Harness.init("[{\"crash\":true}]");
    defer h.deinit();
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.failed, row.state);
    try testing.expect(std.mem.find(u8, row.reason.?, "fake agent crashing") != null);
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'error'"));
    try expectAgentGone(h);
}

test "manager: killRun ends a hung run as killed and leaves no process" {
    const h = try Harness.init("[{\"say\":\"working\"},{\"hang\":true}]");
    defer h.deinit();
    const id = try h.mgr.startRun(h.input());
    try h.waitForMessage();
    try testing.expect(try h.mgr.killRun(&id, "killed_by_user"));
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.killed, row.state);
    try testing.expectEqualStrings("killed_by_user", row.reason.?);
    try testing.expect(h.collector.expired >= 1);
    try testing.expect(!(try h.mgr.killRun(&id, "again")));
    try expectAgentGone(h);
}

test "manager: an idle agent fails the run with the timeout" {
    const h = try Harness.init("[{\"hang\":true}]");
    defer h.deinit();
    h.mgr.idle_timeout_ms = 200;
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.failed, row.state);
    try testing.expectEqualStrings("no update for 200 ms", row.reason.?);
    try expectAgentGone(h);
}

test "manager: shutdown ends a hung run as killed with the shutdown reason" {
    const h = try Harness.init("[{\"say\":\"working\"},{\"hang\":true}]");
    defer h.deinit();
    const id = try h.mgr.startRun(h.input());
    try h.waitForMessage();
    try h.mgr.shutdown(2000);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.killed, row.state);
    try testing.expectEqualStrings("harness_shutdown", row.reason.?);
    try testing.expectError(error.ShuttingDown, h.mgr.startRun(h.input()));
    try h.mgr.waitIdle();
    try expectAgentGone(h);
    // Both the shutdown and the lane tried to end the run; only one run event exists.
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
}

test "manager: a halted harness starts no agent" {
    const h = try Harness.init("[{\"say\":\"never\"}]");
    defer h.deinit();
    try h.mgr.setHalted(true);
    const id = try h.mgr.startRun(h.input());
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.killed, row.state);
    try testing.expectEqualStrings("halted", row.reason.?);
    try testing.expect(row.started_at == null);
    try testing.expect(try h.mgr.isHalted());
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
}

test "manager: a missing agent binary fails the run and frees everything" {
    const h = try Harness.init("[]");
    defer h.deinit();
    var input = h.input();
    input.spec.argv = &.{"/nonexistent/agent-binary"};
    const id = try h.mgr.startRun(input);
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.failed, row.state);
    try testing.expectEqualStrings("FileNotFound", row.reason.?);
}

test "manager: finalize is idempotent and the first end wins" {
    const h = try Harness.init("[]");
    defer h.deinit();
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    try h.mgr.finalize(&id, "fake", .killed, "late");
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.completed, row.state);
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
}

test "manager: a denied permission is asked of the guard and the run still ends" {
    const h = try Harness.init("[{\"ask\":{\"command\":\"rm -rf x\"}}]");
    defer h.deinit();
    h.collector.verdict = .deny;
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    try testing.expectEqual(@as(usize, 1), h.collector.asked);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.completed, row.state);
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'permission' AND command = 'rm -rf x'"));
}

test "manager: concurrent runs all end with consistent rows" {
    const h = try Harness.init("[{\"say\":\"x\"}]");
    defer h.deinit();
    const input = h.input();
    const runs = 6;
    var ids: [runs][36]u8 = undefined;
    for (&ids) |*slot| slot.* = try h.mgr.startRun(input);
    try h.mgr.waitIdle();
    try testing.expectEqual(@as(i64, runs), try h.count("SELECT count(*) FROM runs WHERE state = 'completed' AND ended_at IS NOT NULL"));
    try testing.expectEqual(@as(i64, runs), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
    try testing.expectEqual(@as(i64, runs), try h.count("SELECT count(*) FROM events WHERE kind = 'message'"));
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    try testing.expectEqual(@as(usize, runs), h.collector.released);
}

test "manager: the end state follows outcome.ts" {
    var outcome: types.Outcome = .{
        .arena = .init(testing.allocator),
        .stop_reason = .end_turn,
        .text = "",
        .usage = &.{},
        .error_text = null,
        .session_id = null,
    };
    defer outcome.deinit();
    const End = manager.End;
    const RunState = manager.RunState;
    try testing.expectEqual(End{ .state = .completed, .reason = null }, manager.endState(null, false, false, false, &outcome));
    try testing.expectEqualStrings("killed_by_user", manager.endState("killed_by_user", true, true, false, &outcome).reason.?);
    try testing.expectEqual(RunState.blocked, manager.endState(null, true, false, false, &outcome).state);
    outcome.stop_reason = .cancelled;
    try testing.expectEqual(RunState.cancelled, manager.endState(null, false, false, false, &outcome).state);
    try testing.expectEqualStrings("guard_denied", manager.endState(null, false, true, false, &outcome).reason.?);
    outcome.stop_reason = .refusal;
    try testing.expectEqualStrings("refusal", manager.endState(null, false, false, false, &outcome).reason.?);
    outcome.stop_reason = .@"error";
    outcome.error_text = "boom";
    try testing.expectEqualStrings("boom", manager.endState(null, false, false, false, &outcome).reason.?);
    try testing.expectEqualStrings("rate_limited", manager.endState(null, false, false, true, &outcome).reason.?);
    outcome.error_text = "HTTP 429 from provider";
    try testing.expectEqualStrings("rate_limited", manager.endState(null, false, false, false, &outcome).reason.?);
    outcome.stop_reason = .timeout;
    outcome.error_text = null;
    try testing.expectEqualStrings("timeout", manager.endState(null, false, false, false, &outcome).reason.?);
}

test "manager: the rate limit text matcher agrees with the TS regex" {
    for ([_][]const u8{ "Rate limit hit", "rate-limit", "ratelimit", "hit RATE_LIMIT", "error 429", "(429)", "quota exceeded", "Usage Limit reached", "API overloaded" }) |text| {
        try testing.expect(manager.looksRateLimited(text));
    }
    for ([_][]const u8{ "", "boom", "code 4290", "x429", "429x", "rate  limit", "rating limited" }) |text| {
        try testing.expect(!manager.looksRateLimited(text));
    }
}

const FinalizeRace = struct {
    h: *Harness,
    id: []const u8,
    state: manager.RunState,

    fn run(r: FinalizeRace) void {
        r.h.mgr.finalize(r.id, "fake", r.state, "r") catch |err| std.debug.panic("finalize failed: {t}", .{err});
    }
};

test "manager: two threads finalizing the same run publish and release exactly once" {
    const h = try Harness.init("[]");
    defer h.deinit();
    const rounds = 40;
    for (0..rounds) |i| {
        var id_buffer: [16]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_buffer, "race-{d}", .{i});
        try h.insertQueued(id);
        const a = try std.Thread.spawn(.{}, FinalizeRace.run, .{FinalizeRace{ .h = h, .id = id, .state = .killed }});
        const b = try std.Thread.spawn(.{}, FinalizeRace.run, .{FinalizeRace{ .h = h, .id = id, .state = .failed }});
        a.join();
        b.join();
    }
    try testing.expectEqual(@as(i64, rounds), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
    try testing.expectEqual(@as(usize, rounds), h.collector.released);
    try testing.expectEqual(@as(i64, rounds), try h.count("SELECT count(*) FROM runs WHERE ended_at IS NOT NULL"));
}

const StartRace = struct {
    h: *Harness,

    fn run(r: StartRace) void {
        _ = r.h.mgr.startRun(r.h.input()) catch |err| switch (err) {
            error.ShuttingDown => return,
            else => std.debug.panic("startRun failed: {t}", .{err}),
        };
    }
};

test "manager: startRun calls racing shutdown leave no live process and no running row" {
    const h = try Harness.init("[{\"hang\":true}]");
    defer h.deinit();
    var threads: [8]std.Thread = undefined;
    for (&threads, 0..) |*thread, i| {
        thread.* = try std.Thread.spawn(.{}, StartRace.run, .{StartRace{ .h = h }});
        if (i == 3) try testing.io.sleep(.fromMilliseconds(40), .awake);
    }
    try h.mgr.shutdown(2000);
    for (threads) |thread| thread.join();
    try h.mgr.waitIdle();
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    try testing.expectEqual(@as(i64, 0), try h.count("SELECT count(*) FROM runs WHERE ended_at IS NULL"));
    try testing.expectEqual(@as(i64, 0), try h.count("SELECT count(*) FROM runs WHERE state IN ('queued', 'starting', 'running')"));
    const pids = try h.pids(testing.allocator);
    defer testing.allocator.free(pids);
    for (pids) |pid| try testing.expect(!process.groupExists(pid));
}

test "manager: one failed end write is retried and the run still ends" {
    const h = try Harness.init("[]");
    defer h.deinit();
    h.mgr.inject_end_failures.store(1, .release);
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.completed, row.state);
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
}

test "manager: an end write that always fails keeps the run registered until shutdown ends it" {
    const h = try Harness.init("[{\"say\":\"x\"}]");
    defer h.deinit();
    h.mgr.inject_end_failures.store(1_000_000, .release);
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqual(manager.RunState.running, (try h.row(arena.allocator(), &id)).state);
    try testing.expectEqual(@as(usize, 1), h.collector.errors);
    try testing.expect(std.mem.find(u8, h.collector.last_error[0..h.collector.last_error_len], "finalize_failed") != null);
    try testing.expectEqual(@as(usize, 1), h.mgr.liveCount());
    h.mgr.inject_end_failures.store(0, .release);
    try h.mgr.shutdown(200);
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.completed, row.state);
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
}

test "manager: a failing usage record fails the run like TS does" {
    const h = try Harness.init("[{\"usage\":{\"inputTokens\":1,\"outputTokens\":1}}]");
    defer h.deinit();
    h.collector.fail_usage = true;
    const id = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.failed, row.state);
    try testing.expectEqualStrings("UsageDown", row.reason.?);
    try testing.expectEqual(@as(usize, 1), h.collector.errors);
}

test "manager: a 2000 byte reason reaches the run event whole" {
    const h = try Harness.init("[]");
    defer h.deinit();
    try h.insertQueued("long");
    const reason: [2000]u8 = @splat('r');
    try h.mgr.finalize("long", "fake", .failed, &reason);
    const bodies = try h.collector.runBodiesOf(testing.allocator);
    defer testing.allocator.free(bodies);
    try testing.expectEqual(@as(usize, "failed: ".len + 2000 + 1), bodies.len);
    try testing.expect(std.mem.startsWith(u8, bodies, "failed: rrrr"));
}

test "manager: a run that shutdown already ended is not moved back to running" {
    const h = try Harness.init("[]");
    defer h.deinit();
    try h.insertQueued("late");
    try h.mgr.finalize("late", "fake", .killed, "harness_shutdown");
    try h.begin("late");
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), "late");
    try testing.expectEqual(manager.RunState.killed, row.state);
    try testing.expect(row.started_at == null);
    try testing.expectEqualStrings("harness_shutdown", row.reason.?);
}

test "manager: an event append that fails rolls the end back so the retry publishes it" {
    const h = try Harness.init("[]");
    defer h.deinit();
    try h.insertQueued("ev");
    h.mgr.inject_append_failures.store(1, .release);
    try testing.expectError(error.Busy, h.mgr.finalize("ev", "fake", .failed, "x"));
    try testing.expectEqual(@as(i64, 0), try h.count("SELECT count(*) FROM runs WHERE ended_at IS NOT NULL"));
    try h.mgr.finalize("ev", "fake", .failed, "x");
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events WHERE kind = 'run'"));
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM runs WHERE ended_at IS NOT NULL"));
    try testing.expectEqual(@as(usize, 1), h.collector.released);
}

test "manager: a failing approval check is retried and then fails the run closed" {
    const once = try Harness.init("[{\"say\":\"x\"}]");
    defer once.deinit();
    once.mgr.inject_expired_failures.store(1, .release);
    const id = try once.mgr.startRun(once.input());
    try once.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqual(manager.RunState.completed, (try once.row(arena.allocator(), &id)).state);

    const always = try Harness.init("[{\"say\":\"x\"}]");
    defer always.deinit();
    always.mgr.inject_expired_failures.store(1_000_000, .release);
    const id2 = try always.mgr.startRun(always.input());
    try always.mgr.waitIdle();
    const row = try always.row(arena.allocator(), &id2);
    try testing.expectEqual(manager.RunState.failed, row.state);
    try testing.expectEqualStrings("internal_error", row.reason.?);
    try testing.expect(always.collector.errors >= 1);
}

/// Fails exactly one allocation, the `fail_at`-th, and serves every other one.
const OnceFailing = struct {
    backing: std.mem.Allocator,
    fail_at: usize,
    seen: std.atomic.Value(usize) = .init(0),
    failed: std.atomic.Value(bool) = .init(false),

    fn allocator(self: *OnceFailing) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *OnceFailing = @ptrCast(@alignCast(ctx));
        if (self.seen.fetchAdd(1, .acq_rel) == self.fail_at) {
            self.failed.store(true, .release);
            return null;
        }
        return self.backing.rawAlloc(len, alignment, ra);
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *OnceFailing = @ptrCast(@alignCast(ctx));
        return self.backing.rawResize(memory, alignment, new_len, ra);
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *OnceFailing = @ptrCast(@alignCast(ctx));
        return self.backing.rawRemap(memory, alignment, new_len, ra);
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *OnceFailing = @ptrCast(@alignCast(ctx));
        self.backing.rawFree(memory, alignment, ra);
    }
};

test "manager: a failed admission ends the queued row at every allocation point" {
    // One allocation fails per iteration, among them the live-map insertion; whatever fails, no
    // row may stay without ended_at and no record may stay registered.
    var fail_at: usize = 0;
    while (fail_at < 48) : (fail_at += 1) {
        var once: OnceFailing = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
        const h = try Harness.initWith("[]", once.allocator());
        defer h.deinit();
        once.fail_at = once.seen.load(.acquire) + fail_at;
        if (h.mgr.startRun(h.input())) |_| {
            try h.mgr.waitIdle();
        } else |err| try testing.expectEqual(error.OutOfMemory, err);
        try testing.expectEqual(@as(i64, 0), try h.count("SELECT count(*) FROM runs WHERE ended_at IS NULL"));
        try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    }
}

const ShutdownThread = struct {
    h: *Harness,

    fn run(s: ShutdownThread) void {
        s.h.mgr.shutdown(50) catch |err| std.debug.panic("shutdown failed: {t}", .{err});
    }
};

test "manager: shutdown never frees a run record whose task has not returned" {
    const h = try Harness.init("[{\"say\":\"x\"}]");
    defer h.deinit();
    var reached: Io.Event = .unset;
    var gate: Io.Event = .unset;
    h.mgr.orphan_reached = &reached;
    h.mgr.orphan_gate = &gate;
    h.mgr.inject_end_failures.store(1_000_000, .release);
    const id = try h.mgr.startRun(h.input());
    try reached.wait(testing.io);
    // The task is flagged orphaned and parked before its own cleanup; shutdown ends the row.
    h.mgr.inject_end_failures.store(0, .release);
    try h.mgr.shutdown(50);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqual(manager.RunState.completed, (try h.row(arena.allocator(), &id)).state);
    // The owner now resumes and touches its record; it must still be there.
    gate.set(testing.io);
    try h.mgr.waitIdle();
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
}

test "manager: the process group is not signalled once the lane has reaped the agent" {
    const h = try Harness.init("[{\"say\":\"x\"}]");
    defer h.deinit();
    var gate: Io.Event = .unset;
    h.collector.usage_gate = &gate;
    // The usage callback runs after the lane returned and blocks while shutdown runs.
    _ = try h.mgr.startRun(h.input());
    try h.collector.usage_entered.wait(testing.io);
    const thread = try std.Thread.spawn(.{}, ShutdownThread.run, .{ShutdownThread{ .h = h }});
    while (!h.mgr.shutting_down.load(.acquire)) try testing.io.sleep(.fromMilliseconds(5), .awake);
    // liveCount takes the manager mutex, which shutdown holds for its whole first scan.
    _ = h.mgr.liveCount();
    try testing.expectEqual(@as(u32, 0), h.mgr.signal_count.load(.acquire));
    gate.set(testing.io);
    thread.join();
    try h.mgr.waitIdle();
    try testing.expectEqual(@as(u32, 0), h.mgr.signal_count.load(.acquire));
}

const ShutdownFlag = struct {
    h: *Harness,
    done: *std.atomic.Value(bool),

    fn run(s: ShutdownFlag) void {
        s.h.mgr.shutdown(100) catch |err| std.debug.panic("shutdown failed: {t}", .{err});
        s.done.store(true, .release);
    }
};

test "manager: shutdown waits for a starter that has not registered its run yet" {
    const h = try Harness.init("[{\"hang\":true}]");
    defer h.deinit();
    var reached: Io.Event = .unset;
    var gate: Io.Event = .unset;
    h.mgr.admission_reached = &reached;
    h.mgr.admission_gate = &gate;
    const starter = try std.Thread.spawn(.{}, StartRace.run, .{StartRace{ .h = h }});
    try reached.wait(testing.io);
    var done: std.atomic.Value(bool) = .init(false);
    const stopper = try std.Thread.spawn(.{}, ShutdownFlag.run, .{ShutdownFlag{ .h = h, .done = &done }});
    try testing.io.sleep(.fromMilliseconds(300), .awake);
    // The starter holds a persisted row it has not registered: shutdown must not be done yet.
    try testing.expect(!done.load(.acquire));
    gate.set(testing.io);
    starter.join();
    stopper.join();
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    try testing.expectEqual(@as(i64, 0), try h.count("SELECT count(*) FROM runs WHERE ended_at IS NULL"));
}

test "manager: event bodies are stored in pending_payloads like the TS repo does" {
    const h = try Harness.init("[{\"say\":\"hello from the fake agent\"}]");
    defer h.deinit();
    _ = try h.mgr.startRun(h.input());
    try h.mgr.waitIdle();
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM pending_payloads p JOIN events e ON e.rowid = p.event_rowid WHERE e.kind = 'message' AND p.body = 'hello from the fake agent'"));
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM pending_payloads p JOIN events e ON e.rowid = p.event_rowid WHERE e.kind = 'run' AND p.body = 'completed'"));
    try testing.expectEqual(@as(i64, 1), try h.count("SELECT count(*) FROM events_fts WHERE events_fts MATCH 'hello'"));
}

test "manager: a stored event body survives reopening the database" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realPathFileAlloc(testing.io, ".", testing.allocator);
    defer testing.allocator.free(dir);
    const path = try std.fs.path.joinZ(testing.allocator, &.{ dir, "h.db" });
    defer testing.allocator.free(path);
    {
        const db = try sqlite.Db.open(testing.allocator, path);
        defer db.close();
        _ = try migrate.run(db, &migrate.embedded);
        try manager.insertEventPlain(db, .{ .kind = .message, .run_id = "r", .body = "kept body", .command = "ls -la" }, "e1", 1);
    }
    const db = try sqlite.Db.open(testing.allocator, path);
    defer db.close();
    const stmt = try db.prepare("SELECT p.body FROM pending_payloads p JOIN events e ON e.rowid = p.event_rowid WHERE e.id = 'e1'");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqualStrings("kept body", (try stmt.text(0)).?);
}

test "manager: a failed termination keeps the run registered with its pgid until shutdown kills it" {
    const h = try Harness.init("[{\"say\":\"x\"}]");
    defer h.deinit();
    var input = h.input();
    input.inject_terminate_failures = 1;
    const id = try h.mgr.startRun(input);
    try h.mgr.waitIdle();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const row = try h.row(arena.allocator(), &id);
    try testing.expectEqual(manager.RunState.failed, row.state);
    try testing.expect(std.mem.find(u8, row.reason.?, "survived") != null);
    try testing.expectEqual(@as(usize, 1), h.mgr.liveCount());
    const agent = try h.fake.agentPid(testing.io);
    try testing.expect(process.pidExists(agent));
    try h.mgr.shutdown(200);
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    try testing.expect(!process.groupExists(agent));
}

test "manager: shutdown fails while an agent group survives, a later shutdown kills it" {
    const h = try Harness.init("[{\"say\":\"x\"}]");
    defer h.deinit();
    var input = h.input();
    // The lane's termination and both of shutdown's retries fail.
    input.inject_terminate_failures = 3;
    _ = try h.mgr.startRun(input);
    try h.mgr.waitIdle();
    try testing.expectError(error.AgentSurvived, h.mgr.shutdown(100));
    try testing.expectEqual(@as(usize, 1), h.mgr.liveCount());
    try testing.expectEqual(@as(usize, 1), h.mgr.survivors_after_shutdown);
    const pids = try h.pids(testing.allocator);
    defer testing.allocator.free(pids);
    try testing.expectEqual(@as(usize, 1), pids.len);
    // The injection is spent: the next shutdown ends the group and frees the record.
    try h.mgr.shutdown(100);
    try testing.expectEqual(@as(usize, 0), h.mgr.liveCount());
    try testing.expectEqual(@as(usize, 0), h.mgr.survivors_after_shutdown);
    try testing.expect(!process.groupExists(pids[0]));
}
