//! Session rows, a port of code/src/server/features/auth/sessions.ts. Every function that takes an
//! `App` locks it for the SQL and nothing else; the `now` argument is the caller's clock reading in
//! epoch ms, so expiry rules are testable without waiting. Only the SHA-256 of a token is stored.
const std = @import("std");
const app_mod = @import("../app.zig");
const ids = @import("../ids.zig");
const sqlite = @import("../db/sqlite.zig");

const App = app_mod.App;
const State = app_mod.State;
const Sha256 = std.crypto.hash.sha2.Sha256;

const day_ms: i64 = 24 * 60 * 60 * 1000;
/// SESSION_TTL_MS
pub const ttl_ms: i64 = 30 * day_ms;
/// SLIDE_EVERY_MS
pub const slide_every_ms: i64 = 60 * 60 * 1000;
/// STEP_UP_MS
pub const step_up_ms: i64 = 5 * 60 * 1000;

pub const token_len = std.base64.url_safe_no_pad.Encoder.calcSize(32);

pub const Method = enum { passkey, email, recovery, enroll };

pub const Error = sqlite.Error || error{
    /// Called before the boot installed the connection, or after teardown.
    NoDatabase,
    /// The CHECK constraint on `sessions.method` makes this unreachable unless the file was edited.
    CorruptRow,
    EntropyUnavailable,
};

/// `Session` of sessions.ts. The strings belong to the allocator given to `lookup`, which should
/// be a request arena.
pub const Session = struct {
    id: []const u8,
    user_id: []const u8,
    method: Method,
    step_up_at: ?i64,
    instance_admin: bool,
    /// Set only on the lookup that moved `expires_at`, so the cookie can follow it.
    slid: bool,
};

pub const NewSession = struct {
    user_id: []const u8,
    method: Method,
    user_agent: ?[]const u8,
};

pub const Created = struct {
    token: [token_len]u8,
    id: [ids.uuid_len]u8,
};

/// `sha256Hex`: 64 lowercase hex characters.
pub fn tokenHash(token: []const u8) [Sha256.digest_length * 2]u8 {
    var digest: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(token, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

/// 32 bytes from the OS entropy source, base64url without padding (`Buffer.toString("base64url")`).
pub fn newToken(io: std.Io) Error![token_len]u8 {
    var raw: [32]u8 = undefined;
    io.randomSecure(&raw) catch return error.EntropyUnavailable;
    var token: [token_len]u8 = undefined;
    _ = std.base64.url_safe_no_pad.Encoder.encode(&token, &raw);
    return token;
}

/// `hasFreshStepUp`: a step-up younger than five minutes. A stamp in the future counts as fresh,
/// as it does in TS.
pub fn hasFreshStepUp(step_up_at: ?i64, now: i64) bool {
    const at = step_up_at orelse return false;
    return now -| at < step_up_ms;
}

fn dbOf(state: *State) Error!sqlite.Db {
    return .{ .handle = state.db orelse return error.NoDatabase };
}

// ---- createSession ----

pub const InsertArgs = struct {
    id: [ids.uuid_len]u8,
    hash: [64]u8,
    input: NewSession,
    now: i64,
};

fn insertLocked(args: *const InsertArgs, state: *State) Error!void {
    return insertRow(try dbOf(state), args);
}

/// The INSERT of `createSession`, for a caller that holds the lock and its own transaction.
pub fn insertRow(db: sqlite.Db, args: *const InsertArgs) Error!void {
    const stmt = try db.prepare(
        \\INSERT INTO sessions
        \\  (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at)
        \\VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    );
    defer stmt.finalize();
    try stmt.bindText(1, &args.id);
    try stmt.bindText(2, args.input.user_id);
    try stmt.bindText(3, &args.hash);
    try stmt.bindText(4, @tagName(args.input.method));
    if (args.input.user_agent) |agent| try stmt.bindText(5, agent) else try stmt.bindNull(5);
    try stmt.bindInt(6, args.now);
    try stmt.bindInt(7, args.now);
    try stmt.bindInt(8, args.now +| ttl_ms);
    // Recovery and enrollment prove possession of a one-time secret; an email code never unlocks
    // dangerous actions.
    const proves_possession = args.input.method == .recovery or args.input.method == .enroll;
    if (proves_possession) try stmt.bindInt(9, args.now) else try stmt.bindNull(9);
    _ = try stmt.step();
}

/// `createSession`. The raw token is returned once and never stored.
pub fn create(app: *App, input: NewSession, now: i64) Error!Created {
    const token = try newToken(app.io);
    const id = ids.uuidV7(app.io);
    const args: InsertArgs = .{ .id = id, .hash = tokenHash(&token), .input = input, .now = now };
    try app.withLock(&args, insertLocked);
    return .{ .token = token, .id = id };
}

// ---- sessionFromToken ----

const LookupArgs = struct {
    alloc: std.mem.Allocator,
    hash: [64]u8,
    now: i64,
};

const Row = struct {
    id: []const u8,
    user_id: []const u8,
    method: Method,
    step_up_at: ?i64,
    last_seen_at: i64,
    instance_admin: bool,
};

/// Strings are copied into `alloc`; the statement is finished before this returns.
fn selectRow(db: sqlite.Db, args: *const LookupArgs) Error!?Row {
    const stmt = try db.prepare(
        \\SELECT s.id, s.user_id, s.method, s.step_up_at, s.last_seen_at, u.instance_admin
        \\  FROM sessions s JOIN users u ON u.id = s.user_id
        \\ WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, &args.hash);
    try stmt.bindInt(2, args.now);
    if (!try stmt.step()) return null;
    const id = try stmt.textAlloc(args.alloc, 0) orelse return error.CorruptRow;
    errdefer args.alloc.free(id);
    const user_id = try stmt.textAlloc(args.alloc, 1) orelse return error.CorruptRow;
    errdefer args.alloc.free(user_id);
    const method_text = try stmt.text(2) orelse return error.CorruptRow;
    return .{
        .id = id,
        .user_id = user_id,
        .method = std.meta.stringToEnum(Method, method_text) orelse return error.CorruptRow,
        .step_up_at = if (stmt.isNull(3)) null else stmt.int(3),
        .last_seen_at = stmt.int(4),
        .instance_admin = stmt.int(5) == 1,
    };
}

fn lookupLocked(args: *const LookupArgs, state: *State) Error!?Session {
    const db = try dbOf(state);
    const row = try selectRow(db, args) orelse return null;
    errdefer args.alloc.free(row.id);
    errdefer args.alloc.free(row.user_id);
    const slid = args.now -| row.last_seen_at >= slide_every_ms;
    if (slid) {
        const stmt = try db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?");
        defer stmt.finalize();
        try stmt.bindInt(1, args.now);
        try stmt.bindInt(2, args.now +| ttl_ms);
        try stmt.bindText(3, row.id);
        _ = try stmt.step();
    }
    return .{
        .id = row.id,
        .user_id = row.user_id,
        .method = row.method,
        .step_up_at = row.step_up_at,
        .instance_admin = row.instance_admin,
        .slid = slid,
    };
}

/// `sessionFromToken`: null for an unknown, revoked or lapsed token. A found session that was last
/// seen an hour or more ago has its expiry moved to `now` plus thirty days.
pub fn lookup(app: *App, alloc: std.mem.Allocator, token: []const u8, now: i64) Error!?Session {
    const args: LookupArgs = .{ .alloc = alloc, .hash = tokenHash(token), .now = now };
    return app.withLock(&args, lookupLocked);
}

// ---- sessionExpiresAt ----

const ExpiryArgs = struct { session_id: []const u8, now: i64 };

fn expiresAtLocked(args: *const ExpiryArgs, state: *State) Error!?i64 {
    const db = try dbOf(state);
    const stmt = try db.prepare("SELECT expires_at FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?");
    defer stmt.finalize();
    try stmt.bindText(1, args.session_id);
    try stmt.bindInt(2, args.now);
    if (!try stmt.step()) return null;
    return stmt.int(0);
}

/// `sessionExpiresAt`: null once the session is revoked or lapsed. A long-lived socket re-reads it
/// because other requests slide the expiry.
pub fn expiresAt(app: *App, session_id: []const u8, now: i64) Error!?i64 {
    return app.withLock(&ExpiryArgs{ .session_id = session_id, .now = now }, expiresAtLocked);
}

// ---- revokeSession ----

const RevokeArgs = struct { user_id: []const u8, session_id: []const u8, now: i64 };

fn revokeLocked(args: *const RevokeArgs, state: *State) Error!bool {
    const db = try dbOf(state);
    // RETURNING stands in for `changes > 0`; the wrapper does not expose sqlite3_changes.
    const stmt = try db.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL RETURNING id",
    );
    defer stmt.finalize();
    try stmt.bindInt(1, args.now);
    try stmt.bindText(2, args.session_id);
    try stmt.bindText(3, args.user_id);
    const revoked = try stmt.step();
    while (try stmt.step()) {}
    return revoked;
}

/// `revokeSession`: true when this call moved the session to revoked. The next lookup of its token
/// finds nothing, because both the lookup and the revoke run under the one state lock.
pub fn revoke(app: *App, user_id: []const u8, session_id: []const u8, now: i64) Error!bool {
    return app.withLock(&RevokeArgs{ .user_id = user_id, .session_id = session_id, .now = now }, revokeLocked);
}

test {
    _ = @import("sessions_test.zig");
}
