//! Quota snapshots, port of code/src/server/features/usage/quota.ts. Every function takes the
//! database handle and so runs inside `App.withLock`; none of them touches the lock itself.
const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const ids = @import("../ids.zig");

pub const QuotaInput = struct {
    provider: []const u8,
    window: []const u8,
    used_percent: ?f64,
    resets_at: ?i64,
    source: []const u8,
    /// Observation time; the log line's own timestamp when ingesting history.
    ts: ?i64 = null,
};

pub const QuotaView = struct {
    provider: []const u8,
    window: []const u8,
    used_percent: ?f64,
    resets_at: ?i64,
    source: []const u8,
    ts: i64,
};

pub const providers = [_][]const u8{ "claude", "codex", "agy" };

fn bindOptReal(stmt: sqlite.Stmt, index: c_int, value: ?f64) !void {
    if (value) |v| try stmt.bindReal(index, v) else try stmt.bindNull(index);
}

fn bindOptInt(stmt: sqlite.Stmt, index: c_int, value: ?i64) !void {
    if (value) |v| try stmt.bindInt(index, v) else try stmt.bindNull(index);
}

pub fn insertSnapshot(db: sqlite.Db, io: std.Io, s: QuotaInput, now_ms: i64) !void {
    const stmt = try db.prepare(
        "INSERT INTO quota_snapshots (id, provider, window, used_percent, resets_at, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    defer stmt.finalize();
    const id = ids.uuidV7(io);
    try stmt.bindText(1, &id);
    try stmt.bindText(2, s.provider);
    try stmt.bindText(3, s.window);
    try bindOptReal(stmt, 4, s.used_percent);
    try bindOptInt(stmt, 5, s.resets_at);
    try stmt.bindText(6, s.source);
    try stmt.bindInt(7, s.ts orelse now_ms);
    _ = try stmt.step();
}

/// Tailers see the same limits on every turn; keep one row per change.
pub fn insertSnapshotIfChanged(db: sqlite.Db, io: std.Io, s: QuotaInput, now_ms: i64) !void {
    const stmt = try db.prepare(
        "SELECT used_percent, resets_at FROM quota_snapshots WHERE provider = ? AND window = ? ORDER BY ts DESC, rowid DESC LIMIT 1",
    );
    defer stmt.finalize();
    try stmt.bindText(1, s.provider);
    try stmt.bindText(2, s.window);
    if (try stmt.step()) {
        const same_percent = if (stmt.isNull(0)) s.used_percent == null else if (s.used_percent) |p| stmt.real(0) == p else false;
        const same_reset = if (stmt.isNull(1)) s.resets_at == null else if (s.resets_at) |r| stmt.int(1) == r else false;
        if (same_percent and same_reset) return;
    }
    try insertSnapshot(db, io, s, now_ms);
}

/// The newest snapshot per provider and window, then an `unknown` row for every provider with none.
/// Strings and the slice live in `arena`.
pub fn latestQuota(arena: std.mem.Allocator, db: sqlite.Db, now_ms: i64) ![]QuotaView {
    const stmt = try db.prepare(
        \\SELECT provider, window, used_percent, resets_at, source, ts FROM quota_snapshots q
        \\WHERE rowid = (SELECT rowid FROM quota_snapshots
        \\               WHERE provider = q.provider AND window = q.window
        \\               ORDER BY ts DESC, rowid DESC LIMIT 1)
        \\ORDER BY provider, window
    );
    defer stmt.finalize();
    var views: std.ArrayList(QuotaView) = .empty;
    while (try stmt.step()) {
        const resets_at: ?i64 = if (stmt.isNull(3)) null else stmt.int(3);
        const used: ?f64 = if (stmt.isNull(2)) null else stmt.real(2);
        try views.append(arena, .{
            .provider = (try stmt.textAlloc(arena, 0)).?,
            .window = (try stmt.textAlloc(arena, 1)).?,
            // A window that has already reset says nothing about current usage.
            .used_percent = if (resets_at) |r| (if (r <= now_ms) null else used) else used,
            .resets_at = resets_at,
            .source = (try stmt.textAlloc(arena, 4)).?,
            .ts = stmt.int(5),
        });
    }
    for (providers) |provider| {
        const seen = for (views.items) |v| {
            if (std.mem.eql(u8, v.provider, provider)) break true;
        } else false;
        if (seen) continue;
        try views.append(arena, .{
            .provider = provider,
            .window = "unknown",
            .used_percent = null,
            .resets_at = null,
            .source = "unknown",
            .ts = now_ms,
        });
    }
    return views.items;
}

// ---- tests (ports of quota.test.ts) ----

const Fixture = @import("../auth/fixture.zig").Fixture;
const testing = std.testing;

fn find(views: []const QuotaView, provider: []const u8, window: []const u8) ?QuotaView {
    for (views) |v| {
        if (std.mem.eql(u8, v.provider, provider) and std.mem.eql(u8, v.window, window)) return v;
    }
    return null;
}

test "usage: no snapshots, every provider is unknown" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const views = try latestQuota(arena.allocator(), fx.db, 1000);
    try testing.expectEqual(providers.len, views.len);
    for (views) |v| {
        try testing.expect(v.used_percent == null);
        try testing.expectEqualStrings("unknown", v.source);
    }
}

test "usage: latest snapshot per window wins" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try fx.run("INSERT INTO quota_snapshots (id, provider, window, used_percent, resets_at, source, ts) VALUES ('a', 'codex', 'primary', 10, NULL, 'tail', 1000), ('b', 'codex', 'primary', 30, NULL, 'tail', 2000)");
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const views = try latestQuota(arena.allocator(), fx.db, 5000);
    var codex: usize = 0;
    for (views) |v| {
        if (std.mem.eql(u8, v.provider, "codex")) codex += 1;
    }
    try testing.expectEqual(@as(usize, 1), codex);
    try testing.expectEqual(@as(f64, 30), find(views, "codex", "primary").?.used_percent.?);
}

test "usage: a recorded snapshot is visible, and one that already reset reads as unknown" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insertSnapshot(fx.db, testing.io, .{ .provider = "claude", .window = "five_hour", .used_percent = 37.5, .resets_at = 4102444800000, .source = "acp" }, 1000);
    try insertSnapshot(fx.db, testing.io, .{ .provider = "codex", .window = "primary", .used_percent = 90, .resets_at = 500, .source = "tail" }, 1000);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const views = try latestQuota(arena.allocator(), fx.db, 1000);
    const claude = find(views, "claude", "five_hour").?;
    try testing.expectEqual(@as(f64, 37.5), claude.used_percent.?);
    try testing.expectEqual(@as(i64, 4102444800000), claude.resets_at.?);
    try testing.expectEqualStrings("acp", claude.source);
    try testing.expect(find(views, "codex", "primary").?.used_percent == null);
}

test "usage: an unchanged snapshot is not stored twice" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const s: QuotaInput = .{ .provider = "codex", .window = "primary", .used_percent = 42, .resets_at = 4102444800000, .source = "tail" };
    try insertSnapshotIfChanged(fx.db, testing.io, s, 1);
    try insertSnapshotIfChanged(fx.db, testing.io, s, 2);
    var other = s;
    other.used_percent = 43;
    try insertSnapshotIfChanged(fx.db, testing.io, other, 3);
    const stmt = try fx.db.prepare("SELECT count(*) FROM quota_snapshots");
    defer stmt.finalize();
    _ = try stmt.step();
    try testing.expectEqual(@as(i64, 2), stmt.int(0));
}
