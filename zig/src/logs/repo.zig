//! Port of repo.ts: the SQL of the event store and its two FTS5 indexes.
const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const types = @import("../runtimes/types.zig");
const parity = @import("../parity.zig");
const text_mod = @import("text.zig");

const Allocator = std.mem.Allocator;

fn bindOpt(stmt: sqlite.Stmt, index: c_int, value: ?[]const u8) !void {
    if (value) |v| try stmt.bindText(index, v) else try stmt.bindNull(index);
}

fn bindOptInt(stmt: sqlite.Stmt, index: c_int, value: ?i64) !void {
    if (value) |n| try stmt.bindInt(index, n) else try stmt.bindNull(index);
}

/// Returns the new rowid, or null when dedupe_key already exists. The check is explicit because
/// the events_no_replace trigger fires before any ON CONFLICT clause could absorb the duplicate.
pub fn insertEvent(db: sqlite.Db, id: []const u8, ts: i64, event: types.NewEvent) !?i64 {
    if (event.dedupe_key) |key| {
        const probe = try db.prepare("SELECT 1 FROM events WHERE dedupe_key = ?");
        defer probe.finalize();
        try probe.bindText(1, key);
        if (try probe.step()) return null;
    }
    const stmt = try db.prepare("INSERT INTO events (id, ts, run_id, task_id, agent, kind, gen_ai_operation_name, " ++
        "gen_ai_tool_name, gen_ai_conversation_id, gen_ai_request_model, gen_ai_usage_input_tokens, " ++
        "gen_ai_usage_output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, reported_cost_usd, " ++
        "command, exit_code, duration_ms, guard_layer, guard_verdict, guard_rule, source, dedupe_key) " ++
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try stmt.bindInt(2, ts);
    try bindOpt(stmt, 3, event.run_id);
    try bindOpt(stmt, 4, event.task_id);
    try bindOpt(stmt, 5, event.agent);
    try stmt.bindText(6, @tagName(event.kind));
    try bindOpt(stmt, 7, event.operation);
    try bindOpt(stmt, 8, event.tool_name);
    try bindOpt(stmt, 9, event.conversation_id);
    try bindOpt(stmt, 10, event.model);
    try bindOptInt(stmt, 11, event.input_tokens);
    try bindOptInt(stmt, 12, event.output_tokens);
    try bindOptInt(stmt, 13, event.cache_read_tokens);
    try bindOptInt(stmt, 14, event.cache_write_tokens);
    try bindOptInt(stmt, 15, event.reasoning_tokens);
    if (event.reported_cost_usd) |cost| try stmt.bindReal(16, cost) else try stmt.bindNull(16);
    try bindOpt(stmt, 17, event.command);
    try bindOptInt(stmt, 18, event.exit_code);
    try bindOptInt(stmt, 19, event.duration_ms);
    try bindOpt(stmt, 20, if (event.guard_layer) |layer| @tagName(layer) else null);
    try bindOpt(stmt, 21, if (event.guard_verdict) |verdict| @tagName(verdict) else null);
    try bindOpt(stmt, 22, event.guard_rule);
    try bindOpt(stmt, 23, event.source);
    try bindOpt(stmt, 24, event.dedupe_key);
    _ = try stmt.step();

    const rowid = try db.prepare("SELECT last_insert_rowid()");
    defer rowid.finalize();
    _ = try rowid.step();
    return rowid.int(0);
}

/// The raw body waits in pending_payloads until it is sealed into a segment; both FTS tables
/// are fed now.
pub fn indexEvent(db: sqlite.Db, rowid: i64, run_id: ?[]const u8, body: ?[]const u8, command: ?[]const u8) !void {
    if (body) |text| {
        const payload = try db.prepare("INSERT INTO pending_payloads (event_rowid, run_id, body) VALUES (?, ?, ?)");
        defer payload.finalize();
        try payload.bindInt(1, rowid);
        try bindOpt(payload, 2, run_id);
        try payload.bindText(3, text);
        _ = try payload.step();
        const fts = try db.prepare("INSERT INTO events_fts (rowid, body) VALUES (?, ?)");
        defer fts.finalize();
        try fts.bindInt(1, rowid);
        try fts.bindText(2, text);
        _ = try fts.step();
    }
    if (command) |text| {
        const fts = try db.prepare("INSERT INTO commands_fts (rowid, text) VALUES (?, ?)");
        defer fts.finalize();
        try fts.bindInt(1, rowid);
        try fts.bindText(2, text);
        _ = try fts.step();
    }
}

pub fn pendingBody(gpa: Allocator, db: sqlite.Db, rowid: i64) !?[]u8 {
    const stmt = try db.prepare("SELECT body FROM pending_payloads WHERE event_rowid = ?");
    defer stmt.finalize();
    try stmt.bindInt(1, rowid);
    if (!try stmt.step()) return null;
    return try stmt.textAlloc(gpa, 0);
}

/// FTS5 MATCH takes a query language; quoting each term keeps user input literal.
fn quote(out: *std.ArrayList(u8), gpa: Allocator, term: []const u8) Allocator.Error!void {
    try out.append(gpa, '"');
    for (term) |byte| {
        if (byte == '"') try out.append(gpa, '"');
        try out.append(gpa, byte);
    }
    try out.append(gpa, '"');
}

/// detail=column forbids phrase queries, so a substring is searched as the AND of its distinct
/// 3-grams (single-token terms). That over-matches; matchCommands re-checks the real substring.
fn trigramQuery(gpa: Allocator, text: []const u8) Allocator.Error![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const codepoints = try text_mod.lowerCodepoints(arena.allocator(), text);
    var seen: std.StringArrayHashMapUnmanaged(void) = .empty;
    var i: usize = 0;
    while (i + 3 <= codepoints.len) : (i += 1) {
        var gram: std.ArrayList(u8) = .empty;
        for (codepoints[i .. i + 3]) |cp| try text_mod.appendUtf8(&gram, arena.allocator(), cp);
        try seen.put(arena.allocator(), gram.items, {});
    }
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    for (seen.keys(), 0..) |gram, n| {
        if (n > 0) try out.appendSlice(gpa, " AND ");
        try quote(&out, gpa, gram);
    }
    return out.toOwnedSlice(gpa);
}

fn matchRowidsIn(gpa: Allocator, db: sqlite.Db, comptime table: []const u8, query: []const u8, limit: i64) ![]i64 {
    const stmt = try db.prepare("SELECT rowid FROM " ++ table ++ " WHERE " ++ table ++ " MATCH ? ORDER BY rank LIMIT ?");
    defer stmt.finalize();
    try stmt.bindText(1, query);
    try stmt.bindInt(2, limit);
    var rowids: std.ArrayList(i64) = .empty;
    errdefer rowids.deinit(gpa);
    while (try stmt.step()) try rowids.append(gpa, stmt.int(0));
    return rowids.toOwnedSlice(gpa);
}

fn commandContains(gpa: Allocator, db: sqlite.Db, rowid: i64, needle: []const u16) !bool {
    const stmt = try db.prepare("SELECT command FROM events WHERE rowid = ?");
    defer stmt.finalize();
    try stmt.bindInt(1, rowid);
    if (!try stmt.step()) return false;
    const command = try stmt.text(0) orelse return false;
    const hay = try text_mod.toUtf16Lower(gpa, command);
    defer gpa.free(hay);
    return std.mem.find(u16, hay, needle) != null;
}

fn matchCommands(gpa: Allocator, db: sqlite.Db, q: []const u8, limit: usize) ![]i64 {
    // The trigram tokenizer needs at least 3 characters to match anything.
    const needle = try text_mod.toUtf16Lower(gpa, q);
    defer gpa.free(needle);
    if (text_mod.codepointCount(needle) < 3) return &.{};
    const match = try trigramQuery(gpa, q);
    defer gpa.free(match);
    const candidates = try matchRowidsIn(gpa, db, "commands_fts", match, @intCast(limit * 5));
    defer gpa.free(candidates);
    var kept: std.ArrayList(i64) = .empty;
    errdefer kept.deinit(gpa);
    for (candidates) |rowid| {
        if (kept.items.len == limit) break;
        if (try commandContains(gpa, db, rowid, needle)) try kept.append(gpa, rowid);
    }
    return kept.toOwnedSlice(gpa);
}

/// Rowids matching `q` in event bodies (as words) and in commands (as a substring), bodies first,
/// at most `limit`. The caller frees the slice.
pub fn matchRowids(gpa: Allocator, db: sqlite.Db, q: []const u8, limit: usize) ![]i64 {
    var ids_seen: std.ArrayList(i64) = .empty;
    errdefer ids_seen.deinit(gpa);
    var words = text_mod.wordIterator(q);
    var match: std.ArrayList(u8) = .empty;
    defer match.deinit(gpa);
    while (words.next()) |word| {
        if (match.items.len > 0) try match.append(gpa, ' ');
        try quote(&match, gpa, word);
    }
    if (match.items.len > 0) {
        const found = try matchRowidsIn(gpa, db, "events_fts", match.items, @intCast(limit));
        defer gpa.free(found);
        try ids_seen.appendSlice(gpa, found);
    }
    const in_commands = try matchCommands(gpa, db, parity.jsTrim(q), limit);
    defer gpa.free(in_commands);
    for (in_commands) |rowid| {
        if (std.mem.findScalar(i64, ids_seen.items, rowid) == null) try ids_seen.append(gpa, rowid);
    }
    if (ids_seen.items.len > limit) ids_seen.shrinkRetainingCapacity(limit);
    return ids_seen.toOwnedSlice(gpa);
}
