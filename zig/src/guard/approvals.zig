//! Approval records and their state machine over the `approvals` table. Port of
//! guard/approvals.ts. Every database function takes the connection and expects the caller to
//! hold the App lock; `waitForDecision` is the one function that takes the App, because it must
//! not hold the lock while a human thinks.
//!
//! There is no in-process waiter map as in TS: a waiting run polls its row, so a decision, an
//! expiry and a killed run all reach it through the database. Approval notifications (phase 5)
//! are not ported, so nothing announces a status change.
const std = @import("std");
const Allocator = std.mem.Allocator;
const app_mod = @import("../app.zig");
const ids = @import("../ids.zig");
const sqlite = @import("../db/sqlite.zig");

pub const Status = enum { pending, approved, denied, expired };
pub const Decision = enum { approve, deny };

pub const Error = sqlite.Error || Allocator.Error || error{ NoDatabase, CorruptApproval };

/// All strings are allocated from the allocator given to `get` or `list`.
pub const Row = struct {
    id: []const u8,
    run_id: []const u8,
    action: []const u8,
    l1: []const u8,
    l2: ?[]const u8,
    status: Status,
    decided_by: ?[]const u8,
    created_at: i64,
    expires_at: i64,
    decided_at: ?i64,
};

pub const NewApproval = struct {
    run_id: []const u8,
    action: []const u8,
    l1: []const u8,
    l2: ?[]const u8 = null,
    timeout_ms: i64,
};

pub const Created = struct { id: [ids.uuid_len]u8, expires_at: i64 };

const columns = "SELECT id, run_id, action, l1, l2, status, decided_by, created_at, expires_at, decided_at FROM approvals";

/// What TS passes to `markExpired` when the timer fired: every pending row counts as due.
const max_safe_integer: i64 = 9007199254740991;

fn rowsChanged(db: sqlite.Db) Error!i64 {
    const stmt = try db.prepare("SELECT changes()");
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

fn bindOpt(stmt: sqlite.Stmt, index: c_int, value: ?[]const u8) Error!void {
    if (value) |v| try stmt.bindText(index, v) else try stmt.bindNull(index);
}

pub fn create(db: sqlite.Db, io: std.Io, input: NewApproval) Error!Created {
    const id = ids.uuidV7(io);
    const now = ids.nowMs(io);
    const expires_at = now + input.timeout_ms;
    const stmt = try db.prepare("INSERT INTO approvals (id, run_id, action, l1, l2, status, created_at, expires_at) " ++
        "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)");
    defer stmt.finalize();
    try stmt.bindText(1, &id);
    try stmt.bindText(2, input.run_id);
    try stmt.bindText(3, input.action);
    try stmt.bindText(4, input.l1);
    try bindOpt(stmt, 5, input.l2);
    try stmt.bindInt(6, now);
    try stmt.bindInt(7, expires_at);
    _ = try stmt.step();
    return .{ .id = id, .expires_at = expires_at };
}

/// One statement, so a decision and the expiry timer cannot both win. A failed decision marks a
/// row that is past its expiry as expired, like TS.
pub fn decide(db: sqlite.Db, id: []const u8, decision: Decision, by: []const u8, now_ms: i64) Error!bool {
    const stmt = try db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? " ++
        "WHERE id = ? AND status = 'pending' AND expires_at > ?");
    defer stmt.finalize();
    try stmt.bindText(1, if (decision == .approve) "approved" else "denied");
    try stmt.bindText(2, by);
    try stmt.bindInt(3, now_ms);
    try stmt.bindText(4, id);
    try stmt.bindInt(5, now_ms);
    _ = try stmt.step();
    if (try rowsChanged(db) == 1) return true;
    _ = try markExpired(db, id, now_ms);
    return false;
}

/// `now_ms` null means the timer fired, so the clock comparison no longer matters.
pub fn markExpired(db: sqlite.Db, id: []const u8, now_ms: ?i64) Error!bool {
    const stmt = try db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try stmt.bindInt(2, now_ms orelse max_safe_integer);
    _ = try stmt.step();
    return try rowsChanged(db) == 1;
}

/// The sweep: every pending row past its expiry. Returns how many changed.
pub fn expireDue(db: sqlite.Db, now_ms: i64) Error!u32 {
    const stmt = try db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?");
    defer stmt.finalize();
    try stmt.bindInt(1, now_ms);
    _ = try stmt.step();
    return @intCast(try rowsChanged(db));
}

/// A run that ended no longer has anyone waiting. An agent member's approvals stay pending
/// until their own expiry (the heartbeat wakes the member when the sweep expires them, see
/// approval-expiry.test.ts); every other run's are expired now. Returns how many were pending.
pub fn expireRun(db: sqlite.Db, run_id: []const u8) Error!u32 {
    const pending = blk: {
        const stmt = try db.prepare("SELECT count(*) FROM approvals WHERE run_id = ? AND status = 'pending'");
        defer stmt.finalize();
        try stmt.bindText(1, run_id);
        _ = try stmt.step();
        break :blk stmt.int(0);
    };
    if (pending == 0 or try runHasMember(db, run_id)) return @intCast(pending);
    const stmt = try db.prepare("UPDATE approvals SET status = 'expired' WHERE run_id = ? AND status = 'pending'");
    defer stmt.finalize();
    try stmt.bindText(1, run_id);
    _ = try stmt.step();
    return @intCast(pending);
}

fn runHasMember(db: sqlite.Db, run_id: []const u8) Error!bool {
    const stmt = try db.prepare("SELECT member_id FROM runs WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, run_id);
    if (!try stmt.step()) return false;
    const member = try stmt.text(0) orelse return false;
    return member.len > 0;
}

fn readRow(stmt: sqlite.Stmt, a: Allocator) Error!Row {
    const status_text = (try stmt.text(5)) orelse return error.CorruptApproval;
    return .{
        .id = (try stmt.textAlloc(a, 0)).?,
        .run_id = (try stmt.textAlloc(a, 1)).?,
        .action = (try stmt.textAlloc(a, 2)).?,
        .l1 = (try stmt.textAlloc(a, 3)).?,
        .l2 = try stmt.textAlloc(a, 4),
        .status = std.meta.stringToEnum(Status, status_text) orelse return error.CorruptApproval,
        .decided_by = try stmt.textAlloc(a, 6),
        .created_at = stmt.int(7),
        .expires_at = stmt.int(8),
        .decided_at = if (stmt.isNull(9)) null else stmt.int(9),
    };
}

pub fn get(db: sqlite.Db, a: Allocator, id: []const u8) Error!?Row {
    const stmt = try db.prepare(columns ++ " WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if (!try stmt.step()) return null;
    return try readRow(stmt, a);
}

pub fn list(db: sqlite.Db, a: Allocator, status: ?Status) Error![]Row {
    const stmt = try db.prepare(columns ++ " WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at, id");
    defer stmt.finalize();
    try bindOpt(stmt, 1, if (status) |s| @tagName(s) else null);
    var rows: std.ArrayList(Row) = .empty;
    while (try stmt.step()) try rows.append(a, try readRow(stmt, a));
    return rows.toOwnedSlice(a);
}

/// ApprovalView of code/src/shared/runs.ts. Field order is the wire order.
pub const View = struct {
    id: []const u8,
    runId: []const u8,
    command: []const u8,
    reason: ?[]const u8,
    status: Status,
    decidedBy: ?[]const u8,
    createdAt: i64,
    expiresAt: i64,
    decidedAt: ?i64,
};

/// The object a stored JSON column holds, or null: TS `parsed()` falls back to `{}` for invalid
/// JSON and for anything that is not an object, and an array has none of the keys read here.
fn objectOf(a: Allocator, text: []const u8) Allocator.Error!?std.json.ObjectMap {
    const value = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{ .duplicate_field_behavior = .use_last }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return null,
    };
    return if (value == .object) value.object else null;
}

/// `String(value)` for the element kinds a stored path list can hold, as `Array.join` calls it.
fn appendJsString(a: Allocator, out: *std.ArrayList(u8), value: std.json.Value) Allocator.Error!void {
    switch (value) {
        .null => {},
        .bool => |b| try out.appendSlice(a, if (b) "true" else "false"),
        .integer => |n| try out.print(a, "{d}", .{n}),
        .float => |f| try out.print(a, "{d}", .{f}),
        .number_string, .string => |s| try out.appendSlice(a, s),
        .array => |items| for (items.items, 0..) |item, i| {
            if (i > 0) try out.append(a, ',');
            try appendJsString(a, out, item);
        },
        .object => try out.appendSlice(a, "[object Object]"),
    }
}

/// The human decides on the raw command, so it is shown as stored (redacted at creation).
pub fn view(a: Allocator, row: Row) Allocator.Error!View {
    var command: []const u8 = "";
    if (try objectOf(a, row.action)) |action| {
        const own = if (action.get("command")) |c| c == .string else false;
        if (own) {
            command = action.get("command").?.string;
        } else {
            if (action.get("paths")) |p| if (p == .array) {
                var joined: std.ArrayList(u8) = .empty;
                for (p.array.items, 0..) |item, i| {
                    if (i > 0) try joined.append(a, ' ');
                    try appendJsString(a, &joined, item);
                }
                command = joined.items;
            };
        }
    }
    var reason: ?[]const u8 = null;
    if (try objectOf(a, row.l1)) |l1| {
        if (l1.get("reason")) |r| if (r == .string) {
            reason = r.string;
        };
    }
    return .{
        .id = row.id,
        .runId = row.run_id,
        .command = command,
        .reason = reason,
        .status = row.status,
        .decidedBy = row.decided_by,
        .createdAt = row.created_at,
        .expiresAt = row.expires_at,
        .decidedAt = row.decided_at,
    };
}

pub fn writeView(w: *std.Io.Writer, v: View) std.Io.Writer.Error!void {
    try std.json.Stringify.value(v, .{}, w);
}

pub const poll_ms: i64 = 50;

const PollCtx = struct { io: std.Io, id: []const u8 };

/// The state of `id` under the lock. A pending row past its expiry is expired here, as the TS
/// timer does. A row whose run already ended is reported expired without being changed, which
/// is what settling a waiter does in TS.
fn pollLocked(ctx: PollCtx, state: *app_mod.State) Error!Status {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const seen = blk: {
        const stmt = try db.prepare("SELECT status, expires_at, " ++
            "COALESCE((SELECT ended_at IS NOT NULL FROM runs WHERE runs.id = approvals.run_id), 0) FROM approvals WHERE id = ?");
        defer stmt.finalize();
        try stmt.bindText(1, ctx.id);
        if (!try stmt.step()) return .expired;
        const status = std.meta.stringToEnum(Status, (try stmt.text(0)) orelse "") orelse return error.CorruptApproval;
        break :blk .{ status, stmt.int(1), stmt.int(2) == 1 };
    };
    if (seen[0] != .pending) return seen[0];
    if (ids.nowMs(ctx.io) >= seen[1]) {
        return if (try markExpired(db, ctx.id, null)) .expired else try finalStatus(db, ctx.id);
    }
    return if (seen[2]) .expired else .pending;
}

fn finalStatus(db: sqlite.Db, id: []const u8) Error!Status {
    const stmt = try db.prepare("SELECT status FROM approvals WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if (!try stmt.step()) return .expired;
    const status = std.meta.stringToEnum(Status, (try stmt.text(0)) orelse "") orelse return error.CorruptApproval;
    return if (status == .pending) .expired else status;
}

/// Blocks until the approval is decided or expired and returns that status, never `.pending`.
/// The lock is taken for one read per step. A cancelation (the run's decide timeout or an abort)
/// ends the wait with `error.Canceled` and leaves the row as it is; `expireRun` deals with it.
pub fn waitForDecision(app: *app_mod.App, id: []const u8, expires_at: i64) (Error || error{Canceled})!Status {
    while (true) {
        const status = try app.withLock(PollCtx{ .io = app.io, .id = id }, pollLocked);
        if (status != .pending) return status;
        const left = expires_at - ids.nowMs(app.io);
        try app.io.sleep(.fromMilliseconds(std.math.clamp(left, 1, poll_ms)), .awake);
    }
}

/// `startApprovalExpiry`: how often the sweep looks for pending rows past their expiry.
pub const sweep_ms: i64 = 1000;

fn sweepLocked(now_ms: i64, state: *app_mod.State) Error!u32 {
    return expireDue(.{ .handle = state.db orelse return error.NoDatabase }, now_ms);
}

/// The sweep, run on its own task until it is canceled: once at start, as `startApprovalExpiry`
/// does, so rows that expired while the server was down do not wait a second. A failed pass is
/// logged and the next one tries again, as the timer of TS keeps going after a throwing callback.
pub fn sweepLoop(app: *app_mod.App) void {
    while (true) {
        _ = app.withLock(ids.nowMs(app.io), sweepLocked) catch |err| std.log.err("approval expiry sweep failed: {t}", .{err});
        app.io.sleep(.fromMilliseconds(sweep_ms), .awake) catch return;
    }
}

/// `Links.expire_approvals`: the run ended, so nobody waits for its pending approvals any more.
pub fn expireForRun(_: ?*anyopaque, db: sqlite.Db, run_id: []const u8) void {
    _ = expireRun(db, run_id) catch |err| std.log.err("expiring the approvals of run {s} failed: {t}", .{ run_id, err });
}

const testing = std.testing;
const Fixture = @import("../auth/fixture.zig").Fixture;

fn insert(db: sqlite.Db, id: []const u8, expires_at: i64, status: []const u8) !void {
    const stmt = try db.prepare("INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, 'r', '{}', '{}', ?, 1, ?)");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try stmt.bindText(2, status);
    try stmt.bindInt(3, expires_at);
    _ = try stmt.step();
}

fn statusOf(db: sqlite.Db, id: []const u8) !Status {
    const row = (try get(db, testing.allocator, id)).?;
    defer freeRow(row);
    return row.status;
}

fn freeRow(row: Row) void {
    const gpa = testing.allocator;
    gpa.free(row.id);
    gpa.free(row.run_id);
    gpa.free(row.action);
    gpa.free(row.l1);
    if (row.l2) |v| gpa.free(v);
    if (row.decided_by) |v| gpa.free(v);
}

test "guard approvals: decide twice, only the first wins" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", 60_000, "pending");
    try testing.expect(try decide(fx.db, "a", .deny, "x", 1000));
    try testing.expect(!try decide(fx.db, "a", .approve, "y", 1001));
    const row = (try get(fx.db, testing.allocator, "a")).?;
    defer freeRow(row);
    try testing.expectEqual(Status.denied, row.status);
    try testing.expectEqualStrings("x", row.decided_by.?);
    try testing.expectEqual(@as(?i64, 1000), row.decided_at);
}

test "guard approvals: decide past expiry fails and marks the row expired" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", 999, "pending");
    try testing.expect(!try decide(fx.db, "a", .approve, "x", 1000));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "a"));
}

test "guard approvals: the expiry instant itself is already too late" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", 1000, "pending");
    try testing.expect(!try decide(fx.db, "a", .approve, "x", 1000));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "a"));
}

test "guard approvals: decide on an unknown id is false" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try testing.expect(!try decide(fx.db, "nope", .approve, "x", 1000));
}

test "guard approvals: a decided row is never rewritten by a late decision or an expiry" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", 2000, "pending");
    try testing.expect(try decide(fx.db, "a", .approve, "x", 1000));
    try testing.expect(!try decide(fx.db, "a", .deny, "y", 3000));
    try testing.expect(!try markExpired(fx.db, "a", null));
    try testing.expectEqual(@as(u32, 0), try expireDue(fx.db, 9000));
    try testing.expectEqual(Status.approved, try statusOf(fx.db, "a"));
}

test "guard approvals: expireDue only touches pending rows past expiry" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "old", 10, "pending");
    try insert(fx.db, "fresh", 1000, "pending");
    try insert(fx.db, "done", 10, "approved");
    try testing.expectEqual(@as(u32, 1), try expireDue(fx.db, 500));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "old"));
    try testing.expectEqual(Status.pending, try statusOf(fx.db, "fresh"));
    try testing.expectEqual(Status.approved, try statusOf(fx.db, "done"));
}

test "guard approvals: markExpired with the timer flag ignores the clock" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", std.math.maxInt(i32), "pending");
    try testing.expect(!try markExpired(fx.db, "a", 1000));
    try testing.expect(try markExpired(fx.db, "a", null));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "a"));
}

test "guard approvals: create stores a pending row that expires after the timeout" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const made = try create(fx.db, testing.io, .{ .run_id = "run-1", .action = "{\"kind\":\"execute\"}", .l1 = "{}", .l2 = "{\"x\":1}", .timeout_ms = 5000 });
    try testing.expectEqual(@as(u8, '7'), made.id[14]);
    const row = (try get(fx.db, testing.allocator, &made.id)).?;
    defer freeRow(row);
    try testing.expectEqual(Status.pending, row.status);
    try testing.expectEqual(made.expires_at, row.expires_at);
    try testing.expectEqual(@as(i64, 5000), row.expires_at - row.created_at);
    try testing.expectEqualStrings("{\"x\":1}", row.l2.?);
    try testing.expectEqual(@as(?[]const u8, null), row.decided_by);
}

test "guard approvals: list filters by status and orders by creation then id" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "b", 10, "pending");
    try insert(fx.db, "a", 10, "pending");
    try insert(fx.db, "c", 10, "denied");
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const all = try list(fx.db, arena.allocator(), null);
    try testing.expectEqual(@as(usize, 3), all.len);
    try testing.expectEqualStrings("a", all[0].id);
    try testing.expectEqualStrings("b", all[1].id);
    const pending = try list(fx.db, arena.allocator(), .pending);
    try testing.expectEqual(@as(usize, 2), pending.len);
    const denied = try list(fx.db, arena.allocator(), .denied);
    try testing.expectEqualStrings("c", denied[0].id);
    try testing.expectEqual(@as(usize, 0), (try list(fx.db, arena.allocator(), .approved)).len);
}

fn seedRun(db: sqlite.Db, id: []const u8, member: ?[]const u8) !void {
    const stmt = try db.prepare("INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try bindOpt(stmt, 2, member);
    _ = try stmt.step();
}

fn insertFor(db: sqlite.Db, id: []const u8, run_id: []const u8) !void {
    const stmt = try db.prepare("INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, '{}', '{}', 'pending', 1, 99999999999999)");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try stmt.bindText(2, run_id);
    _ = try stmt.step();
}

test "guard approvals: expireRun expires a plain run's pending rows and keeps an agent member's" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try seedRun(fx.db, "plain", null);
    try seedRun(fx.db, "agent", "m1");
    try insertFor(fx.db, "p1", "plain");
    try insertFor(fx.db, "p2", "plain");
    try insertFor(fx.db, "a1", "agent");
    try insert(fx.db, "other", 99999999999999, "pending");
    try testing.expectEqual(@as(u32, 2), try expireRun(fx.db, "plain"));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "p1"));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "p2"));
    try testing.expectEqual(@as(u32, 1), try expireRun(fx.db, "agent"));
    try testing.expectEqual(Status.pending, try statusOf(fx.db, "a1"));
    try testing.expectEqual(Status.pending, try statusOf(fx.db, "other"));
    try testing.expectEqual(@as(u32, 0), try expireRun(fx.db, "plain"));
    try testing.expectEqual(@as(u32, 0), try expireRun(fx.db, "unknown-run"));
}

fn viewOf(a: Allocator, action: []const u8, l1: []const u8) !View {
    return view(a, .{ .id = "i", .run_id = "r", .action = action, .l1 = l1, .l2 = null, .status = .pending, .decided_by = null, .created_at = 1, .expires_at = 2, .decided_at = null });
}

test "guard approvals: the view takes the command, else the joined paths, else nothing" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("git push", (try viewOf(a, "{\"command\":\"git push\",\"paths\":[\"x\"]}", "{}")).command);
    try testing.expectEqualStrings("a b", (try viewOf(a, "{\"kind\":\"edit\",\"paths\":[\"a\",\"b\"]}", "{}")).command);
    try testing.expectEqualStrings("", (try viewOf(a, "{\"command\":\"\",\"paths\":[\"x\"]}", "{}")).command);
    try testing.expectEqualStrings("a  1,2 [object Object] true 3", (try viewOf(a, "{\"paths\":[\"a\",null,[1,2],{},true,3]}", "{}")).command);
    try testing.expectEqualStrings("", (try viewOf(a, "{\"command\":5,\"paths\":\"x\"}", "{}")).command);
    try testing.expectEqualStrings("", (try viewOf(a, "not json", "{}")).command);
    try testing.expectEqualStrings("", (try viewOf(a, "[\"x\"]", "{}")).command);
    try testing.expectEqualStrings("last", (try viewOf(a, "{\"command\":\"first\",\"command\":\"last\"}", "{}")).command);
}

test "guard approvals: the view reason is the l1 reason only when it is a string" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("needs a human", (try viewOf(a, "{}", "{\"reason\":\"needs a human\"}")).reason.?);
    try testing.expectEqual(@as(?[]const u8, null), (try viewOf(a, "{}", "{\"reason\":3}")).reason);
    try testing.expectEqual(@as(?[]const u8, null), (try viewOf(a, "{}", "nope")).reason);
}

test "guard approvals: the view JSON has the wire field order" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const v = try view(arena.allocator(), .{
        .id = "i1",
        .run_id = "r1",
        .action = "{\"command\":\"ls \\\"x\\\"\"}",
        .l1 = "{\"reason\":\"why\"}",
        .l2 = null,
        .status = .approved,
        .decided_by = "user:u",
        .created_at = 10,
        .expires_at = 20,
        .decided_at = 15,
    });
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    try writeView(&out.writer, v);
    try testing.expectEqualStrings(
        "{\"id\":\"i1\",\"runId\":\"r1\",\"command\":\"ls \\\"x\\\"\",\"reason\":\"why\",\"status\":\"approved\"," ++
            "\"decidedBy\":\"user:u\",\"createdAt\":10,\"expiresAt\":20,\"decidedAt\":15}",
        out.written(),
    );
    const pending = try viewOf(arena.allocator(), "{}", "{}");
    out.clearRetainingCapacity();
    try writeView(&out.writer, pending);
    try testing.expectEqualStrings(
        "{\"id\":\"i\",\"runId\":\"r\",\"command\":\"\",\"reason\":null,\"status\":\"pending\"," ++
            "\"decidedBy\":null,\"createdAt\":1,\"expiresAt\":2,\"decidedAt\":null}",
        out.written(),
    );
}

test "guard approvals: view building survives every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn run(gpa: Allocator) !void {
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            _ = try viewOf(arena.allocator(), "{\"paths\":[\"a\",[1,2],{}]}", "{\"reason\":\"r\"}");
        }
    }.run, .{});
}

test "guard approvals: list and get survive every allocation failure" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", 10, "pending");
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn run(gpa: Allocator, db: sqlite.Db) !void {
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            _ = try list(db, arena.allocator(), null);
            _ = try get(db, arena.allocator(), "a");
        }
    }.run, .{fx.db});
}

const Later = struct {
    app: *app_mod.App,
    id: []const u8,
    delay_ms: i64,

    fn locked(ctx: Later, state: *app_mod.State) !bool {
        return decide(.{ .handle = state.db.? }, ctx.id, .approve, "user:u", ids.nowMs(testing.io));
    }

    fn run(ctx: Later) void {
        ctx.app.io.sleep(.fromMilliseconds(ctx.delay_ms), .awake) catch return;
        _ = ctx.app.withLock(ctx, locked) catch {};
    }
};

test "guard approvals: a waiting run sees the decision another thread makes" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", ids.nowMs(testing.io) + 60_000, "pending");
    const thread = try std.Thread.spawn(.{}, Later.run, .{Later{ .app = &fx.app, .id = "a", .delay_ms = 80 }});
    defer thread.join();
    const status = try waitForDecision(&fx.app, "a", ids.nowMs(testing.io) + 60_000);
    try testing.expectEqual(Status.approved, status);
}

test "guard approvals: a waiting run that times out marks the row expired" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const soon = ids.nowMs(testing.io) + 120;
    try insert(fx.db, "a", soon, "pending");
    try testing.expectEqual(Status.expired, try waitForDecision(&fx.app, "a", soon));
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "a"));
    try testing.expect(!try decide(fx.db, "a", .approve, "late", ids.nowMs(testing.io)));
}

test "guard approvals: a decided row ends the wait at once and an unknown row counts as expired" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", ids.nowMs(testing.io) + 60_000, "denied");
    try testing.expectEqual(Status.denied, try waitForDecision(&fx.app, "a", 0));
    try testing.expectEqual(Status.expired, try waitForDecision(&fx.app, "missing", 0));
}

test "guard approvals: a wait ends as expired when its run ended, leaving a member's row pending" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try seedRun(fx.db, "agent", "m1");
    try insertFor(fx.db, "a1", "agent");
    try fx.db.exec("UPDATE runs SET ended_at = 5, state = 'killed' WHERE id = 'agent'");
    try testing.expectEqual(Status.expired, try waitForDecision(&fx.app, "a1", ids.nowMs(testing.io) + 60_000));
    try testing.expectEqual(Status.pending, try statusOf(fx.db, "a1"));
}

test "guard approvals: a canceled wait returns error.Canceled and leaves the row alone" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const far = ids.nowMs(testing.io) + 60_000;
    try insert(fx.db, "a", far, "pending");
    var future = try testing.io.concurrent(waitForDecision, .{ &fx.app, "a", far });
    try testing.io.sleep(.fromMilliseconds(120), .awake);
    try testing.expectError(error.Canceled, future.cancel(testing.io));
    try testing.expectEqual(Status.pending, try statusOf(fx.db, "a"));
}

test "guard approvals: the sweep expires rows that are due and stops when canceled" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "due", 1, "pending");
    try insert(fx.db, "later", 99_999_999_999_999, "pending");
    var group: std.Io.Group = .init;
    try group.concurrent(testing.io, sweepLoop, .{&fx.app});
    defer group.cancel(testing.io);
    const Check = struct {
        fn expired(_: void, state: *app_mod.State) Error!bool {
            const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
            const stmt = try db.prepare("SELECT count(*) FROM approvals WHERE status = 'expired'");
            defer stmt.finalize();
            _ = try stmt.step();
            return stmt.int(0) == 1;
        }
    };
    for (0..100) |_| {
        if (try fx.app.withLock({}, Check.expired)) break;
        try testing.io.sleep(.fromMilliseconds(50), .awake);
    } else return error.SweepDidNotRun;
    group.cancel(testing.io);
    try testing.expectEqual(Status.pending, try statusOf(fx.db, "later"));
}

test "guard approvals: the first sweep runs at once, not after the first interval" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "due", 1, "pending");
    var group: std.Io.Group = .init;
    try group.concurrent(testing.io, sweepLoop, .{&fx.app});
    defer group.cancel(testing.io);
    // The interval is 1000 ms: a sweep that waited for it would not have run yet.
    try testing.io.sleep(.fromMilliseconds(sweep_ms / 4), .awake);
    group.cancel(testing.io);
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "due"));
}

test "guard approvals: Links.expire_approvals expires the pending rows of a run without a member" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try insert(fx.db, "a", 99_999_999_999_999, "pending");
    expireForRun(null, fx.db, "r");
    try testing.expectEqual(Status.expired, try statusOf(fx.db, "a"));
}
