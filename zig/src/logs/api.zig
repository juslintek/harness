//! Port of api.ts: the event appender (redaction, base insert, pending body and both FTS indexes
//! in one transaction), segment sealing, body reads, `searchEvents` and `GET /api/search`.
const std = @import("std");
const httpz = @import("httpz");
const app_mod = @import("../app.zig");
const sqlite = @import("../db/sqlite.zig");
const headers = @import("../http/headers.zig");
const routes = @import("../http/routes.zig");
const middleware = @import("../auth/middleware.zig");
const parity = @import("../parity.zig");
const types = @import("../runtimes/types.zig");
const redact = @import("redact.zig");
const repo = @import("repo.zig");
const segments = @import("segments.zig");
const text = @import("text.zig");

const Allocator = std.mem.Allocator;

pub const redactSecrets = redact.redactSecrets;
pub const sealPending = segments.sealPending;
pub const default_min_bytes = segments.default_min_bytes;

const AppendCtx = struct { event: types.NewEvent, id: []const u8, ts: i64 };

fn insertIndexed(ctx: AppendCtx, db: sqlite.Db) sqlite.Error!?i64 {
    const rowid = try repo.insertEvent(db, ctx.id, ctx.ts, ctx.event) orelse return null;
    try repo.indexEvent(db, rowid, ctx.event.run_id, ctx.event.body, ctx.event.command);
    return rowid;
}

fn scrub(arena: Allocator, value: ?[]const u8) Allocator.Error!?[]const u8 {
    return try redact.redactSecrets(arena, value orelse return null);
}

/// Appends one event. Secrets are scrubbed here, before any pending, segment or FTS write. The
/// base row, the pending body and both FTS rows commit together or not at all; inside an open
/// transaction this is a savepoint. Returns the new rowid, or null when `dedupe_key` was seen.
pub fn appendEvent(gpa: Allocator, db: sqlite.Db, id: []const u8, now_ms: i64, event: types.NewEvent) !?i64 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var clean = event;
    clean.command = try scrub(arena.allocator(), event.command);
    clean.body = try scrub(arena.allocator(), event.body);
    clean.tool_name = try scrub(arena.allocator(), event.tool_name);
    clean.guard_rule = try scrub(arena.allocator(), event.guard_rule);
    return segments.atomic(db, AppendCtx{ .event = clean, .id = id, .ts = event.ts orelse now_ms }, insertIndexed);
}

/// `Links.append_event` for production wiring; `ctx` is unused.
pub fn appendLinked(ctx: ?*anyopaque, gpa: Allocator, db: sqlite.Db, event: types.NewEvent, id: []const u8, now_ms: i64) anyerror!void {
    _ = ctx;
    _ = try appendEvent(gpa, db, id, now_ms, event);
}

/// Seals the pending bodies of `run_id`, or of every run that holds `min_bytes`; returns the
/// number of segments written.
pub fn sealSegments(gpa: Allocator, io: std.Io, db: sqlite.Db, run_id: ?[]const u8, min_bytes: i64) !u32 {
    return segments.sealPending(gpa, io, db, run_id, run_id != null, min_bytes);
}

/// The body of an event, from pending_payloads or its segment; the caller frees it.
pub fn readBody(gpa: Allocator, db: sqlite.Db, rowid: i64) !?[]u8 {
    if (try repo.pendingBody(gpa, db, rowid)) |body| return body;
    const stmt = try db.prepare("SELECT segment_id, seg_offset, seg_len FROM events WHERE rowid = ?");
    defer stmt.finalize();
    try stmt.bindInt(1, rowid);
    if (!try stmt.step()) return null;
    if (stmt.isNull(0) or stmt.isNull(1) or stmt.isNull(2)) return null;
    const segment_id = try stmt.text(0) orelse return null;
    return segments.readSegmentBody(gpa, db, segment_id, stmt.int(1), stmt.int(2));
}

pub const SearchHit = struct {
    rowid: i64,
    id: []const u8,
    run_id: ?[]const u8,
    kind: []const u8,
    ts: i64,
    /// UTF-16 code units: the TS snippet is cut by code unit and may split a surrogate pair.
    snippet: []const u16,
};

const snippet_radius: usize = 60;

fn cut(arena: Allocator, haystack: []const u8, needle: []const u8) Allocator.Error!?[]const u16 {
    const units = try text.toUtf16(arena, haystack);
    const folded = try text.toUtf16Lower(arena, haystack);
    const needle_units = try text.toUtf16(arena, needle);
    const needle_folded = try text.toUtf16Lower(arena, needle);
    const at = std.mem.find(u16, folded, needle_folded) orelse return null;
    const start = at -| snippet_radius;
    const end = @min(units.len, at + needle_units.len + snippet_radius);
    return units[start..end];
}

fn snippetFor(arena: Allocator, body: ?[]const u8, command: ?[]const u8, q: []const u8) Allocator.Error![]const u16 {
    const trimmed = parity.jsTrim(q);
    var words = text.wordIterator(q);
    var needle = trimmed;
    while (true) {
        for ([_]?[]const u8{ body, command }) |source| {
            if (source) |s| if (try cut(arena, s, needle)) |hit| return hit;
        }
        needle = words.next() orelse break;
    }
    const units = try text.toUtf16(arena, body orelse command orelse "");
    return units[0..@min(units.len, snippet_radius * 2)];
}

/// Event ids matching `q` with a snippet each, best first. Everything is allocated from `arena`.
pub fn searchEvents(arena: Allocator, db: sqlite.Db, q: []const u8, limit: usize) ![]SearchHit {
    const rowids = try repo.matchRowids(arena, db, q, limit);
    var hits: std.ArrayList(SearchHit) = .empty;
    const stmt = try db.prepare("SELECT id, run_id, kind, ts, command FROM events WHERE rowid = ?");
    defer stmt.finalize();
    for (rowids) |rowid| {
        try stmt.reset();
        try stmt.bindInt(1, rowid);
        if (!try stmt.step()) continue;
        const command = try stmt.textAlloc(arena, 4);
        const body = try readBody(arena, db, rowid);
        try hits.append(arena, .{
            .rowid = rowid,
            .id = try stmt.textAlloc(arena, 0) orelse return error.CorruptRow,
            .run_id = try stmt.textAlloc(arena, 1),
            .kind = try stmt.textAlloc(arena, 2) orelse return error.CorruptRow,
            .ts = stmt.int(3),
            .snippet = try snippetFor(arena, body, command, q),
        });
    }
    return hits.items;
}

fn writeHits(w: *std.Io.Writer, arena: Allocator, hits: []const SearchHit) !void {
    try w.writeByte('[');
    for (hits, 0..) |hit, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("{{\"rowid\":{d},\"id\":", .{hit.rowid});
        try text.writeJsonString(w, try text.toUtf16(arena, hit.id));
        try w.writeAll(",\"runId\":");
        if (hit.run_id) |run| try text.writeJsonString(w, try text.toUtf16(arena, run)) else try w.writeAll("null");
        try w.writeAll(",\"kind\":");
        try text.writeJsonString(w, try text.toUtf16(arena, hit.kind));
        try w.print(",\"ts\":{d},\"snippet\":", .{hit.ts});
        try text.writeJsonString(w, hit.snippet);
        try w.writeByte('}');
    }
    try w.writeByte(']');
}

/// Hono's `c.req.query()` for one name: pairs split on `&`, the first pair whose decoded name
/// matches wins, `+` is a space, undecodable `%` runs stay as written.
fn queryParam(arena: Allocator, raw: []const u8, name: []const u8) Allocator.Error!?[]const u8 {
    var pairs = std.mem.splitScalar(u8, raw, '&');
    while (pairs.next()) |pair| {
        const eq = std.mem.findScalar(u8, pair, '=');
        const key = try decodeComponent(arena, pair[0 .. eq orelse pair.len]);
        if (key.len == 0 or !std.mem.eql(u8, key, name)) continue;
        return if (eq) |at| try decodeComponent(arena, pair[at + 1 ..]) else "";
    }
    return null;
}

fn decodeComponent(arena: Allocator, raw: []const u8) Allocator.Error![]const u8 {
    const spaced = try arena.dupe(u8, raw);
    std.mem.replaceScalar(u8, spaced, '+', ' ');
    return middleware.percentDecode(arena, spaced);
}

const max_query_units = 200;

/// `searchQuerySchema`: q is trimmed, then 1 to 200 UTF-16 code units. Null when invalid.
fn validQuery(arena: Allocator, raw_query: []const u8) Allocator.Error!?[]const u8 {
    const value = try queryParam(arena, raw_query, "q") orelse return null;
    const trimmed = parity.jsTrim(value);
    const units = parity.utf16Len(trimmed) catch return null;
    if (units < 1 or units > max_query_units) return null;
    return trimmed;
}

const SearchArgs = struct { arena: Allocator, q: []const u8 };

fn searchLocked(args: SearchArgs, state: *app_mod.State) ![]const u8 {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const hits = try searchEvents(args.arena, db, args.q, 20);
    var out: std.Io.Writer.Allocating = .init(args.arena);
    try writeHits(&out.writer, args.arena, hits);
    return out.written();
}

/// `GET /api/search`, http.ts:112.
pub fn search(call: *routes.Call) anyerror!void {
    const arena = call.res.arena;
    const q = try validQuery(arena, call.req.url.query) orelse
        return headers.sendError(call.res, 400, "invalid query");
    call.res.body = try call.services.app.withLock(SearchArgs{ .arena = arena, .q = q }, searchLocked);
    call.res.header("content-type", "application/json");
}

// ---- tests ----

const testing = std.testing;
const migrate = @import("../db/migrate.zig");

fn memoryDb() !sqlite.Db {
    const db = try sqlite.Db.open(testing.allocator, ":memory:");
    errdefer db.close();
    _ = try migrate.run(db, &migrate.embedded);
    return db;
}

fn repeat(comptime unit: []const u8, comptime n: usize) *const [unit.len * n]u8 {
    const out = comptime blk: {
        var arr: [unit.len * n]u8 = undefined;
        for (0..n) |i| @memcpy(arr[i * unit.len ..][0..unit.len], unit);
        break :blk arr;
    };
    return &out;
}

fn count(db: sqlite.Db, sql: [:0]const u8) !i64 {
    const stmt = try db.prepare(sql);
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

test "logs/api: an event lands in events, pending_payloads and both indexes, redacted" {
    const db = try memoryDb();
    defer db.close();
    const rowid = try appendEvent(testing.allocator, db, "e1", 100, .{
        .kind = .tool_call,
        .run_id = "r1",
        .body = "deploy with token=hunter2 now",
        .command = "curl --password hunter2 http://x",
        .tool_name = "bash PASSWORD=abc",
    });
    try testing.expectEqual(@as(?i64, 1), rowid);
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM events WHERE ts = 100 AND gen_ai_tool_name = 'bash PASSWORD=[REDACTED:secret]'"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM pending_payloads WHERE body = 'deploy with token=[REDACTED:secret] now'"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM events_fts WHERE events_fts MATCH 'deploy'"));
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT count(*) FROM events_fts WHERE events_fts MATCH 'hunter2'"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM events WHERE command = 'curl --password [REDACTED:secret] http://x'"));
}

test "logs/api: a repeated dedupe_key is skipped" {
    const db = try memoryDb();
    defer db.close();
    const event: types.NewEvent = .{ .kind = .usage, .dedupe_key = "k", .body = "once" };
    try testing.expect((try appendEvent(testing.allocator, db, "a", 1, event)) != null);
    try testing.expectEqual(@as(?i64, null), try appendEvent(testing.allocator, db, "b", 2, event));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM events"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM pending_payloads"));
}

// A pending_payloads row already holds the rowid the event will get, so the third write of the
// append fails after the base insert succeeded.
fn blockPendingRowid(db: sqlite.Db) !void {
    try db.exec("INSERT INTO pending_payloads (event_rowid, run_id, body) VALUES (1, 'r', 'squatter')");
}

test "logs/api: a failure part way through an append stores nothing" {
    const db = try memoryDb();
    defer db.close();
    try blockPendingRowid(db);
    const event: types.NewEvent = .{ .kind = .message, .run_id = "r", .body = "hello", .command = "ls -la" };
    try testing.expectError(error.Constraint, appendEvent(testing.allocator, db, "e1", 1, event));
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT count(*) FROM events"));
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT count(*) FROM events_fts WHERE events_fts MATCH 'hello'"));
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT count(*) FROM commands_fts WHERE commands_fts MATCH '\"ls \"'"));
    try testing.expect(!db.inTransaction());
}

test "logs/api: inside the caller's transaction a failed append rolls back only itself" {
    const db = try memoryDb();
    defer db.close();
    try db.begin();
    _ = (try appendEvent(testing.allocator, db, "keep", 1, .{ .kind = .run, .run_id = "other", .body = "kept" })) orelse return error.TestUnexpectedResult;
    // Rowid 2 is taken, so the next append fails after its base insert.
    try db.exec("INSERT INTO pending_payloads (event_rowid, run_id, body) VALUES (2, 'r', 'squatter')");
    try testing.expectError(error.Constraint, appendEvent(testing.allocator, db, "gone", 2, .{ .kind = .message, .run_id = "r", .body = "lost" }));
    try testing.expect(db.inTransaction());
    try db.commit();
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM events"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM events WHERE id = 'keep'"));
}

test "logs/api: sealing moves bodies into a segment and readBody finds them" {
    const gpa = testing.allocator;
    const db = try memoryDb();
    defer db.close();
    const bodies = [_][]const u8{ "alpha body", "beta ąčę body", "gamma" };
    var rowids: [3]i64 = undefined;
    for (bodies, 0..) |body, i| {
        var id_buf: [8]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_buf, "e{d}", .{i});
        rowids[i] = (try appendEvent(gpa, db, id, 10, .{ .kind = .message, .run_id = "r1", .body = body })).?;
    }
    try testing.expectEqual(@as(u32, 1), try sealSegments(gpa, testing.io, db, "r1", 0));
    try testing.expectEqual(@as(i64, 0), try count(db, "SELECT count(*) FROM pending_payloads"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM segments WHERE level = 3 AND run_id = 'r1'"));
    for (bodies, rowids) |body, rowid| {
        const got = (try readBody(gpa, db, rowid)).?;
        defer gpa.free(got);
        try testing.expectEqualStrings(body, got);
    }
    // Nothing pending is left, so a second seal writes nothing.
    try testing.expectEqual(@as(u32, 0), try sealSegments(gpa, testing.io, db, "r1", 0));
}

test "logs/api: a min_bytes seal only takes runs that hold enough" {
    const gpa = testing.allocator;
    const db = try memoryDb();
    defer db.close();
    _ = try appendEvent(gpa, db, "a", 1, .{ .kind = .message, .run_id = "small", .body = "tiny" });
    _ = try appendEvent(gpa, db, "b", 1, .{ .kind = .message, .run_id = "big", .body = repeat("x", 100) });
    _ = try appendEvent(gpa, db, "c", 1, .{ .kind = .message, .body = repeat("y", 100) });
    try testing.expectEqual(@as(u32, 2), try sealSegments(gpa, testing.io, db, null, 100));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM pending_payloads WHERE run_id = 'small'"));
    try testing.expectEqual(@as(i64, 1), try count(db, "SELECT count(*) FROM segments WHERE run_id IS NULL"));
}

const SegmentFixture = struct {
    segment: struct { id: []const u8, runId: []const u8, level: i64, rawLen: i64, bytes: []const u8 },
    events: []const struct { rowid: i64, id: []const u8, offset: i64, len: i64, body: ?[]const u8, markerAt: ?i64 },
};

test "logs/api: a segment sealed by the TS server is read back" {
    const gpa = testing.allocator;
    const parsed = try std.json.parseFromSlice(SegmentFixture, gpa, @embedFile("fixtures/segment.json"), .{});
    defer parsed.deinit();
    const fx = parsed.value;
    const db = try memoryDb();
    defer db.close();

    const decoder = std.base64.standard.Decoder;
    const compressed = try gpa.alloc(u8, try decoder.calcSizeForSlice(fx.segment.bytes));
    defer gpa.free(compressed);
    try decoder.decode(compressed, fx.segment.bytes);
    {
        const stmt = try db.prepare("INSERT INTO segments (id, run_id, created_at, level, raw_len, bytes) VALUES (?, ?, 1, ?, ?, ?)");
        defer stmt.finalize();
        try stmt.bindText(1, fx.segment.id);
        try stmt.bindText(2, fx.segment.runId);
        try stmt.bindInt(3, fx.segment.level);
        try stmt.bindInt(4, fx.segment.rawLen);
        try stmt.bindBlob(5, compressed);
        _ = try stmt.step();
    }
    for (fx.events) |ev| {
        const stmt = try db.prepare("INSERT INTO events (rowid, id, ts, run_id, kind, segment_id, seg_offset, seg_len) VALUES (?, ?, 1, ?, 'message', ?, ?, ?)");
        defer stmt.finalize();
        try stmt.bindInt(1, ev.rowid);
        try stmt.bindText(2, ev.id);
        try stmt.bindText(3, fx.segment.runId);
        try stmt.bindText(4, fx.segment.id);
        try stmt.bindInt(5, ev.offset);
        try stmt.bindInt(6, ev.len);
        _ = try stmt.step();
    }
    for (fx.events) |ev| {
        const got = (try readBody(gpa, db, ev.rowid)).?;
        defer gpa.free(got);
        if (ev.body) |want| {
            try testing.expectEqualStrings(want, got);
        } else {
            try testing.expectEqual(@as(usize, @intCast(ev.len)), got.len);
            try testing.expectEqual(@as(usize, @intCast(ev.markerAt.?)), std.mem.find(u8, got, "needlemarker").?);
        }
    }
}

test "logs/api: search finds bodies by word and commands by substring, with snippets" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const db = try memoryDb();
    defer db.close();
    const long = comptime repeat("padding ", 20) ++ "the Deploy failed on host seven " ++ repeat("tail ", 20);
    _ = try appendEvent(testing.allocator, db, "m1", 5, .{ .kind = .message, .run_id = "r1", .body = long });
    _ = try appendEvent(testing.allocator, db, "c1", 6, .{ .kind = .tool_call, .command = "git push origin main" });
    _ = try appendEvent(testing.allocator, db, "m2", 7, .{ .kind = .message, .run_id = "r2", .body = "unrelated" });

    const by_word = try searchEvents(a, db, "deploy", 20);
    try testing.expectEqual(@as(usize, 1), by_word.len);
    try testing.expectEqualStrings("m1", by_word[0].id);
    try testing.expectEqualStrings("message", by_word[0].kind);
    try testing.expectEqual(@as(i64, 5), by_word[0].ts);
    const snippet = try std.unicode.utf16LeToUtf8Alloc(a, by_word[0].snippet);
    try testing.expect(std.mem.startsWith(u8, snippet, "padding padding"));
    try testing.expect(std.mem.find(u8, snippet, "Deploy failed") != null);
    try testing.expectEqual(@as(usize, 60 + "deploy".len + 60), by_word[0].snippet.len);

    const by_substring = try searchEvents(a, db, "push ORIGIN", 20);
    try testing.expectEqual(@as(usize, 1), by_substring.len);
    try testing.expectEqualStrings("c1", by_substring[0].id);
    try testing.expectEqual(@as(?[]const u8, null), by_substring[0].run_id);
    const cmd_snippet = try std.unicode.utf16LeToUtf8Alloc(a, by_substring[0].snippet);
    try testing.expectEqualStrings("git push origin main", cmd_snippet);

    try testing.expectEqual(@as(usize, 0), (try searchEvents(a, db, "nomatch", 20)).len);
    // Under 3 characters the command index cannot match, and "ab" is not a body word here.
    try testing.expectEqual(@as(usize, 0), (try searchEvents(a, db, "gi", 20)).len);
    // Quotes in the query are literal text, not FTS syntax.
    try testing.expectEqual(@as(usize, 0), (try searchEvents(a, db, "\"deploy\" OR NOT", 20)).len);
}

test "logs/api: search reads bodies from sealed segments" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const db = try memoryDb();
    defer db.close();
    _ = try appendEvent(testing.allocator, db, "m1", 5, .{ .kind = .message, .run_id = "r1", .body = "sealed words here" });
    _ = try sealSegments(testing.allocator, testing.io, db, "r1", 0);
    const hits = try searchEvents(arena.allocator(), db, "sealed", 20);
    try testing.expectEqual(@as(usize, 1), hits.len);
    try testing.expectEqual(@as(usize, "sealed words here".len), hits[0].snippet.len);
}

test "logs/api: the search response is the TS JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const hits = [_]SearchHit{
        .{ .rowid = 3, .id = "i", .run_id = null, .kind = "message", .ts = 9, .snippet = std.unicode.utf8ToUtf16LeStringLiteral("a\"b\u{e9}") },
        .{ .rowid = 4, .id = "j", .run_id = "r", .kind = "run", .ts = 10, .snippet = &.{0xd83d} },
    };
    var out: std.Io.Writer.Allocating = .init(a);
    try writeHits(&out.writer, a, &hits);
    try testing.expectEqualStrings(
        "[{\"rowid\":3,\"id\":\"i\",\"runId\":null,\"kind\":\"message\",\"ts\":9,\"snippet\":\"a\\\"b\u{e9}\"}," ++
            "{\"rowid\":4,\"id\":\"j\",\"runId\":\"r\",\"kind\":\"run\",\"ts\":10,\"snippet\":\"\\ud83d\"}]",
        out.written(),
    );
}

test "logs/api: the q parameter follows searchQuerySchema and Hono's query parsing" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("hello world", (try validQuery(a, "q=hello+world")).?);
    try testing.expectEqualStrings("a b", (try validQuery(a, "x=1&q=%20a%20b%20%C2%A0")).?);
    try testing.expectEqualStrings("first", (try validQuery(a, "q=first&q=second")).?);
    try testing.expectEqualStrings("x", (try validQuery(a, "%71=x")).?);
    try testing.expectEqualStrings("100%", (try validQuery(a, "q=100%")).?);
    try testing.expectEqual(@as(?[]const u8, null), try validQuery(a, ""));
    try testing.expectEqual(@as(?[]const u8, null), try validQuery(a, "q"));
    try testing.expectEqual(@as(?[]const u8, null), try validQuery(a, "q=%20%20"));
    try testing.expectEqual(@as(?[]const u8, null), try validQuery(a, "other=1"));
    const max = comptime "q=" ++ repeat("x", 200);
    try testing.expect((try validQuery(a, max)) != null);
    try testing.expectEqual(@as(?[]const u8, null), try validQuery(a, max ++ "x"));
    // The limit counts UTF-16 code units: 100 emoji are 200, 101 are 202.
    try testing.expect((try validQuery(a, "q=" ++ repeat("%F0%9F%99%82", 100))) != null);
    try testing.expectEqual(@as(?[]const u8, null), try validQuery(a, "q=" ++ repeat("%F0%9F%99%82", 101)));
}

test "logs/api: an append that runs out of memory leaves nothing behind" {
    const Run = struct {
        fn run(gpa: Allocator) !void {
            const db = try memoryDb();
            defer db.close();
            _ = try appendEvent(gpa, db, "e", 1, .{ .kind = .message, .body = "token=abc deploy", .command = "ls" });
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Run.run, .{});
}

test {
    _ = @import("redact.zig");
    _ = @import("segments.zig");
    _ = @import("text.zig");
    _ = @import("zstd_c.zig");
}
