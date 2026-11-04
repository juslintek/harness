//! Run tokens, a port of code/src/server/features/mcp/tokens.ts. The row key is the SHA-256 hex of
//! the token, so the raw token is never stored and a lookup compares hashes, not tokens.
const std = @import("std");
const app_mod = @import("../app.zig");
const sessions = @import("../auth/sessions.zig");
const sqlite = @import("../db/sqlite.zig");

const App = app_mod.App;
const State = app_mod.State;

pub const token_len = sessions.token_len;

/// `TokenScope`. `Identity.scopes` keeps the stored text instead: TS casts the parsed JSON and
/// `whoami` prints whatever a row holds.
pub const Scope = enum { report, guard_hook, board, chat, approvals_decide, interview, hiring, profile, policy, memory };

/// `TokenHolder`.
pub const Holder = union(enum) {
    none,
    member: struct { member_id: []const u8, org_id: []const u8 },
    /// An interview run: a candidate has no member, so no member tool accepts the token.
    candidate: struct { candidate_id: []const u8, org_id: []const u8 },
};

/// `RunIdentity`. The strings belong to the allocator given to `verify`.
pub const Identity = struct {
    run_id: []const u8,
    scopes: []const []const u8,
    member_id: ?[]const u8,
    org_id: ?[]const u8,
    candidate_id: ?[]const u8,

    pub fn hasScope(identity: Identity, scope: []const u8) bool {
        for (identity.scopes) |held| if (std.mem.eql(u8, held, scope)) return true;
        return false;
    }
};

pub const Error = sqlite.Error || std.mem.Allocator.Error || error{
    /// Called before the boot installed the connection, or after teardown.
    NoDatabase,
    EntropyUnavailable,
    /// `mint` for a member that is missing or belongs to another org.
    MemberNotInOrg,
    /// A stored `scopes` value that is not a JSON array of strings.
    CorruptRow,
};

fn dbOf(state: *State) Error!sqlite.Db {
    return .{ .handle = state.db orelse return error.NoDatabase };
}

const MintArgs = struct {
    hash: []const u8,
    run_id: []const u8,
    scopes_json: []const u8,
    holder: Holder,
    now: i64,
};

fn mintLocked(args: *const MintArgs, state: *State) Error!void {
    const db = try dbOf(state);
    if (args.holder == .member) {
        const member = try db.prepare("SELECT org_id FROM members WHERE id = ?");
        defer member.finalize();
        try member.bindText(1, args.holder.member.member_id);
        if (!try member.step()) return error.MemberNotInOrg;
        const org = (try member.text(0)) orelse return error.MemberNotInOrg;
        if (!std.mem.eql(u8, org, args.holder.member.org_id)) return error.MemberNotInOrg;
    }
    const stmt = try db.prepare(
        "INSERT INTO run_tokens (hash, run_id, scopes, created_at, member_id, org_id, candidate_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    defer stmt.finalize();
    try stmt.bindText(1, args.hash);
    try stmt.bindText(2, args.run_id);
    try stmt.bindText(3, args.scopes_json);
    try stmt.bindInt(4, args.now);
    switch (args.holder) {
        .none => {
            try stmt.bindNull(5);
            try stmt.bindNull(6);
            try stmt.bindNull(7);
        },
        .member => |m| {
            try stmt.bindText(5, m.member_id);
            try stmt.bindText(6, m.org_id);
            try stmt.bindNull(7);
        },
        .candidate => |c| {
            try stmt.bindNull(5);
            try stmt.bindText(6, c.org_id);
            try stmt.bindText(7, c.candidate_id);
        },
    }
    _ = try stmt.step();
}

/// `mint`: 32 random bytes, base64url. The member-org check runs in the same lock as the insert,
/// so a member cannot be moved between the two.
pub fn mint(app: *App, run_id: []const u8, scopes: []const Scope, holder: Holder, now: i64) Error![token_len]u8 {
    const token = try sessions.newToken(app.io);
    var scopes_json: std.ArrayList(u8) = .empty;
    defer scopes_json.deinit(app.gpa);
    try scopes_json.append(app.gpa, '[');
    for (scopes, 0..) |scope, i| {
        if (i > 0) try scopes_json.append(app.gpa, ',');
        try scopes_json.append(app.gpa, '"');
        try scopes_json.appendSlice(app.gpa, @tagName(scope));
        try scopes_json.append(app.gpa, '"');
    }
    try scopes_json.append(app.gpa, ']');
    const hash = sessions.tokenHash(&token);
    try app.withLock(&MintArgs{ .hash = &hash, .run_id = run_id, .scopes_json = scopes_json.items, .holder = holder, .now = now }, mintLocked);
    return token;
}

const VerifyArgs = struct { alloc: std.mem.Allocator, hash: []const u8 };

fn dupeOpt(alloc: std.mem.Allocator, stmt: sqlite.Stmt, column: c_int) Error!?[]const u8 {
    return try stmt.textAlloc(alloc, column);
}

fn verifyLocked(args: *const VerifyArgs, state: *State) Error!?Identity {
    const db = try dbOf(state);
    const stmt = try db.prepare("SELECT run_id, scopes, member_id, org_id, candidate_id FROM run_tokens WHERE hash = ?");
    defer stmt.finalize();
    try stmt.bindText(1, args.hash);
    if (!try stmt.step()) return null;
    const run_id = (try dupeOpt(args.alloc, stmt, 0)) orelse return error.CorruptRow;
    const scopes_text = (try dupeOpt(args.alloc, stmt, 1)) orelse return error.CorruptRow;
    const scopes = std.json.parseFromSliceLeaky([]const []const u8, args.alloc, scopes_text, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.CorruptRow,
    };
    return .{
        .run_id = run_id,
        .scopes = scopes,
        .member_id = try dupeOpt(args.alloc, stmt, 2),
        .org_id = try dupeOpt(args.alloc, stmt, 3),
        .candidate_id = try dupeOpt(args.alloc, stmt, 4),
    };
}

/// `verify`: null for an unknown or revoked token. Allocates the result in `alloc` (a request arena).
pub fn verify(app: *App, alloc: std.mem.Allocator, token: []const u8) Error!?Identity {
    const hash = sessions.tokenHash(token);
    return app.withLock(&VerifyArgs{ .alloc = alloc, .hash = &hash }, verifyLocked);
}

fn revokeLocked(run_id: []const u8, state: *State) Error!void {
    const db = try dbOf(state);
    const stmt = try db.prepare("DELETE FROM run_tokens WHERE run_id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, run_id);
    _ = try stmt.step();
}

/// `revoke`: deleted rather than flagged, so `verify` finds nothing, as for a token never minted.
pub fn revoke(app: *App, run_id: []const u8) Error!void {
    return app.withLock(run_id, revokeLocked);
}

/// For `Links.release_run`, which already holds the lock and a connection.
pub fn revokeIn(db: sqlite.Db, run_id: []const u8) sqlite.Error!void {
    const stmt = try db.prepare("DELETE FROM run_tokens WHERE run_id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, run_id);
    _ = try stmt.step();
}

// ---- tests (tokens.test.ts) ----

const Fixture = @import("../auth/fixture.zig").Fixture;
const testing = std.testing;
const t0: i64 = 1_700_000_000_000;

fn scalar(fx: *Fixture, comptime sql: [:0]const u8) !i64 {
    const stmt = try fx.db.prepare(sql);
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    return stmt.int(0);
}

test "mcp: a minted token verifies, a revoked or random one does not" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const token = try mint(&fx.app, "run-1", &.{.report}, .none, t0);
    const identity = (try verify(&fx.app, arena.allocator(), &token)).?;
    try testing.expectEqualStrings("run-1", identity.run_id);
    try testing.expectEqual(@as(usize, 1), identity.scopes.len);
    try testing.expect(identity.hasScope("report") and !identity.hasScope("board"));
    try testing.expect(identity.member_id == null and identity.org_id == null and identity.candidate_id == null);
    try testing.expect((try verify(&fx.app, arena.allocator(), "not-a-token")) == null);
    try testing.expect((try verify(&fx.app, arena.allocator(), "")) == null);
    try revoke(&fx.app, "run-1");
    try testing.expect((try verify(&fx.app, arena.allocator(), &token)) == null);
}

test "mcp: revoking deletes the rows of that run only" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    _ = try mint(&fx.app, "run-3", &.{.report}, .none, t0);
    _ = try mint(&fx.app, "run-3", &.{.guard_hook}, .none, t0);
    const other = try mint(&fx.app, "run-4", &.{.report}, .none, t0);
    try revoke(&fx.app, "run-3");
    try testing.expectEqual(@as(i64, 1), try scalar(fx, "SELECT count(*) FROM run_tokens"));
    try testing.expect((try verify(&fx.app, arena.allocator(), &other)) != null);
}

test "mcp: the database holds only the hash" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const token = try mint(&fx.app, "run-2", &.{ .report, .guard_hook }, .none, t0);
    const stmt = try fx.db.prepare("SELECT hash, run_id, scopes, created_at FROM run_tokens");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqualStrings(&sessions.tokenHash(&token), (try stmt.text(0)).?);
    try testing.expectEqualStrings("[\"report\",\"guard_hook\"]", (try stmt.text(2)).?);
    try testing.expectEqual(t0, stmt.int(3));
    try testing.expect(!try stmt.step());
}

fn seedMember(fx: *Fixture, comptime org: []const u8, comptime member: []const u8) !void {
    try fx.run("INSERT INTO orgs (id, name, slug, created_at) VALUES ('" ++ org ++ "', '" ++ org ++ "', '" ++ org ++ "', 1)");
    try fx.run("INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('" ++
        member ++ "', '" ++ org ++ "', 'agent', 'a', '" ++ member ++ "', '" ++ member ++ "', 'member', 1)");
}

test "mcp: a token cannot bind a member to an org it does not belong to" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try seedMember(fx, "org-a", "m-a");
    try seedMember(fx, "org-b", "m-b");
    try testing.expectError(error.MemberNotInOrg, mint(&fx.app, "r", &.{.board}, .{ .member = .{ .member_id = "m-a", .org_id = "org-b" } }, t0));
    try testing.expectError(error.MemberNotInOrg, mint(&fx.app, "r", &.{.board}, .{ .member = .{ .member_id = "ghost", .org_id = "org-a" } }, t0));
    try testing.expectEqual(@as(i64, 0), try scalar(fx, "SELECT count(*) FROM run_tokens"));
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const token = try mint(&fx.app, "r", &.{.board}, .{ .member = .{ .member_id = "m-a", .org_id = "org-a" } }, t0);
    const identity = (try verify(&fx.app, arena.allocator(), &token)).?;
    try testing.expectEqualStrings("m-a", identity.member_id.?);
    try testing.expectEqualStrings("org-a", identity.org_id.?);
}

test "mcp: any number of scopes can be minted" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const many: [60]Scope = @splat(.policy);
    const token = try mint(&fx.app, "r", &many, .none, t0);
    try testing.expectEqual(@as(usize, 60), (try verify(&fx.app, arena.allocator(), &token)).?.scopes.len);
}

test "mcp: a candidate token carries the candidate and no member" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const token = try mint(&fx.app, "r", &.{.interview}, .{ .candidate = .{ .candidate_id = "c1", .org_id = "o1" } }, t0);
    const identity = (try verify(&fx.app, arena.allocator(), &token)).?;
    try testing.expect(identity.member_id == null);
    try testing.expectEqualStrings("c1", identity.candidate_id.?);
}

test "mcp: a row with unreadable scopes is an error, not a token with no scopes" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const hash = sessions.tokenHash("raw");
    const insert = try std.fmt.allocPrintSentinel(testing.allocator, "INSERT INTO run_tokens (hash, run_id, scopes, created_at) VALUES ('{s}', 'r', 'not json', 1)", .{hash}, 0);
    defer testing.allocator.free(insert);
    try fx.db.exec(insert);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectError(error.CorruptRow, verify(&fx.app, arena.allocator(), "raw"));
}
