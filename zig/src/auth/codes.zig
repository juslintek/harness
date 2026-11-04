//! Users, recovery codes, email codes and enrollment codes, a port of
//! code/src/server/features/auth/{codes,users}.ts. Every public function takes the `App` and holds
//! the state lock for its SQL only; `now` is the caller's clock reading in epoch ms so windows and
//! expiry are testable without waiting. Codes are stored as the SHA-256 of what was shown.
const std = @import("std");
const builtin = @import("builtin");
const app_mod = @import("../app.zig");
const ids = @import("../ids.zig");
const parity = @import("../parity.zig");
const sqlite = @import("../db/sqlite.zig");
const sessions = @import("sessions.zig");

const App = app_mod.App;
const State = app_mod.State;
const Allocator = std.mem.Allocator;

pub const Error = sessions.Error;

/// Tests set this to make code generation fail as an unavailable entropy source would.
pub var entropy_down_for_test = false;

const minute_ms: i64 = 60 * 1000;
const email_code_ttl_ms = 10 * minute_ms;
const email_window_ms = 15 * minute_ms;
const email_max_per_window = 3;
const email_max_attempts = 5;
/// CLAIM_TTL_MS: a claim left by a crashed request expires.
pub const claim_ttl_ms: i64 = 60_000;

pub const recovery_count = 10;
pub const recovery_groups = 3;
pub const enrollment_groups = 4;
pub const RecoveryCode = [recovery_groups * 5 - 1]u8;
pub const RecoveryCodes = [recovery_count]RecoveryCode;
pub const EnrollmentCode = [enrollment_groups * 5 - 1]u8;
pub const EmailCode = [6]u8;

// ---- running SQL under the lock ----

fn ReturnOf(comptime f: anytype) type {
    return @typeInfo(@TypeOf(f)).@"fn".return_type.?;
}

/// Runs `f(db, args)` under the state lock. `f` returns `Error!T`.
pub fn run(app: *App, args: anytype, comptime f: anytype) ReturnOf(f) {
    const Args = @TypeOf(args);
    const Shim = struct {
        fn call(a: *const Args, state: *State) ReturnOf(f) {
            const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
            return f(db, a.*);
        }
    };
    return app.withLock(&args, Shim.call);
}

/// Like `run`, between BEGIN IMMEDIATE and COMMIT; an error rolls back.
pub fn runTx(app: *App, args: anytype, comptime f: anytype) ReturnOf(f) {
    const Args = @TypeOf(args);
    const Shim = struct {
        fn inner(a: Args, db: sqlite.Db) ReturnOf(f) {
            return f(db, a);
        }
        fn call(a: *const Args, state: *State) ReturnOf(f) {
            const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
            return db.transaction(a.*, inner);
        }
    };
    return app.withLock(&args, Shim.call);
}

pub const Param = union(enum) {
    text: []const u8,
    int: i64,
    none,

    pub fn opt(value: ?[]const u8) Param {
        return if (value) |text| .{ .text = text } else .none;
    }

    fn bind(param: Param, stmt: sqlite.Stmt, index: c_int) sqlite.Error!void {
        switch (param) {
            .text => |text| try stmt.bindText(index, text),
            .int => |n| try stmt.bindInt(index, n),
            .none => try stmt.bindNull(index),
        }
    }
};

pub fn prepared(db: sqlite.Db, sql: []const u8, params: []const Param) Error!sqlite.Stmt {
    const stmt = try db.prepare(sql);
    errdefer stmt.finalize();
    for (params, 1..) |param, index| try param.bind(stmt, @intCast(index));
    return stmt;
}

/// Runs a statement that returns no rows.
pub fn execute(db: sqlite.Db, sql: []const u8, params: []const Param) Error!void {
    const stmt = try prepared(db, sql, params);
    defer stmt.finalize();
    while (try stmt.step()) {}
}

/// Runs an UPDATE or DELETE that ends in RETURNING and says how many rows it touched. The
/// wrapper does not expose sqlite3_changes, and `changes === 1` is what TS checks.
pub fn touched(db: sqlite.Db, sql: []const u8, params: []const Param) Error!usize {
    const stmt = try prepared(db, sql, params);
    defer stmt.finalize();
    var n: usize = 0;
    while (try stmt.step()) n += 1;
    return n;
}

pub fn exists(db: sqlite.Db, sql: []const u8, params: []const Param) Error!bool {
    const stmt = try prepared(db, sql, params);
    defer stmt.finalize();
    return stmt.step();
}

// ---- signing in ----

/// A session prepared before the transaction that spends the credential, so the row goes in with
/// the spend and nothing that can fail is left for after the commit.
pub const PlannedSession = struct {
    token: [sessions.token_len]u8,
    id: [ids.uuid_len]u8,
    method: sessions.Method,
    user_agent: ?[]const u8,
    now: i64,
};

pub fn planSession(io: std.Io, method: sessions.Method, user_agent: ?[]const u8, now: i64) error{EntropyUnavailable}!PlannedSession {
    if (builtin.is_test and entropy_down_for_test) return error.EntropyUnavailable;
    return .{ .token = sessions.newToken(io) catch return error.EntropyUnavailable, .id = ids.uuidV7(io), .method = method, .user_agent = user_agent, .now = now };
}

/// `ensurePersonalOrg`, run inside the sign-in transaction (the lock is held, so it works on `db`
/// directly): every way in ends with it, so the personal org exists whichever method the user
/// used first. The orgs slice installs it before the listener starts; until it does, signing in
/// creates no org. A failure rolls the whole sign-in back.
pub const PersonalOrgHook = *const fn (db: sqlite.Db, io: std.Io, alloc: Allocator, user: User) Error!void;
pub var personal_org_hook: ?PersonalOrgHook = null;

pub const SignIn = struct { plan: PlannedSession, user: User, io: std.Io, alloc: Allocator };

/// The session row and the personal org; caller holds the lock and the transaction.
pub fn signInInTx(db: sqlite.Db, s: SignIn) Error!void {
    try sessions.insertRow(db, &.{
        .id = s.plan.id,
        .hash = sessions.tokenHash(&s.plan.token),
        .input = .{ .user_id = s.user.id, .method = s.plan.method, .user_agent = s.plan.user_agent },
        .now = s.plan.now,
    });
    if (personal_org_hook) |hook| try hook(db, s.io, s.alloc, s.user);
}

/// A sign-in that spends nothing (a passkey login): the row and the org in one transaction.
pub fn signInNow(app: *App, s: SignIn) Error!void {
    try runTx(app, s, signInInTx);
}

// ---- users ----

/// `User` of users.ts, in the key order the routes send it.
pub const User = struct {
    id: []const u8,
    email: []const u8,
    name: []const u8,
    instanceAdmin: bool,
    createdAt: i64,
};

fn readUser(stmt: sqlite.Stmt, alloc: Allocator) Error!User {
    return .{
        .id = try stmt.textAlloc(alloc, 0) orelse return error.CorruptRow,
        .email = try stmt.textAlloc(alloc, 1) orelse return error.CorruptRow,
        .name = try stmt.textAlloc(alloc, 2) orelse return error.CorruptRow,
        .instanceAdmin = stmt.int(3) == 1,
        .createdAt = stmt.int(4),
    };
}

const user_columns = "SELECT id, email, name, instance_admin, created_at FROM users";

pub fn userByEmail(db: sqlite.Db, alloc: Allocator, email: []const u8) Error!?User {
    // The column is COLLATE NOCASE, so the comparison is too.
    const stmt = try prepared(db, user_columns ++ " WHERE email = ?", &.{.{ .text = email }});
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    return try readUser(stmt, alloc);
}

pub fn userById(db: sqlite.Db, alloc: Allocator, id: []const u8) Error!?User {
    const stmt = try prepared(db, user_columns ++ " WHERE id = ?", &.{.{ .text = id }});
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    return try readUser(stmt, alloc);
}

const UserKey = struct { alloc: Allocator, key: []const u8 };

fn userByEmailLocked(db: sqlite.Db, a: UserKey) Error!?User {
    return userByEmail(db, a.alloc, a.key);
}

fn userByIdLocked(db: sqlite.Db, a: UserKey) Error!?User {
    return userById(db, a.alloc, a.key);
}

/// `findUserByEmail`. Strings belong to `alloc`, which should be a request arena.
pub fn findUserByEmail(app: *App, alloc: Allocator, email: []const u8) Error!?User {
    return run(app, UserKey{ .alloc = alloc, .key = email }, userByEmailLocked);
}

/// `getUser`.
pub fn getUser(app: *App, alloc: Allocator, id: []const u8) Error!?User {
    return run(app, UserKey{ .alloc = alloc, .key = id }, userByIdLocked);
}

pub const NewUser = struct { email: []const u8, name: []const u8, instance_admin: bool };

/// `createUser`; the caller holds the lock.
pub fn insertUser(db: sqlite.Db, io: std.Io, profile: NewUser) Error![ids.uuid_len]u8 {
    const id = ids.uuidV7(io);
    try execute(
        db,
        "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, ?, ?)",
        &.{
            .{ .text = &id },
            .{ .text = profile.email },
            .{ .text = profile.name },
            .{ .int = @intFromBool(profile.instance_admin) },
            .{ .int = ids.nowMs(io) },
        },
    );
    return id;
}

// ---- random codes ----

const base32 = "abcdefghijklmnopqrstuvwxyz234567";

/// Groups of four base32 symbols joined by dashes. 32 symbols divide 256 evenly, so masking a
/// random byte has no modulo bias.
fn randomCode(io: std.Io, comptime groups: usize) error{EntropyUnavailable}![groups * 5 - 1]u8 {
    var bytes: [groups * 4]u8 = undefined;
    if (builtin.is_test and entropy_down_for_test) return error.EntropyUnavailable;
    io.randomSecure(&bytes) catch return error.EntropyUnavailable;
    var out: [groups * 5 - 1]u8 = undefined;
    for (0..groups) |group| {
        for (0..4) |i| out[group * 5 + i] = base32[bytes[group * 4 + i] & 31];
        if (group + 1 < groups) out[group * 5 + 4] = '-';
    }
    return out;
}

/// `code.trim().toLowerCase()`; null for bytes that are not UTF-8, which cannot match any code.
fn normalizeCode(alloc: Allocator, code: []const u8) Allocator.Error!?[]const u8 {
    return parity.jsLowerEmail(alloc, parity.jsTrim(code)) catch |err| switch (err) {
        error.InvalidUtf8 => null,
        error.OutOfMemory => error.OutOfMemory,
    };
}

// ---- recovery codes ----

pub const RecoveryArgs = struct { user_id: []const u8, codes: *const RecoveryCodes };

pub fn replaceRecovery(db: sqlite.Db, a: RecoveryArgs) Error!void {
    try execute(db, "DELETE FROM recovery_codes WHERE user_id = ?", &.{.{ .text = a.user_id }});
    for (a.codes) |*code| try execute(
        db,
        "INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)",
        &.{ .{ .text = a.user_id }, .{ .text = &sessions.tokenHash(code) } },
    );
}

/// Ten fresh codes, not stored yet.
pub fn drawRecoveryCodes(io: std.Io) error{EntropyUnavailable}!RecoveryCodes {
    var codes: RecoveryCodes = undefined;
    for (&codes) |*code| code.* = try randomCode(io, recovery_groups);
    return codes;
}

/// Stores a drawn set, replacing the user's old one.
pub fn storeRecoveryCodes(app: *App, user_id: []const u8, set: *const RecoveryCodes) Error!void {
    try runTx(app, RecoveryArgs{ .user_id = user_id, .codes = set }, replaceRecovery);
}

/// `newRecoveryCodes`: ten fresh codes replace the user's old set.
pub fn newRecoveryCodes(app: *App, user_id: []const u8) Error!RecoveryCodes {
    var codes = try drawRecoveryCodes(app.io);
    try runTx(app, RecoveryArgs{ .user_id = user_id, .codes = &codes }, replaceRecovery);
    return codes;
}

/// The codes as slices for JSON; they point into `codes`.
pub fn recoverySlices(codes: *const RecoveryCodes) [recovery_count][]const u8 {
    var out: [recovery_count][]const u8 = undefined;
    for (&out, codes) |*slot, *code| slot.* = code;
    return out;
}

const UseRecoveryArgs = struct { alloc: Allocator, email: []const u8, hash: [64]u8, now: i64, signin: ?SignIn };

fn useRecoveryLocked(db: sqlite.Db, a: UseRecoveryArgs) Error!?[]const u8 {
    const user = try userByEmail(db, a.alloc, a.email);
    // An unknown address runs the same statement against no user and makes the same three
    // allocations a found one does, so neither the work nor its count tells.
    if (user == null) for (0..3) |_| {
        _ = try a.alloc.dupe(u8, "-");
    };
    const used = try touched(
        db,
        "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL RETURNING 1",
        &.{ .{ .int = a.now }, .{ .text = if (user) |known| known.id else "" }, .{ .text = &a.hash } },
    );
    if (used != 1) return null;
    if (a.signin) |s| try signInInTx(db, s);
    return user.?.id;
}

/// `useRecoveryCode`: the user's id, once per code.
pub fn useRecoveryCode(app: *App, alloc: Allocator, email: []const u8, code: []const u8, now: i64) Error!?[]const u8 {
    return useRecoveryCodeWith(app, alloc, email, code, now, null);
}

/// `useRecoveryCode` that also stores the session in the transaction that spends the code, so a
/// failure after the spend cannot cost the user the code.
pub fn useRecoveryCodeWith(app: *App, alloc: Allocator, email: []const u8, code: []const u8, now: i64, signin: ?SignIn) Error!?[]const u8 {
    const normalized = try normalizeCode(alloc, code) orelse return null;
    return runTx(app, UseRecoveryArgs{ .alloc = alloc, .email = email, .hash = sessions.tokenHash(normalized), .now = now, .signin = signin }, useRecoveryLocked);
}

// ---- email codes ----

pub const EmailRequest = struct {
    /// False when the address has had three codes in fifteen minutes.
    allowed: bool,
    /// True only for an address that belongs to a user. Unknown ones get a stored, never
    /// delivered code, so the limit and the reply look the same.
    deliver: bool,
    code: EmailCode,
};

/// `randomInt(0, 1_000_000)` padded to six digits, by rejection so no digit is likelier.
fn randomEmailCode(io: std.Io) error{EntropyUnavailable}!EmailCode {
    const limit: u32 = 4_294_000_000;
    while (true) {
        var bytes: [4]u8 = undefined;
        io.randomSecure(&bytes) catch return error.EntropyUnavailable;
        const n = std.mem.readInt(u32, &bytes, .little);
        if (n >= limit) continue;
        var out: EmailCode = undefined;
        _ = std.fmt.bufPrint(&out, "{d:0>6}", .{n % 1_000_000}) catch unreachable;
        return out;
    }
}

const RequestArgs = struct { alloc: Allocator, io: std.Io, email: []const u8, code: EmailCode, now: i64 };

fn requestLocked(db: sqlite.Db, a: RequestArgs) Error!EmailRequest {
    try execute(db, "DELETE FROM email_codes WHERE created_at < ?", &.{.{ .int = a.now - email_window_ms }});
    const count = blk: {
        const stmt = try prepared(db, "SELECT count(*) AS n FROM email_codes WHERE email = ?", &.{.{ .text = a.email }});
        defer stmt.finalize();
        break :blk if (try stmt.step()) stmt.int(0) else 0;
    };
    if (count >= email_max_per_window) return .{ .allowed = false, .deliver = false, .code = a.code };
    try execute(db, "UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL", &.{ .{ .int = a.now }, .{ .text = a.email } });
    const id = ids.uuidV7(a.io);
    try execute(
        db,
        "INSERT INTO email_codes (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        &.{
            .{ .text = &id },
            .{ .text = a.email },
            .{ .text = &sessions.tokenHash(&a.code) },
            .{ .int = a.now },
            .{ .int = a.now + email_code_ttl_ms },
        },
    );
    const known = try userByEmail(db, a.alloc, a.email) != null;
    return .{ .allowed = true, .deliver = known, .code = a.code };
}

/// `requestEmailCode`. The count and the insert share one transaction so concurrent requests
/// cannot both pass the limit. The caller delivers the code when `deliver` is set.
pub fn requestEmailCode(app: *App, alloc: Allocator, email: []const u8, now: i64) Error!EmailRequest {
    const code = try randomEmailCode(app.io);
    return runTx(app, RequestArgs{ .alloc = alloc, .io = app.io, .email = email, .code = code, .now = now }, requestLocked);
}

const VerifyArgs = struct { alloc: Allocator, email: []const u8, hash: [64]u8, now: i64, signin: ?SignIn };

fn verifyEmailLocked(db: sqlite.Db, a: VerifyArgs) Error!?[]const u8 {
    var stored: [64]u8 = undefined;
    var row_id: [ids.uuid_len]u8 = undefined;
    {
        const stmt = try prepared(
            db,
            \\SELECT id, code_hash FROM email_codes
            \\ WHERE email = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
            \\ ORDER BY created_at DESC, rowid DESC LIMIT 1
        ,
            &.{ .{ .text = a.email }, .{ .int = a.now }, .{ .int = email_max_attempts } },
        );
        defer stmt.finalize();
        if (!try stmt.step()) {
            // No live code: compare against a blank digest all the same, so the work is alike.
            const blank: [64]u8 = @splat(0);
            std.mem.doNotOptimizeAway(std.crypto.timing_safe.eql([64]u8, blank, a.hash));
            return null;
        }
        const id = try stmt.text(0) orelse return error.CorruptRow;
        const hash = try stmt.text(1) orelse return error.CorruptRow;
        if (id.len != row_id.len) return error.CorruptRow;
        @memcpy(&row_id, id);
        // A stored hash of another length can never match; the attempt still counts.
        stored = @splat(0);
        if (hash.len == stored.len) @memcpy(&stored, hash) else stored[0] = 0xff;
    }
    // Both sides are fixed-length digests, so the compare is constant-time and length-independent.
    if (!std.crypto.timing_safe.eql([64]u8, stored, a.hash)) {
        try execute(db, "UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", &.{.{ .text = &row_id }});
        return null;
    }
    try execute(db, "UPDATE email_codes SET used_at = ? WHERE id = ?", &.{ .{ .int = a.now }, .{ .text = &row_id } });
    const user = try userByEmail(db, a.alloc, a.email) orelse return null;
    if (a.signin) |s| try signInInTx(db, s);
    return user.id;
}

/// `verifyEmailCode`: the user's id when the newest live code for the address matches. A wrong
/// guess counts against that code; the fifth kills it.
pub fn verifyEmailCode(app: *App, alloc: Allocator, email: []const u8, code: []const u8, now: i64) Error!?[]const u8 {
    return verifyEmailCodeWith(app, alloc, email, code, now, null);
}

/// `verifyEmailCode` that also stores the session in the same transaction.
pub fn verifyEmailCodeWith(app: *App, alloc: Allocator, email: []const u8, code: []const u8, now: i64, signin: ?SignIn) Error!?[]const u8 {
    const hash = sessions.tokenHash(parity.jsTrim(code));
    return runTx(app, VerifyArgs{ .alloc = alloc, .email = email, .hash = hash, .now = now, .signin = signin }, verifyEmailLocked);
}

// ---- enrollment codes ----

pub const NewEnrollment = struct {
    user_id: ?[]const u8 = null,
    email: ?[]const u8 = null,
    ttl_ms: i64,
};

const InsertEnrollmentArgs = struct { opts: NewEnrollment, code: EnrollmentCode, now: i64 };

/// A new code for a user ends their older unused ones, so a link that was re-issued because it
/// leaked or got lost stops working. Caller holds the lock and the transaction.
pub fn insertEnrollment(db: sqlite.Db, a: InsertEnrollmentArgs) Error!void {
    if (a.opts.user_id) |user_id| try execute(
        db,
        "UPDATE enrollments SET expires_at = ? WHERE user_id = ? AND used_at IS NULL AND expires_at > ?",
        &.{ .{ .int = a.now }, .{ .text = user_id }, .{ .int = a.now } },
    );
    try execute(
        db,
        "INSERT INTO enrollments (code_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        &.{
            .{ .text = &sessions.tokenHash(&a.code) },
            Param.opt(a.opts.user_id),
            Param.opt(a.opts.email),
            .{ .int = a.now },
            .{ .int = a.now +| a.opts.ttl_ms },
        },
    );
}

/// `createEnrollment`. No user and no email marks the first-owner bootstrap code.
pub fn createEnrollment(app: *App, opts: NewEnrollment, now: i64) Error!EnrollmentCode {
    const code = try randomCode(app.io, enrollment_groups);
    try runTx(app, InsertEnrollmentArgs{ .opts = opts, .code = code, .now = now }, insertEnrollment);
    return code;
}

const live_enrollment =
    "SELECT user_id, email, redeemed_user_id FROM enrollments WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?";

pub const Profile = struct { email: []const u8, name: []const u8 };

pub const RedeemArgs = struct { alloc: Allocator, io: std.Io, hash: [64]u8, profile: Profile, now: i64 };

fn dupeOpt(alloc: Allocator, stmt: sqlite.Stmt, column: c_int) Error!?[]const u8 {
    return try stmt.textAlloc(alloc, column);
}

/// `userForEnrollment`.
fn userForEnrollment(db: sqlite.Db, a: RedeemArgs, user_id: ?[]const u8, email: ?[]const u8) Error!?[]const u8 {
    if (user_id) |id| return id;
    const bootstrap = email == null;
    if (bootstrap and try exists(db, "SELECT 1 FROM users WHERE instance_admin = 1", &.{})) return null;
    if (email) |bound| {
        const lowered = parity.jsLowerEmail(a.alloc, bound) catch |err| switch (err) {
            error.InvalidUtf8 => return null,
            error.OutOfMemory => return error.OutOfMemory,
        };
        if (!std.mem.eql(u8, lowered, a.profile.email)) return null;
    }
    if (try userByEmail(db, a.alloc, a.profile.email) != null) return null;
    const id = try insertUser(db, a.io, .{ .email = a.profile.email, .name = a.profile.name, .instance_admin = bootstrap });
    return try a.alloc.dupe(u8, &id);
}

fn redeemLocked(db: sqlite.Db, a: RedeemArgs) Error!?[]const u8 {
    var user_id: ?[]const u8 = null;
    var email: ?[]const u8 = null;
    {
        const stmt = try prepared(db, live_enrollment, &.{ .{ .text = &a.hash }, .{ .int = a.now } });
        defer stmt.finalize();
        if (!try stmt.step()) return null;
        if (try dupeOpt(a.alloc, stmt, 2)) |redeemed| return redeemed;
        user_id = try dupeOpt(a.alloc, stmt, 0);
        email = try dupeOpt(a.alloc, stmt, 1);
    }
    const id = try userForEnrollment(db, a, user_id, email) orelse return null;
    try execute(db, "UPDATE enrollments SET redeemed_user_id = ? WHERE code_hash = ?", &.{ .{ .text = id }, .{ .text = &a.hash } });
    return id;
}

/// `redeemEnrollment`. Redeeming only fixes which user the code is for; the code stays live until
/// `completeEnrollment`, so a cancelled passkey prompt can ask again and get a fresh challenge
/// for the same user.
pub fn redeemEnrollment(app: *App, alloc: Allocator, code: []const u8, profile: Profile, now: i64) Error!?[]const u8 {
    const normalized = try normalizeCode(alloc, code) orelse return null;
    return runTx(app, RedeemArgs{ .alloc = alloc, .io = app.io, .hash = sessions.tokenHash(normalized), .profile = profile, .now = now }, redeemLocked);
}

const CodeArgs = struct { alloc: Allocator, hash: [64]u8, now: i64 };

fn enrollmentUserLocked(db: sqlite.Db, a: CodeArgs) Error!?[]const u8 {
    const stmt = try prepared(db, live_enrollment, &.{ .{ .text = &a.hash }, .{ .int = a.now } });
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    return dupeOpt(a.alloc, stmt, 2);
}

/// `enrollmentUser`: the user a live code was redeemed for.
pub fn enrollmentUser(app: *App, alloc: Allocator, code: []const u8, now: i64) Error!?[]const u8 {
    const normalized = try normalizeCode(alloc, code) orelse return null;
    return run(app, CodeArgs{ .alloc = alloc, .hash = sessions.tokenHash(normalized), .now = now }, enrollmentUserLocked);
}

fn claimLocked(db: sqlite.Db, a: CodeArgs) Error!bool {
    return try touched(
        db,
        \\UPDATE enrollments SET claimed_at = ?
        \\ WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
        \\   AND (claimed_at IS NULL OR claimed_at < ?) RETURNING 1
    ,
        &.{ .{ .int = a.now }, .{ .text = &a.hash }, .{ .int = a.now }, .{ .int = a.now - claim_ttl_ms } },
    ) > 0;
}

/// `claimEnrollment`: two concurrent verifies for one code would both pass the live check while
/// the first is still awaiting the passkey check; only one wins the claim.
pub fn claimEnrollment(app: *App, alloc: Allocator, code: []const u8, now: i64) Error!bool {
    return try claimEnrollmentToken(app, alloc, code, now) != null;
}

/// `claimEnrollment` that hands back the claim token, the `claimed_at` it wrote. Completing or
/// releasing with it only works while that exact claim is still the live one, so a request that
/// stalled past the claim window and lost it to another cannot finish the code as well.
pub fn claimEnrollmentToken(app: *App, alloc: Allocator, code: []const u8, now: i64) Error!?i64 {
    const normalized = try normalizeCode(alloc, code) orelse return null;
    const won = try run(app, CodeArgs{ .alloc = alloc, .hash = sessions.tokenHash(normalized), .now = now }, claimLocked);
    return if (won) now else null;
}

fn releaseLocked(db: sqlite.Db, a: CodeArgs) Error!void {
    // `now` carries the claim token: another request's claim is not ours to let go.
    try execute(db, "UPDATE enrollments SET claimed_at = NULL WHERE code_hash = ? AND used_at IS NULL AND claimed_at = ?", &.{ .{ .text = &a.hash }, .{ .int = a.now } });
}

/// `releaseEnrollment` for a caller that has the hash already: it needs no allocation, so it can
/// run on a failure path.
pub fn releaseByHash(app: *App, hash: [64]u8, token: i64) Error!void {
    try run(app, CodeArgs{ .alloc = undefined, .hash = hash, .now = token }, releaseLocked);
}

pub fn releaseEnrollment(app: *App, alloc: Allocator, code: []const u8, token: i64) Error!void {
    const normalized = try normalizeCode(alloc, code) orelse return;
    try run(app, CodeArgs{ .alloc = alloc, .hash = sessions.tokenHash(normalized), .now = token }, releaseLocked);
}

/// Marks a code used; the caller holds the lock (and its transaction, when there is one).
pub fn completeByHash(db: sqlite.Db, hash: [64]u8, now: i64) Error!void {
    try execute(db, "UPDATE enrollments SET used_at = ? WHERE code_hash = ? AND used_at IS NULL", &.{ .{ .int = now }, .{ .text = &hash } });
}

/// What a registration must still hold to finish its code: the code and the claim it took.
pub const Completion = struct { hash: [64]u8, claim: i64 };

/// Marks the code used only while `claim` is the live claim; false when it was lost.
pub fn completeClaimed(db: sqlite.Db, done: Completion, now: i64) Error!bool {
    return try touched(
        db,
        "UPDATE enrollments SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND claimed_at = ? RETURNING 1",
        &.{ .{ .int = now }, .{ .text = &done.hash }, .{ .int = done.claim } },
    ) == 1;
}

/// The stored hash of an enrollment code as typed; null for bytes that are not UTF-8.
pub fn enrollmentHash(alloc: Allocator, code: []const u8) Allocator.Error!?[64]u8 {
    const normalized = try normalizeCode(alloc, code) orelse return null;
    return sessions.tokenHash(normalized);
}

fn completeLocked(db: sqlite.Db, a: CodeArgs) Error!void {
    try completeByHash(db, a.hash, a.now);
}

pub fn completeEnrollment(app: *App, alloc: Allocator, code: []const u8, now: i64) Error!void {
    const normalized = try normalizeCode(alloc, code) orelse return;
    try run(app, CodeArgs{ .alloc = alloc, .hash = sessions.tokenHash(normalized), .now = now }, completeLocked);
}

// ---- first run ----

const FirstRunArgs = struct { alloc: Allocator, io: std.Io, ttl_ms: i64, now: i64 };

fn firstRunLocked(db: sqlite.Db, a: FirstRunArgs) Error!?EnrollmentCode {
    const enrolled = try exists(
        db,
        \\SELECT 1 FROM users u WHERE u.instance_admin = 1
        \\   AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)
    ,
        &.{},
    );
    if (enrolled) return null;
    const admin: ?[]const u8 = blk: {
        const stmt = try prepared(db, "SELECT id FROM users WHERE instance_admin = 1 ORDER BY created_at, id LIMIT 1", &.{});
        defer stmt.finalize();
        break :blk if (try stmt.step()) try dupeOpt(a.alloc, stmt, 0) else null;
    };
    // Entropy is drawn only now that a link is needed: an enrolled instance must boot without it.
    const code = try randomCode(a.io, enrollment_groups);
    try execute(
        db,
        \\UPDATE enrollments SET used_at = ?
        \\ WHERE used_at IS NULL AND ((user_id IS NULL AND email IS NULL) OR user_id = ?)
    ,
        &.{ .{ .int = a.now }, Param.opt(admin) },
    );
    try insertEnrollment(db, .{ .opts = .{ .user_id = admin, .ttl_ms = a.ttl_ms }, .code = code, .now = a.now });
    return code;
}

/// `firstRunEnrollment`. First run is an instance with no admin who holds a passkey. A regular
/// user with a passkey does not count and is never promoted: with no admin at all the link
/// creates a new admin user. An admin who has no passkey yet gets the link for their own account.
/// Older unused bootstrap links die first so only one first-run link is ever live.
pub fn firstRunEnrollment(app: *App, alloc: Allocator, ttl_ms: i64, now: i64) Error!?EnrollmentCode {
    return runTx(app, FirstRunArgs{ .alloc = alloc, .io = app.io, .ttl_ms = ttl_ms, .now = now }, firstRunLocked);
}

test {
    _ = @import("codes_test.zig");
}
