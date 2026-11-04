//! Usage records written by runs and the usage summary, port of `recordUsage` and `usageSummary` in
//! code/src/server/features/usage/api.ts. Every function takes the database handle and so runs
//! inside `App.withLock`.
const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const ids = @import("../ids.zig");
const manager = @import("../runtimes/manager.zig");
const types = @import("../runtimes/types.zig");

pub const By = enum {
    agent,
    model,
    run,

    fn column(by: By) [:0]const u8 {
        return switch (by) {
            .agent => "agent",
            .model => "gen_ai_request_model",
            .run => "run_id",
        };
    }
};

pub const SummaryRow = struct {
    key: []const u8,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    reported_cost_usd: ?f64,
    events: i64,
};

/// Rows are numbered from the count already stored for the run, so turns that arrive in separate
/// calls never collide on a dedupe key. `source` is what the usage came from (`acp`, `agy`, `api`).
pub fn recordUsage(
    io: std.Io,
    db: sqlite.Db,
    run_id: []const u8,
    agent: []const u8,
    conversation_id: ?[]const u8,
    source: []const u8,
    records: []const types.UsageRecord,
    now_ms: i64,
) !void {
    const count_stmt = try db.prepare("SELECT count(*) FROM events WHERE run_id = ? AND kind = 'usage' AND dedupe_key LIKE 'run:%'");
    defer count_stmt.finalize();
    try count_stmt.bindText(1, run_id);
    _ = try count_stmt.step();
    const base: usize = @intCast(count_stmt.int(0));
    for (records, 0..) |r, i| {
        var key_buf: [128]u8 = undefined;
        const key = try std.fmt.bufPrint(&key_buf, "run:{s}:{d}", .{ run_id, base + i });
        const id = ids.uuidV7(io);
        try manager.insertEventPlain(db, .{
            .kind = .usage,
            .run_id = run_id,
            .agent = agent,
            .conversation_id = conversation_id,
            .operation = "chat",
            .input_tokens = r.input_tokens,
            .output_tokens = r.output_tokens,
            .cache_read_tokens = r.cache_read_tokens,
            .cache_write_tokens = r.cache_write_tokens,
            .reasoning_tokens = r.reasoning_tokens,
            .source = source,
            .dedupe_key = key,
            .model = r.model,
            .reported_cost_usd = r.reported_cost_usd,
        }, &id, now_ms);
    }
}

/// `usageSummary`. Strings and the slice live in `arena`.
pub fn usageSummary(arena: std.mem.Allocator, db: sqlite.Db, by: By, since_ms: i64) ![]SummaryRow {
    const col = by.column();
    const sql = "SELECT " ++ "{s}" ++ " AS key," ++
        " COALESCE(sum(gen_ai_usage_input_tokens), 0) AS input," ++
        " COALESCE(sum(gen_ai_usage_output_tokens), 0) AS output," ++
        " COALESCE(sum(cache_read_tokens), 0) AS cache_read," ++
        " COALESCE(sum(cache_write_tokens), 0) AS cache_write," ++
        " CASE WHEN count(reported_cost_usd) = count(*) THEN sum(reported_cost_usd) END AS cost," ++
        " count(*) AS events" ++
        " FROM events WHERE kind = 'usage' AND ts >= ?" ++
        " GROUP BY {s} ORDER BY {s}";
    const text = try std.fmt.allocPrint(arena, sql, .{ col, col, col });
    const stmt = try db.prepare(text);
    defer stmt.finalize();
    try stmt.bindInt(1, since_ms);
    var rows: std.ArrayList(SummaryRow) = .empty;
    while (try stmt.step()) {
        try rows.append(arena, .{
            .key = (try stmt.textAlloc(arena, 0)) orelse "unknown",
            .input_tokens = stmt.int(1),
            .output_tokens = stmt.int(2),
            .cache_read_tokens = stmt.int(3),
            .cache_write_tokens = stmt.int(4),
            .reported_cost_usd = if (stmt.isNull(5)) null else stmt.real(5),
            .events = stmt.int(6),
        });
    }
    return rows.items;
}

// ---- tests (ports of usage.test.ts and the summary test of tail.test.ts) ----

const Fixture = @import("../auth/fixture.zig").Fixture;
const testing = std.testing;

fn rec(cost: ?f64) types.UsageRecord {
    return .{ .model = "m", .input_tokens = 10, .output_tokens = 5, .cache_read_tokens = 2, .cache_write_tokens = 1, .reasoning_tokens = 0, .reported_cost_usd = cost };
}

test "usage: recordUsage writes one event per record and later turns do not collide" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try recordUsage(testing.io, fx.db, "run1", "claude", null, "acp", &.{ rec(null), rec(0.25) }, 1000);
    try recordUsage(testing.io, fx.db, "run1", "claude", null, "acp", &.{rec(null)}, 1000);
    const stmt = try fx.db.prepare("SELECT dedupe_key FROM events ORDER BY rowid");
    defer stmt.finalize();
    const want = [_][]const u8{ "run:run1:0", "run:run1:1", "run:run1:2" };
    for (want) |key| {
        try testing.expect(try stmt.step());
        try testing.expectEqualStrings(key, (try stmt.text(0)).?);
    }
    try testing.expect(!try stmt.step());
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const rows = try usageSummary(arena.allocator(), fx.db, .run, 0);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqualStrings("run1", rows[0].key);
    try testing.expectEqual(@as(i64, 3), rows[0].events);
    try testing.expectEqual(@as(i64, 30), rows[0].input_tokens);
    try testing.expect(rows[0].reported_cost_usd == null);
}

test "usage: a summary keeps a NULL cost as null" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try fx.run(
        \\INSERT INTO events (id, ts, run_id, agent, kind, gen_ai_usage_input_tokens, reported_cost_usd) VALUES
        \\  ('1', 5000, 'r1', 'a', 'usage', 1, 0.5),
        \\  ('2', 5000, 'r2', 'a', 'usage', 1, NULL),
        \\  ('3', 5000, 'r3', 'b', 'usage', 4, 1),
        \\  ('4', 5000, 'r4', NULL, 'usage', 7, NULL),
        \\  ('5', 10, 'r5', 'a', 'usage', 100, NULL),
        \\  ('6', 5000, 'r6', 'a', 'message', 100, NULL)
    );
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const rows = try usageSummary(arena.allocator(), fx.db, .agent, 1000);
    try testing.expectEqual(@as(usize, 3), rows.len);
    // NULL sorts first in SQLite, and is reported as "unknown".
    try testing.expectEqualStrings("unknown", rows[0].key);
    try testing.expectEqualStrings("a", rows[1].key);
    try testing.expect(rows[1].reported_cost_usd == null);
    try testing.expectEqual(@as(i64, 2), rows[1].events);
    try testing.expectEqual(@as(i64, 2), rows[1].input_tokens);
    try testing.expectEqualStrings("b", rows[2].key);
    try testing.expectEqual(@as(f64, 1), rows[2].reported_cost_usd.?);
}
