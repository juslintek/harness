//! Tests for passkeys.zig. The ceremonies are the ones recorded from simplewebauthn in
//! fixtures/webauthn.json: one credential registers (challenge A), logs in (B, counter 1) and
//! steps up (C, counter 2). The challenge rows are seeded with the recorded challenge strings, the
//! only part of a ceremony the server normally invents.
const std = @import("std");
const codes = @import("codes.zig");
const passkeys = @import("passkeys.zig");
const sessions = @import("sessions.zig");
const sqlite = @import("../db/sqlite.zig");
const webauthn = @import("webauthn.zig");
const Ctx = @import("codes_test.zig").Ctx;

const testing = std.testing;
const t0: i64 = 1_700_000_000_000;
const minute: i64 = 60 * 1000;

const fixtures_json = @embedFile("fixtures/webauthn.json");

pub const Vector = struct {
    name: []const u8,
    input: struct {
        challenge: []const u8,
        origin: []const u8,
        rpId: []const u8,
        response: webauthn.Credential,
    },
};

pub const Fixtures = struct {
    rp: struct { id: []const u8, name: []const u8, origin: []const u8 },
    vectors: []const Vector,
};

pub fn fixtures(arena: std.mem.Allocator) !Fixtures {
    return std.json.parseFromSliceLeaky(Fixtures, arena, fixtures_json, .{ .ignore_unknown_fields = true });
}

pub fn vectorNamed(all: Fixtures, name: []const u8) !Vector {
    for (all.vectors) |v| if (std.mem.eql(u8, v.name, name)) return v;
    std.debug.print("no vector named {s}\n", .{name});
    return error.NoSuchVector;
}

const Seed = struct {
    id: []const u8,
    challenge: []const u8,
    purpose: passkeys.Purpose,
    user_id: ?[]const u8,
    expires_at: i64,
};

fn seedLocked(db: sqlite.Db, s: Seed) codes.Error!void {
    try codes.execute(
        db,
        "INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
        &.{ .{ .text = s.id }, .{ .text = s.challenge }, .{ .text = @tagName(s.purpose) }, codes.Param.opt(s.user_id), .{ .int = s.expires_at } },
    );
}

fn seed(ctx: *Ctx, s: Seed) !void {
    try codes.run(&ctx.fx.app, s, seedLocked);
}

fn challengeRows(ctx: *Ctx) !i64 {
    return ctx.count("SELECT count(*) FROM challenges");
}

fn passkeyCounter(ctx: *Ctx, id: []const u8) !i64 {
    const stmt = try ctx.fx.db.prepare("SELECT counter FROM passkeys WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if (!try stmt.step()) return error.NoSuchPasskey;
    return stmt.int(0);
}

fn rpOf(all: Fixtures) passkeys.Rp {
    return .{ .id = all.rp.id, .name = all.rp.name, .origin = all.rp.origin };
}

/// Registers the recorded credential for `user_id` and returns its id.
fn register(ctx: *Ctx, all: Fixtures, user_id: []const u8) ![]const u8 {
    const v = try vectorNamed(all, "es256: registration");
    try seed(ctx, .{ .id = "reg-1", .challenge = v.input.challenge, .purpose = .register, .user_id = user_id, .expires_at = t0 + 5 * minute });
    const outcome = try passkeys.finishRegistration(&ctx.fx.app, ctx.alloc(), rpOf(all), user_id, "reg-1", v.input.response, "Laptop", t0);
    return switch (outcome) {
        .ok => |id| id,
        .failed => |reason| {
            std.debug.print("registration failed: {s}\n", .{reason});
            return error.RegistrationFailed;
        },
    };
}

fn expectFailed(want: []const u8, got: anytype) !void {
    switch (got) {
        .ok => return error.AcceptedButShouldFail,
        .failed => |reason| try testing.expectEqualStrings(want, reason),
    }
}

test "passkeys: the recorded credential registers, logs in and steps up" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const credential_id = try register(&ctx, all, ada);
    try testing.expectEqualStrings("d5vuaACMtyd06IvKP1BTvg", credential_id);
    try testing.expectEqual(@as(i64, 0), try passkeyCounter(&ctx, credential_id));

    const login = try vectorNamed(all, "es256: login, counter 1");
    try seed(&ctx, .{ .id = "login-1", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + 5 * minute });
    const who = try passkeys.finishLogin(app, ctx.alloc(), rp, "login-1", login.input.response, t0 + 1);
    try testing.expectEqualStrings(ada, who.ok);
    try testing.expectEqual(@as(i64, 1), try passkeyCounter(&ctx, credential_id));

    const session = try sessions.create(app, .{ .user_id = ada, .method = .passkey, .user_agent = null }, t0);
    const step = try vectorNamed(all, "es256: step-up with UV required, counter 2");
    try seed(&ctx, .{ .id = "step-1", .challenge = step.input.challenge, .purpose = .step_up, .user_id = ada, .expires_at = t0 + 5 * minute });
    const done = try passkeys.finishStepUp(app, ctx.alloc(), rp, &session.id, ada, "step-1", step.input.response, t0 + 2);
    try testing.expect(done == .ok);
    try testing.expectEqual(@as(i64, 2), try passkeyCounter(&ctx, credential_id));
    try testing.expectEqual(@as(i64, t0 + 2), try ctx.count("SELECT step_up_at FROM sessions"));
}

test "passkeys: the stored passkey keeps what the browser said about transports and the name" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const ada = try ctx.user("a@example.com", false);
    _ = try register(&ctx, all, ada);
    const list = try passkeys.listPasskeys(&ctx.fx.app, ctx.alloc(), ada);
    try testing.expectEqual(@as(usize, 1), list.len);
    try testing.expectEqualStrings("Laptop", list[0].name);
    try testing.expectEqual(@as(?i64, null), list[0].lastUsedAt);
    const stmt = try ctx.fx.db.prepare("SELECT transports FROM passkeys");
    defer stmt.finalize();
    _ = try stmt.step();
    try testing.expectEqualStrings("[\"internal\"]", (try stmt.text(0)).?);
}

test "passkeys: a replayed challenge is refused, and a failed attempt still spends it" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const ada = try ctx.user("a@example.com", false);
    const v = try vectorNamed(all, "es256: registration");
    try seed(&ctx, .{ .id = "c1", .challenge = v.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 + minute });
    try expectFailed(webauthn.message(error.UnexpectedOrigin), try passkeys.finishRegistration(&ctx.fx.app, ctx.alloc(), .{ .id = rp.id, .origin = "https://evil.test" }, ada, "c1", v.input.response, "x", t0));
    try testing.expectEqual(@as(i64, 0), try challengeRows(&ctx));
    // The right origin does not revive the spent challenge.
    try expectFailed(passkeys.expired_reason, try passkeys.finishRegistration(&ctx.fx.app, ctx.alloc(), rp, ada, "c1", v.input.response, "x", t0));
    try testing.expectEqual(@as(i64, 0), try ctx.count("SELECT count(*) FROM passkeys"));
}

test "passkeys: an expired challenge, another purpose and another user are refused" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const bob = try ctx.user("b@example.com", false);
    const v = try vectorNamed(all, "es256: registration");
    // expires_at is compared with <, so the last millisecond still works and the next does not.
    try seed(&ctx, .{ .id = "late", .challenge = v.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 });
    try expectFailed(passkeys.expired_reason, try passkeys.finishRegistration(app, ctx.alloc(), rp, ada, "late", v.input.response, "x", t0 + 1));
    try seed(&ctx, .{ .id = "login", .challenge = v.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + minute });
    try expectFailed(passkeys.expired_reason, try passkeys.finishRegistration(app, ctx.alloc(), rp, ada, "login", v.input.response, "x", t0));
    try seed(&ctx, .{ .id = "bobs", .challenge = v.input.challenge, .purpose = .register, .user_id = bob, .expires_at = t0 + minute });
    try expectFailed(passkeys.expired_reason, try passkeys.finishRegistration(app, ctx.alloc(), rp, ada, "bobs", v.input.response, "x", t0));
    try expectFailed(passkeys.expired_reason, try passkeys.finishRegistration(app, ctx.alloc(), rp, ada, "never-issued", v.input.response, "x", t0));
    try seed(&ctx, .{ .id = "edge", .challenge = v.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 });
    try testing.expect((try passkeys.finishRegistration(app, ctx.alloc(), rp, ada, "edge", v.input.response, "x", t0)) == .ok);
}

test "passkeys: origin and rp id are checked on every ceremony" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const credential_id = try register(&ctx, all, ada);
    const login = try vectorNamed(all, "es256: login, counter 1");
    const cases = [_]struct { passkeys.Rp, []const u8 }{
        .{ .{ .id = rp.id, .origin = "http://localhost:4101" }, webauthn.message(error.UnexpectedOrigin) },
        .{ .{ .id = rp.id, .origin = "https://localhost:4100" }, webauthn.message(error.UnexpectedOrigin) },
        .{ .{ .id = "evil.test", .origin = rp.origin }, webauthn.message(error.UnexpectedRpIdHash) },
        .{ .{ .id = "localhost.evil.test", .origin = rp.origin }, webauthn.message(error.UnexpectedRpIdHash) },
    };
    for (cases, 0..) |case, n| {
        const id = try std.fmt.allocPrint(ctx.alloc(), "login-{d}", .{n});
        try seed(&ctx, .{ .id = id, .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + minute });
        try expectFailed(case[1], try passkeys.finishLogin(app, ctx.alloc(), case[0], id, login.input.response, t0));
    }
    // None of the refusals moved the counter.
    try testing.expectEqual(@as(i64, 0), try passkeyCounter(&ctx, credential_id));
}

test "passkeys: a replayed assertion fails on the counter, an unknown credential fails" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    _ = try register(&ctx, all, ada);
    const login = try vectorNamed(all, "es256: login, counter 1");
    try seed(&ctx, .{ .id = "l1", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + minute });
    try testing.expect((try passkeys.finishLogin(app, ctx.alloc(), rp, "l1", login.input.response, t0)) == .ok);
    // The attacker has the very same bytes and a challenge row that matches them.
    try seed(&ctx, .{ .id = "l2", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + minute });
    const replay = try passkeys.finishLogin(app, ctx.alloc(), rp, "l2", login.input.response, t0);
    try testing.expect(replay == .failed);
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT counter FROM passkeys"));

    var stranger = login.input.response;
    stranger.id = "AAAA";
    stranger.rawId = "AAAA";
    try seed(&ctx, .{ .id = "l3", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + minute });
    try expectFailed("unknown credential", try passkeys.finishLogin(app, ctx.alloc(), rp, "l3", stranger, t0));
}

test "passkeys: a credential registered once cannot be registered again, by anyone" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const ada = try ctx.user("a@example.com", false);
    const bob = try ctx.user("b@example.com", false);
    _ = try register(&ctx, all, ada);
    const v = try vectorNamed(all, "es256: registration");
    try seed(&ctx, .{ .id = "again", .challenge = v.input.challenge, .purpose = .register, .user_id = bob, .expires_at = t0 + minute });
    try expectFailed("credential already registered", try passkeys.finishRegistration(&ctx.fx.app, ctx.alloc(), rp, bob, "again", v.input.response, "Phone", t0));
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM passkeys"));
}

test "passkeys: a step-up from another user's session or credential does not stamp anything" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const bob = try ctx.user("b@example.com", false);
    _ = try register(&ctx, all, ada);
    const bobs_session = try sessions.create(app, .{ .user_id = bob, .method = .passkey, .user_agent = null }, t0);
    const step = try vectorNamed(all, "es256: step-up with UV required, counter 2");
    // Bob's session, Bob's challenge, Ada's credential.
    try seed(&ctx, .{ .id = "s1", .challenge = step.input.challenge, .purpose = .step_up, .user_id = bob, .expires_at = t0 + minute });
    try expectFailed("unknown credential", try passkeys.finishStepUp(app, ctx.alloc(), rp, &bobs_session.id, bob, "s1", step.input.response, t0));
    // Ada's credential and challenge on a session that is not hers.
    try seed(&ctx, .{ .id = "s2", .challenge = step.input.challenge, .purpose = .step_up, .user_id = ada, .expires_at = t0 + minute });
    try expectFailed("unknown session", try passkeys.finishStepUp(app, ctx.alloc(), rp, &bobs_session.id, ada, "s2", step.input.response, t0));
    try testing.expectEqual(@as(i64, 0), try ctx.count("SELECT count(*) FROM sessions WHERE step_up_at IS NOT NULL"));
}

test "passkeys: step-up needs user verification and login does not" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    _ = try register(&ctx, all, ada);
    const login = try vectorNamed(all, "es256: authentication, user not verified, not required (login)");
    try seed(&ctx, .{ .id = "a", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + minute });
    try testing.expect((try passkeys.finishLogin(app, ctx.alloc(), rp, "a", login.input.response, t0)) == .ok);
    const session = try sessions.create(app, .{ .user_id = ada, .method = .passkey, .user_agent = null }, t0);
    const weak = try vectorNamed(all, "es256: authentication, user not verified, required (step-up)");
    try seed(&ctx, .{ .id = "b", .challenge = weak.input.challenge, .purpose = .step_up, .user_id = ada, .expires_at = t0 + minute });
    try expectFailed(webauthn.message(error.UserNotVerified), try passkeys.finishStepUp(app, ctx.alloc(), rp, &session.id, ada, "b", weak.input.response, t0));
}

test "passkeys: concurrent responses to one challenge are accepted at most once" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const ada = try ctx.user("a@example.com", false);
    const v = try vectorNamed(all, "es256: registration");
    try seed(&ctx, .{ .id = "one", .challenge = v.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 + minute });
    const Racer = struct {
        fn go(c: *Ctx, vec: Vector, rp: passkeys.Rp, user: []const u8, accepted: *std.atomic.Value(u32)) void {
            var arena: std.heap.ArenaAllocator = .init(testing.allocator);
            defer arena.deinit();
            const outcome = passkeys.finishRegistration(&c.fx.app, arena.allocator(), rp, user, "one", vec.input.response, "k", t0) catch return;
            if (outcome == .ok) _ = accepted.fetchAdd(1, .monotonic);
        }
    };
    var accepted: std.atomic.Value(u32) = .init(0);
    var threads: [6]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Racer.go, .{ &ctx, v, rpOf(all), ada, &accepted });
    for (threads) |thread| thread.join();
    try testing.expectEqual(@as(u32, 1), accepted.load(.monotonic));
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM passkeys"));
}

fn jsonField(arena: std.mem.Allocator, text: []const u8, key: []const u8) !std.json.Value {
    const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, text, .{});
    return root.object.get(key).?;
}

test "passkeys: options carry a challenge id whose row matches, and only a user's own credentials" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const credential_id = try register(&ctx, all, ada);
    try testing.expectEqual(@as(i64, 0), try challengeRows(&ctx));

    const arena = ctx.alloc();
    const login = try passkeys.loginOptions(app, arena, rp, t0);
    try testing.expect(std.mem.find(u8, login, "allowCredentials") == null);
    try testing.expectEqualStrings("preferred", (try jsonField(arena, login, "userVerification")).string);

    const step = try passkeys.stepUpOptions(app, arena, rp, ada, t0);
    const allow = (try jsonField(arena, step, "allowCredentials")).array;
    try testing.expectEqual(@as(usize, 1), allow.items.len);
    try testing.expectEqualStrings(credential_id, allow.items[0].object.get("id").?.string);
    try testing.expectEqualStrings("required", (try jsonField(arena, step, "userVerification")).string);

    const reg = (try passkeys.registrationOptions(app, arena, rp, ada, t0)).?;
    const exclude = (try jsonField(arena, reg, "excludeCredentials")).array;
    try testing.expectEqual(@as(usize, 1), exclude.items.len);
    try testing.expectEqual(@as(i64, 3), try challengeRows(&ctx));

    // Each options call stored a row whose id it returned.
    const id = (try jsonField(arena, reg, "challengeId")).string;
    const stmt = try ctx.fx.db.prepare("SELECT purpose, user_id, challenge FROM challenges WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try testing.expect(try stmt.step());
    try testing.expectEqualStrings("register", (try stmt.text(0)).?);
    try testing.expectEqualStrings(ada, (try stmt.text(1)).?);
    try testing.expectEqualStrings((try jsonField(arena, reg, "challenge")).string, (try stmt.text(2)).?);
}

test "passkeys: options for an unknown user leave no challenge behind, expired rows are swept" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    try testing.expect((try passkeys.registrationOptions(&ctx.fx.app, ctx.alloc(), rp, "ghost", t0)) == null);
    try testing.expectEqual(@as(i64, 0), try challengeRows(&ctx));
    try seed(&ctx, .{ .id = "old", .challenge = "x", .purpose = .login, .user_id = null, .expires_at = t0 - 1 });
    _ = try passkeys.loginOptions(&ctx.fx.app, ctx.alloc(), rp, t0);
    try testing.expectEqual(@as(i64, 1), try challengeRows(&ctx));
}

test "passkeys: the last passkey cannot be deleted and a foreign one is missing" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const bob = try ctx.user("b@example.com", false);
    const credential_id = try register(&ctx, all, ada);
    try ctx.addPasskey(ada, "second");
    try testing.expectEqual(passkeys.Deleted.missing, try passkeys.deletePasskey(app, bob, credential_id));
    try testing.expectEqual(passkeys.Deleted.missing, try passkeys.deletePasskey(app, ada, "nope"));
    try testing.expectEqual(passkeys.Deleted.deleted, try passkeys.deletePasskey(app, ada, "second"));
    try testing.expectEqual(passkeys.Deleted.last, try passkeys.deletePasskey(app, ada, credential_id));
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM passkeys"));
}

test "passkeys: allocation failure at every point of a registration leaves no leak" {
    const Probe = struct {
        fn once(gpa: std.mem.Allocator) !void {
            var ctx = try Ctx.init();
            defer ctx.deinit();
            const all = try fixtures(ctx.alloc());
            const ada = try ctx.user("a@example.com", false);
            const v = try vectorNamed(all, "es256: registration");
            try seed(&ctx, .{ .id = "r", .challenge = v.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 + minute });
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            _ = try passkeys.finishRegistration(&ctx.fx.app, arena.allocator(), rpOf(all), ada, "r", v.input.response, "k", t0);
        }
    };
    // The ceremony's own allocator is `app.gpa`, the testing one, so only the arena fails here; the
    // verifier has its own allocation-failure test in webauthn.zig.
    try testing.checkAllAllocationFailures(testing.allocator, Probe.once, .{});
}

test "passkeys: a stalled claim that was taken over cannot finish the enrollment too" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const rp = rpOf(all);
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const code = try codes.createEnrollment(app, .{ .user_id = ada, .ttl_ms = 10 * minute }, t0);
    const hash = (try codes.enrollmentHash(ctx.alloc(), &code)).?;
    // Request A claims, stalls past the claim window, request B takes the claim over.
    const token_a = (try codes.claimEnrollmentToken(app, ctx.alloc(), &code, t0)).?;
    const token_b = (try codes.claimEnrollmentToken(app, ctx.alloc(), &code, t0 + codes.claim_ttl_ms + 1)).?;
    const first = try vectorNamed(all, "es256: registration");
    try seed(&ctx, .{ .id = "a", .challenge = first.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 + 5 * minute });
    const a = try passkeys.finishRegistrationWith(app, ctx.alloc(), rp, ada, "a", first.input.response, "A", t0 + 1, .{ .hash = hash, .claim = token_a }, null, null);
    const second = try vectorNamed(all, "eddsa: registration");
    try seed(&ctx, .{ .id = "b", .challenge = second.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 + 5 * minute });
    const b = try passkeys.finishRegistrationWith(app, ctx.alloc(), rp, ada, "b", second.input.response, "B", t0 + 2, .{ .hash = hash, .claim = token_b }, null, null);
    // One-time means one: exactly one of the two may have stored a passkey.
    try expectFailed(passkeys.claim_lost_reason, a);
    try testing.expect(b == .ok);
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM passkeys"));
}

test "passkeys: an allocation failure never leaves a passkey stored with its code unused, or the reverse" {
    var index: usize = 0;
    var failures_seen: usize = 0;
    while (index < 64) : (index += 1) {
        var ctx = try Ctx.init();
        defer ctx.deinit();
        const all = try fixtures(ctx.alloc());
        const app = &ctx.fx.app;
        const ada = try ctx.user("a@example.com", false);
        const code = try codes.createEnrollment(app, .{ .user_id = ada, .ttl_ms = 10 * minute }, t0);
        const hash = (try codes.enrollmentHash(ctx.alloc(), &code)).?;
        const token = (try codes.claimEnrollmentToken(app, ctx.alloc(), &code, t0)).?;
        const v = try vectorNamed(all, "es256: registration");
        try seed(&ctx, .{ .id = "r", .challenge = v.input.challenge, .purpose = .register, .user_id = ada, .expires_at = t0 + 5 * minute });
        const set = try codes.drawRecoveryCodes(testing.io);
        // The failing allocator sits on top of the arena so that every single allocation counts.
        var backing: std.heap.ArenaAllocator = .init(testing.allocator);
        defer backing.deinit();
        var failing = std.testing.FailingAllocator.init(backing.allocator(), .{ .fail_index = index });
        const result = passkeys.finishRegistrationWith(app, failing.allocator(), rpOf(all), ada, "r", v.input.response, "k", t0 + 1, .{ .hash = hash, .claim = token }, &set, null);
        const stored = try ctx.count("SELECT count(*) FROM passkeys");
        const used = try ctx.count("SELECT count(*) FROM enrollments WHERE used_at IS NOT NULL");
        if (result) |_| {
            try testing.expectEqual(@as(i64, 1), stored);
            try testing.expectEqual(@as(i64, 1), used);
            try testing.expectEqual(@as(i64, 10), try ctx.count("SELECT count(*) FROM recovery_codes"));
        } else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            failures_seen += 1;
            // A failure is only acceptable when nothing was committed.
            try testing.expectEqual(@as(i64, 0), stored);
            try testing.expectEqual(@as(i64, 0), used);
            try testing.expectEqual(@as(i64, 0), try ctx.count("SELECT count(*) FROM recovery_codes"));
        }
        if (!failing.has_induced_failure) break;
    }
    try testing.expect(failures_seen > 0);
}

const Interleave = struct {
    var ctx: *Ctx = undefined;
    var rp: passkeys.Rp = undefined;
    var response: webauthn.Credential = undefined;
    var second_ok: bool = false;

    fn second() void {
        passkeys.between_verify_and_store = null;
        const outcome = passkeys.finishLogin(&ctx.fx.app, ctx.alloc(), rp, "l2", response, t0 + 2) catch return;
        second_ok = outcome == .ok;
    }
};

test "passkeys: two assertions that read the same counter cannot both succeed" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const all = try fixtures(ctx.alloc());
    const ada = try ctx.user("a@example.com", false);
    _ = try register(&ctx, all, ada);
    const login = try vectorNamed(all, "es256: login, counter 1");
    try seed(&ctx, .{ .id = "l1", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + 5 * minute });
    try seed(&ctx, .{ .id = "l2", .challenge = login.input.challenge, .purpose = .login, .user_id = null, .expires_at = t0 + 5 * minute });
    Interleave.ctx = &ctx;
    Interleave.rp = rpOf(all);
    Interleave.response = login.input.response;
    Interleave.second_ok = false;
    passkeys.between_verify_and_store = Interleave.second;
    defer passkeys.between_verify_and_store = null;
    // The second assertion runs to the end while the first is between verifying and storing.
    const first = try passkeys.finishLogin(&ctx.fx.app, ctx.alloc(), rpOf(all), "l1", login.input.response, t0 + 1);
    try testing.expect(Interleave.second_ok);
    try expectFailed(webauthn.message(error.CounterNotIncreased), first);
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT counter FROM passkeys"));
}
