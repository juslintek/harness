//! Passkey ceremonies, a port of code/src/server/features/auth/{passkeys,credentials}.ts: the
//! challenge store, the options the browser gets, and the three ways a response is accepted
//! (registration, login, step-up). The WebAuthn checks themselves are webauthn.zig; this file owns
//! the rows around them. The state lock is held for SQL only, never across a signature check.
const std = @import("std");
const builtin = @import("builtin");
const app_mod = @import("../app.zig");
const ids = @import("../ids.zig");
const sqlite = @import("../db/sqlite.zig");
const codes = @import("codes.zig");
const webauthn = @import("webauthn.zig");

const App = app_mod.App;
const Allocator = std.mem.Allocator;
const Param = codes.Param;

pub const Error = codes.Error;

pub const Rp = struct {
    id: []const u8,
    name: []const u8 = "Harness",
    origin: []const u8,
};

/// The CHECK constraint of `challenges.purpose` names these three.
pub const Purpose = enum { register, login, step_up };

/// CHALLENGE_TTL_MS
pub const challenge_ttl_ms: i64 = 5 * 60 * 1000;

pub const claim_lost_reason = "enrollment already in progress";
pub const expired_reason = "challenge expired or already used";

/// What a finished ceremony says: the value on success, or the `reason` of the 400 or 401.
pub fn Outcome(comptime T: type) type {
    return union(enum) { ok: T, failed: []const u8 };
}

// ---- challenges ----

const StoreArgs = struct { io: std.Io, challenge: []const u8, purpose: Purpose, user_id: ?[]const u8, now: i64 };

/// Expired rows are swept on every insert, as storeChallenge does. Caller holds the lock.
fn storeChallenge(db: sqlite.Db, a: StoreArgs) Error![ids.uuid_len]u8 {
    const id = ids.uuidV7(a.io);
    try codes.execute(db, "DELETE FROM challenges WHERE expires_at < ?", &.{.{ .int = a.now }});
    try codes.execute(
        db,
        "INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
        &.{ .{ .text = &id }, .{ .text = a.challenge }, .{ .text = @tagName(a.purpose) }, Param.opt(a.user_id), .{ .int = a.now + challenge_ttl_ms } },
    );
    return id;
}

const ConsumeArgs = struct { alloc: Allocator, id: []const u8, purpose: Purpose, user_id: ?[]const u8, now: i64 };

/// The row is deleted before it is checked, so a challenge is spent even by a failed attempt, and
/// two requests for one id cannot both win.
fn consumeChallenge(db: sqlite.Db, a: ConsumeArgs) Error!?[]const u8 {
    const stmt = try codes.prepared(db, "DELETE FROM challenges WHERE id = ? RETURNING challenge, purpose, user_id, expires_at", &.{.{ .text = a.id }});
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    const challenge = try stmt.textAlloc(a.alloc, 0) orelse return error.CorruptRow;
    const purpose = try stmt.text(1) orelse return error.CorruptRow;
    const bound = try stmt.text(2);
    const expires_at = stmt.int(3);
    // The text slices die with the next step, so the verdict is taken before the cursor is drained.
    const valid = expires_at >= a.now and std.mem.eql(u8, purpose, @tagName(a.purpose)) and sameUser(bound, a.user_id);
    while (try stmt.step()) {}
    return if (valid) challenge else null;
}

fn sameUser(stored: ?[]const u8, expected: ?[]const u8) bool {
    if (stored == null or expected == null) return stored == null and expected == null;
    return std.mem.eql(u8, stored.?, expected.?);
}

fn consume(app: *App, alloc: Allocator, id: []const u8, purpose: Purpose, user_id: ?[]const u8, now: i64) Error!?[]const u8 {
    return codes.run(app, ConsumeArgs{ .alloc = alloc, .id = id, .purpose = purpose, .user_id = user_id, .now = now }, consumeChallenge);
}

// ---- options ----

fn descriptorsOf(db: sqlite.Db, alloc: Allocator, user_id: []const u8) Error![]webauthn.CredentialDescriptor {
    const stmt = try codes.prepared(db, "SELECT id, transports FROM passkeys WHERE user_id = ?", &.{.{ .text = user_id }});
    defer stmt.finalize();
    var list: std.ArrayList(webauthn.CredentialDescriptor) = .empty;
    while (try stmt.step()) {
        const id = try stmt.textAlloc(alloc, 0) orelse return error.CorruptRow;
        const raw = try stmt.text(1);
        const transports = webauthn.parseTransports(alloc, raw) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return error.CorruptRow,
        };
        try list.append(alloc, .{ .id = id, .transports = transports });
    }
    return list.items;
}

const OptionsArgs = struct { alloc: Allocator, io: std.Io, challenge: [webauthn.challenge_len]u8, purpose: Purpose, user_id: ?[]const u8, now: i64 };

const Prepared = struct {
    user: ?codes.User,
    descriptors: []webauthn.CredentialDescriptor,
    challenge_id: [ids.uuid_len]u8,
};

fn prepareOptions(db: sqlite.Db, a: OptionsArgs) Error!Prepared {
    var user: ?codes.User = null;
    var descriptors: []webauthn.CredentialDescriptor = &.{};
    if (a.user_id) |user_id| {
        user = try codes.userById(db, a.alloc, user_id);
        // No such user: nothing to challenge, and no row to leave behind.
        if (user == null and a.purpose == .register) return .{ .user = null, .descriptors = &.{}, .challenge_id = undefined };
        descriptors = try descriptorsOf(db, a.alloc, user_id);
    }
    const challenge_id = try storeChallenge(db, .{ .io = a.io, .challenge = &a.challenge, .purpose = a.purpose, .user_id = a.user_id, .now = a.now });
    return .{ .user = user, .descriptors = descriptors, .challenge_id = challenge_id };
}

fn prepare(app: *App, alloc: Allocator, purpose: Purpose, user_id: ?[]const u8, now: i64) !struct { prepared: Prepared, challenge: [webauthn.challenge_len]u8 } {
    const challenge = try webauthn.newChallenge(app.io);
    const prepared = try codes.runTx(app, OptionsArgs{ .alloc = alloc, .io = app.io, .challenge = challenge, .purpose = purpose, .user_id = user_id, .now = now }, prepareOptions);
    return .{ .prepared = prepared, .challenge = challenge };
}

/// `registrationOptions`: the options JSON of simplewebauthn plus `challengeId`; null when the
/// user does not exist (TS throws "unknown user"). The result belongs to `alloc`.
pub fn registrationOptions(app: *App, alloc: Allocator, rp: Rp, user_id: []const u8, now: i64) !?[]u8 {
    const made = try prepare(app, alloc, .register, user_id, now);
    const user = made.prepared.user orelse return null;
    return try webauthn.registrationOptionsJson(alloc, .{
        .rp_id = rp.id,
        .rp_name = rp.name,
        .user_id = user.id,
        .user_name = user.email,
        .user_display_name = user.name,
        .challenge = &made.challenge,
        .challenge_id = &made.prepared.challenge_id,
        .exclude = made.prepared.descriptors,
    });
}

/// `loginOptions`: discoverable credentials, user verification preferred.
pub fn loginOptions(app: *App, alloc: Allocator, rp: Rp, now: i64) ![]u8 {
    const made = try prepare(app, alloc, .login, null, now);
    return webauthn.authenticationOptionsJson(alloc, .{
        .rp_id = rp.id,
        .challenge = &made.challenge,
        .challenge_id = &made.prepared.challenge_id,
        .user_verification = .preferred,
    });
}

/// `stepUpOptions`: only the user's own credentials, user verification required.
pub fn stepUpOptions(app: *App, alloc: Allocator, rp: Rp, user_id: []const u8, now: i64) ![]u8 {
    const made = try prepare(app, alloc, .step_up, user_id, now);
    return webauthn.authenticationOptionsJson(alloc, .{
        .rp_id = rp.id,
        .challenge = &made.challenge,
        .challenge_id = &made.prepared.challenge_id,
        .user_verification = .required,
        .allow = made.prepared.descriptors,
    });
}

// ---- registration ----

const InsertArgs = struct {
    user_id: []const u8,
    credential_id: []const u8,
    public_key: []const u8,
    counter: u32,
    transports: ?[]const u8,
    name: []const u8,
    now: i64,
    /// Enrollment code to mark used, under its claim, in the same transaction as the insert.
    complete: ?codes.Completion = null,
    /// Fresh recovery codes stored with the passkey, so the response has them whatever happens next.
    recovery: ?*const codes.RecoveryCodes = null,
    /// The session and personal org of the sign-in this registration ends with.
    signin: ?codes.SignIn = null,
};

const InsertError = Error || error{ClaimLost};

fn insertPasskey(db: sqlite.Db, a: InsertArgs) InsertError!bool {
    if (try codes.exists(db, "SELECT 1 FROM passkeys WHERE id = ?", &.{.{ .text = a.credential_id }})) return false;
    const stmt = try codes.prepared(
        db,
        "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &.{ .{ .text = a.credential_id }, .{ .text = a.user_id }, .none, .{ .int = a.counter }, Param.opt(a.transports), .{ .text = a.name }, .{ .int = a.now } },
    );
    defer stmt.finalize();
    // The key is a blob, which `Param` has no case for.
    try stmt.bindBlob(3, a.public_key);
    while (try stmt.step()) {}
    // A passkey without its code marked used would leave the user stuck on a retry.
    // Zero rows means the claim was taken over; the error rolls the insert back.
    if (a.complete) |done| if (!try codes.completeClaimed(db, done, a.now)) return error.ClaimLost;
    if (a.recovery) |set| try codes.replaceRecovery(db, .{ .user_id = a.user_id, .codes = set });
    if (a.signin) |s| try codes.signInInTx(db, s);
    return true;
}

/// A failed check becomes the `reason` of the response; running out of memory stays an error.
fn reasonOf(err: webauthn.Error) error{OutOfMemory}![]const u8 {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => webauthn.message(err),
    };
}

/// `finishRegistration`: the challenge is spent first, the response checked without the lock, then
/// the passkey stored. The credential id is the base64url the browser sent, owned by `alloc`.
pub fn finishRegistration(
    app: *App,
    alloc: Allocator,
    rp: Rp,
    user_id: []const u8,
    challenge_id: []const u8,
    response: webauthn.Credential,
    name: []const u8,
    now: i64,
) !Outcome([]const u8) {
    return finishRegistrationWith(app, alloc, rp, user_id, challenge_id, response, name, now, null, null, null);
}

/// `finishRegistration` that also marks an enrollment code used (by hash) in the transaction that
/// stores the passkey, so the two cannot be apart.
pub fn finishRegistrationWith(
    app: *App,
    alloc: Allocator,
    rp: Rp,
    user_id: []const u8,
    challenge_id: []const u8,
    response: webauthn.Credential,
    name: []const u8,
    now: i64,
    complete: ?codes.Completion,
    recovery: ?*const codes.RecoveryCodes,
    signin: ?codes.SignIn,
) !Outcome([]const u8) {
    const challenge = try consume(app, alloc, challenge_id, .register, user_id, now) orelse return .{ .failed = expired_reason };
    const verified = webauthn.verifyRegistration(app.gpa, .{
        .response = response,
        .expected_challenge = challenge,
        .expected_origin = rp.origin,
        .expected_rp_id = rp.id,
        .require_user_verification = true,
    }) catch |err| return .{ .failed = try reasonOf(err) };
    defer verified.deinit(app.gpa);
    const transports: ?[]const u8 = if (response.response) |inner| if (inner.transports) |list|
        try std.json.Stringify.valueAlloc(alloc, list, .{})
    else
        null else null;
    // Everything the answer needs is allocated before the commit: nothing fallible comes after it.
    const credential_id = try alloc.dupe(u8, verified.credential_id);
    const stored = codes.runTx(app, InsertArgs{
        .user_id = user_id,
        .credential_id = verified.credential_id,
        .public_key = verified.public_key,
        .counter = verified.counter,
        .transports = transports,
        .name = name,
        .now = now,
        .complete = complete,
        .recovery = recovery,
        .signin = signin,
    }, insertPasskey) catch |err| switch (err) {
        error.ClaimLost => return .{ .failed = claim_lost_reason },
        else => return err,
    };
    if (!stored) return .{ .failed = "credential already registered" };
    return .{ .ok = credential_id };
}

// ---- assertions ----

const StoredKey = struct { user_id: []const u8, public_key: []const u8, counter: u32 };

const LookupArgs = struct { alloc: Allocator, id: []const u8 };

fn lookupPasskey(db: sqlite.Db, a: LookupArgs) Error!?StoredKey {
    const stmt = try codes.prepared(db, "SELECT user_id, public_key, counter FROM passkeys WHERE id = ?", &.{.{ .text = a.id }});
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    const user_id = try stmt.textAlloc(a.alloc, 0) orelse return error.CorruptRow;
    const key = try stmt.blob(1) orelse return error.CorruptRow;
    // A counter outside u32 cannot have come from an authenticator; treat it as spent.
    const counter = std.math.cast(u32, stmt.int(2)) orelse std.math.maxInt(u32);
    return .{ .user_id = user_id, .public_key = try a.alloc.dupe(u8, key), .counter = counter };
}

/// Tests run a second assertion at the point where the first has verified and not yet stored.
pub var between_verify_and_store: ?*const fn () void = null;

const TouchArgs = struct { id: []const u8, counter: u32, read_counter: u32, now: i64 };

/// Stores the new counter only while the stored one is still the value this assertion was checked
/// against. Two assertions that read the same counter cannot both pass: the second finds it moved
/// and matches no row. (TS takes max() with no such condition and lets both through; for an
/// authenticator that always reports 0 the condition holds for both, as it must.)
fn touchPasskey(db: sqlite.Db, a: TouchArgs) Error!bool {
    return try codes.touched(
        db,
        "UPDATE passkeys SET counter = max(counter, ?), last_used_at = ? WHERE id = ? AND counter = ? RETURNING 1",
        &.{ .{ .int = a.counter }, .{ .int = a.now }, .{ .text = a.id }, .{ .int = a.read_counter } },
    ) == 1;
}

fn verifyAssertion(
    app: *App,
    alloc: Allocator,
    rp: Rp,
    challenge_id: []const u8,
    purpose: Purpose,
    expected_user: ?[]const u8,
    response: webauthn.Credential,
    now: i64,
) !Outcome([]const u8) {
    const challenge = try consume(app, alloc, challenge_id, purpose, expected_user, now) orelse return .{ .failed = expired_reason };
    const credential_id = response.id orelse return .{ .failed = "unknown credential" };
    const stored = try codes.run(app, LookupArgs{ .alloc = alloc, .id = credential_id }, lookupPasskey) orelse return .{ .failed = "unknown credential" };
    if (expected_user) |user_id| if (!std.mem.eql(u8, stored.user_id, user_id)) return .{ .failed = "unknown credential" };
    const verified = webauthn.verifyAuthentication(app.gpa, .{
        .response = response,
        .expected_challenge = challenge,
        .expected_origin = rp.origin,
        .expected_rp_id = rp.id,
        .require_user_verification = purpose == .step_up,
        .credential_public_key = stored.public_key,
        .credential_counter = stored.counter,
    }) catch |err| return .{ .failed = try reasonOf(err) };
    if (builtin.is_test) if (between_verify_and_store) |hook| hook();
    const moved = try codes.run(app, TouchArgs{ .id = credential_id, .counter = verified.new_counter, .read_counter = stored.counter, .now = now }, touchPasskey);
    if (!moved) return .{ .failed = webauthn.message(error.CounterNotIncreased) };
    return .{ .ok = stored.user_id };
}

/// `finishLogin`: the user the credential belongs to.
pub fn finishLogin(app: *App, alloc: Allocator, rp: Rp, challenge_id: []const u8, response: webauthn.Credential, now: i64) !Outcome([]const u8) {
    return verifyAssertion(app, alloc, rp, challenge_id, .login, null, response, now);
}

const StepUpArgs = struct { session_id: []const u8, user_id: []const u8, now: i64 };

fn stampStepUp(db: sqlite.Db, a: StepUpArgs) Error!bool {
    return try codes.touched(
        db,
        "UPDATE sessions SET step_up_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING 1",
        &.{ .{ .int = a.now }, .{ .text = a.session_id }, .{ .text = a.user_id }, .{ .int = a.now } },
    ) == 1;
}

/// `finishStepUp`: a fresh assertion by the session's own user stamps `step_up_at` on that session.
pub fn finishStepUp(app: *App, alloc: Allocator, rp: Rp, session_id: []const u8, user_id: []const u8, challenge_id: []const u8, response: webauthn.Credential, now: i64) !Outcome(void) {
    switch (try verifyAssertion(app, alloc, rp, challenge_id, .step_up, user_id, response, now)) {
        .failed => |reason| return .{ .failed = reason },
        .ok => {},
    }
    const stamped = try codes.run(app, StepUpArgs{ .session_id = session_id, .user_id = user_id, .now = now }, stampStepUp);
    return if (stamped) .{ .ok = {} } else .{ .failed = "unknown session" };
}

// ---- credentials.ts ----

/// `PasskeyInfo`, in the key order the route sends it.
pub const Info = struct { id: []const u8, name: []const u8, createdAt: i64, lastUsedAt: ?i64 };

const ListArgs = struct { alloc: Allocator, user_id: []const u8 };

fn listLocked(db: sqlite.Db, a: ListArgs) Error![]Info {
    const stmt = try codes.prepared(db, "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at", &.{.{ .text = a.user_id }});
    defer stmt.finalize();
    var list: std.ArrayList(Info) = .empty;
    while (try stmt.step()) try list.append(a.alloc, .{
        .id = try stmt.textAlloc(a.alloc, 0) orelse return error.CorruptRow,
        .name = try stmt.textAlloc(a.alloc, 1) orelse return error.CorruptRow,
        .createdAt = stmt.int(2),
        .lastUsedAt = if (stmt.isNull(3)) null else stmt.int(3),
    });
    return list.items;
}

pub fn listPasskeys(app: *App, alloc: Allocator, user_id: []const u8) Error![]Info {
    return codes.run(app, ListArgs{ .alloc = alloc, .user_id = user_id }, listLocked);
}

pub const Deleted = enum { deleted, last, missing };

const DeleteArgs = struct { user_id: []const u8, id: []const u8 };

fn deleteLocked(db: sqlite.Db, a: DeleteArgs) Error!Deleted {
    if (!try codes.exists(db, "SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?", &.{ .{ .text = a.id }, .{ .text = a.user_id } })) return .missing;
    const count = blk: {
        const stmt = try codes.prepared(db, "SELECT count(*) FROM passkeys WHERE user_id = ?", &.{.{ .text = a.user_id }});
        defer stmt.finalize();
        break :blk if (try stmt.step()) stmt.int(0) else 0;
    };
    if (count <= 1) return .last;
    try codes.execute(db, "DELETE FROM passkeys WHERE id = ? AND user_id = ?", &.{ .{ .text = a.id }, .{ .text = a.user_id } });
    return .deleted;
}

/// `deletePasskey`: the count and the delete share one transaction so two parallel deletes cannot
/// both pass the keep-one rule.
pub fn deletePasskey(app: *App, user_id: []const u8, id: []const u8) Error!Deleted {
    return codes.runTx(app, DeleteArgs{ .user_id = user_id, .id = id }, deleteLocked);
}

test {
    _ = @import("passkeys_test.zig");
}
