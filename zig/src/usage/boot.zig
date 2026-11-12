const std = @import("std");
const App = @import("../app.zig").App;
const tail = @import("tail.zig");

pub const Lifecycle = struct {
    gpa: std.mem.Allocator,
    sources: [2]tail.Source,
    tailer: tail.Tailer,
    task: std.Io.Future(void),

    pub fn start(gpa: std.mem.Allocator, io: std.Io, app: *App, env: *const std.process.Environ.Map, harness_home: []const u8) !*Lifecycle {
        return startInterval(gpa, io, app, env, harness_home, 60_000);
    }

    fn startInterval(gpa: std.mem.Allocator, io: std.Io, app: *App, env: *const std.process.Environ.Map, harness_home: []const u8, interval_ms: i64) !*Lifecycle {
        const user_home = env.get("HOME") orelse return error.NoHomeDir;
        const self = try gpa.create(Lifecycle);
        errdefer gpa.destroy(self);
        const claude_root = try std.fs.path.join(gpa, &.{ user_home, ".claude", "projects" });
        errdefer gpa.free(claude_root);
        const codex_root = try std.fs.path.join(gpa, &.{ user_home, ".codex", "sessions" });
        errdefer gpa.free(codex_root);
        const worktrees = try std.fs.path.join(gpa, &.{ harness_home, "worktrees" });
        errdefer gpa.free(worktrees);
        self.gpa = gpa;
        self.sources = .{
            .{ .name = .claude, .root = claude_root, .exclude_cwd_under = worktrees },
            .{ .name = .codex, .root = codex_root },
        };
        self.tailer = tail.Tailer.init(gpa, io, app, &self.sources, .{
            .backfill_days = tail.backfillDaysFromEnv(env.get("HARNESS_TAIL_BACKFILL_DAYS")),
        });
        self.task = try io.concurrent(tail.Tailer.run, .{ &self.tailer, interval_ms });
        return self;
    }

    pub fn stop(self: *Lifecycle) void {
        self.task.cancel(self.tailer.io);
        self.gpa.free(self.sources[0].exclude_cwd_under.?);
        for (self.sources) |source| self.gpa.free(source.root);
        self.gpa.destroy(self);
    }
};

const testing = std.testing;
const Fixture = @import("../auth/fixture.zig").Fixture;
const State = @import("../app.zig").State;
const sqlite = @import("../db/sqlite.zig");

fn usageCount(_: void, state: *State) !i64 {
    const stmt = try (sqlite.Db{ .handle = state.db.? }).prepare("SELECT count(*) FROM events WHERE kind='usage'");
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

const claude_line =
    \\{"type":"assistant","timestamp":"2026-11-02T01:00:00.000Z","message":{"id":"usage-boot","model":"model-a","usage":{"input_tokens":3,"output_tokens":10}}}
    \\
;
const codex_line =
    \\{"timestamp":"2026-11-02T01:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"output_tokens":9}}}}
    \\
;

test "usage boot: timer ingests fixture sources, excludes harness cwd and joins before database close" {
    const io = testing.io;
    const fx = try Fixture.create(testing.allocator, io);
    defer fx.destroy();
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path_len = try tmp.dir.realPath(io, &path_buf);
    const user_home = path_buf[0..path_len];
    const harness_home = try std.fs.path.join(testing.allocator, &.{ user_home, "harness" });
    defer testing.allocator.free(harness_home);
    try tmp.dir.createDirPath(io, ".claude/projects/project");
    try tmp.dir.createDirPath(io, ".codex/sessions/2026/11");
    const claude_path = ".claude/projects/project/11111111-2222-4333-8444-555555555555.jsonl";
    try tmp.dir.writeFile(io, .{ .sub_path = claude_path, .data = claude_line });
    try tmp.dir.writeFile(io, .{ .sub_path = ".codex/sessions/2026/11/rollout-2026-11-02T01-00-00-99999999-2222-4333-8444-555555555555.jsonl", .data = codex_line });
    const excluded = try std.fmt.allocPrint(testing.allocator, "{{\"cwd\":\"{s}/worktrees/run\"}}\n{s}", .{ harness_home, claude_line });
    defer testing.allocator.free(excluded);
    try tmp.dir.writeFile(io, .{ .sub_path = ".claude/projects/project/aaaaaaaa-2222-4333-8444-555555555555.jsonl", .data = excluded });
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("HOME", user_home);
    try env.put("HARNESS_TAIL_BACKFILL_DAYS", "1e9");
    {
        const production = try Lifecycle.start(testing.allocator, io, &fx.app, &env, harness_home);
        defer production.stop();
        try io.sleep(.fromMilliseconds(30), .awake);
    }
    try testing.expectEqual(@as(i64, 0), try fx.app.withLock({}, usageCount));
    const lifecycle = try Lifecycle.startInterval(testing.allocator, io, &fx.app, &env, harness_home, 20);
    var stopped = false;
    defer if (!stopped) lifecycle.stop();
    try testing.expectEqual(@as(f64, 1e9), lifecycle.tailer.options.backfill_days);
    try env.put("HOME", "/unrelated");
    try env.put("HARNESS_TAIL_BACKFILL_DAYS", "0");
    var waited: usize = 0;
    while (waited < 200 and try fx.app.withLock({}, usageCount) < 2) : (waited += 1)
        try io.sleep(.fromMilliseconds(10), .awake);
    lifecycle.stop();
    stopped = true;
    try testing.expectEqual(@as(i64, 2), try fx.app.withLock({}, usageCount));
    try tmp.dir.writeFile(io, .{ .sub_path = claude_path, .data = claude_line ++ "{\"type\":\"assistant\",\"timestamp\":\"2026-11-02T01:00:00.000Z\",\"message\":{\"id\":\"after-stop\",\"usage\":{\"input_tokens\":1}}}\n" });
    try io.sleep(.fromMilliseconds(60), .awake);
    try testing.expectEqual(@as(i64, 2), try fx.app.withLock({}, usageCount));
}

test "usage boot: missing HOME reports NoHomeDir even with an explicit harness home" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try testing.expectError(error.NoHomeDir, Lifecycle.start(testing.allocator, testing.io, &fx.app, &env, "/explicit/harness"));
}
