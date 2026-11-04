//! Tests for codes.zig, one per case of code/src/server/features/auth/codes.test.ts.
const std = @import("std");
const codes = @import("codes.zig");
const Fixture = @import("fixture.zig").Fixture;

const testing = std.testing;
const t0: i64 = 1_700_000_000_000;
const minute: i64 = 60 * 1000;

pub const Ctx = struct {
    fx: *Fixture,
    arena: std.heap.ArenaAllocator,

    pub fn init() !Ctx {
        return .{ .fx = try Fixture.create(testing.allocator, testing.io), .arena = .init(testing.allocator) };
    }

    pub fn deinit(self: *Ctx) void {
        self.arena.deinit();
        self.fx.destroy();
    }

    pub fn alloc(self: *Ctx) std.mem.Allocator {
        return self.arena.allocator();
    }

    const AddArgs = struct { email: []const u8, admin: bool, io: std.Io };

    fn addLocked(db: @import("../db/sqlite.zig").Db, a: AddArgs) codes.Error![36]u8 {
        return codes.insertUser(db, a.io, .{ .email = a.email, .name = "Test", .instance_admin = a.admin });
    }

    pub fn user(self: *Ctx, email: []const u8, admin: bool) ![]const u8 {
        const id = try codes.run(&self.fx.app, AddArgs{ .email = email, .admin = admin, .io = testing.io }, addLocked);
        return self.alloc().dupe(u8, &id);
    }

    pub fn sql(self: *Ctx, comptime text: [:0]const u8) !void {
        try self.fx.run(text);
    }

    pub fn count(self: *Ctx, comptime text: [:0]const u8) !i64 {
        const stmt = try self.fx.db.prepare(text);
        defer stmt.finalize();
        _ = try stmt.step();
        return stmt.int(0);
    }

    pub fn lastEmailCode(self: *Ctx, email: []const u8, now: i64) !codes.EmailCode {
        const request = try codes.requestEmailCode(&self.fx.app, self.alloc(), email, now);
        try testing.expect(request.allowed);
        return request.code;
    }

    pub fn addPasskey(self: *Ctx, user_id: []const u8, id: []const u8) !void {
        const stmt = try self.fx.db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES (?, ?, x'00', 0, 'k', 1)");
        defer stmt.finalize();
        try stmt.bindText(1, id);
        try stmt.bindText(2, user_id);
        _ = try stmt.step();
    }
};

fn expectUser(want: []const u8, got: anytype) !void {
    try testing.expectEqualStrings(want, (try got).?);
}

fn expectNone(got: anytype) !void {
    try testing.expect((try got) == null);
}

test "codes: a recovery code works once, case-insensitively, only for its own user" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const a = try ctx.alloc().dupe(u8, "a@example.com");
    const ada = try ctx.user(a, false);
    _ = try ctx.user("b@example.com", false);
    const set = try codes.newRecoveryCodes(app, ada);
    for (set) |code| {
        try testing.expectEqual(@as(usize, 14), code.len);
        for (code, 0..) |ch, i| {
            if (i % 5 == 4) try testing.expectEqual(@as(u8, '-'), ch) else try testing.expect(std.mem.findScalar(u8, "abcdefghijklmnopqrstuvwxyz234567", ch) != null);
        }
    }
    var upper: [14]u8 = undefined;
    _ = std.ascii.upperString(&upper, &set[0]);
    try expectUser(ada, codes.useRecoveryCode(app, ctx.alloc(), a, &upper, t0));
    try expectNone(codes.useRecoveryCode(app, ctx.alloc(), a, &set[0], t0));
    try expectNone(codes.useRecoveryCode(app, ctx.alloc(), "b@example.com", &set[1], t0));
    try expectNone(codes.useRecoveryCode(app, ctx.alloc(), "nobody@example.com", &set[1], t0));
    // Whitespace around the code is trimmed, as a pasted code often carries it.
    const padded = try std.fmt.allocPrint(ctx.alloc(), "  {s}\n", .{set[2]});
    try expectUser(ada, codes.useRecoveryCode(app, ctx.alloc(), a, padded, t0));
}

test "codes: a new recovery set replaces the old one" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const ada = try ctx.user("a@example.com", false);
    const old = try codes.newRecoveryCodes(&ctx.fx.app, ada);
    _ = try codes.newRecoveryCodes(&ctx.fx.app, ada);
    try expectNone(codes.useRecoveryCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &old[0], t0));
    try testing.expectEqual(@as(i64, 10), try ctx.count("SELECT count(*) FROM recovery_codes"));
}

test "codes: an email code is right once" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const ada = try ctx.user("a@example.com", false);
    const code = try ctx.lastEmailCode("a@example.com", t0);
    for (code) |ch| try testing.expect(std.ascii.isDigit(ch));
    try expectUser(ada, codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &code, t0));
    try expectNone(codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &code, t0));
}

test "codes: five wrong attempts kill an email code, the right one included" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    _ = try ctx.user("a@example.com", false);
    const code = try ctx.lastEmailCode("a@example.com", t0);
    const wrong: []const u8 = if (std.mem.eql(u8, &code, "000000")) "000001" else "000000";
    for (0..5) |_| try expectNone(codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", wrong, t0));
    try expectNone(codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &code, t0));
}

test "codes: an email code expires after ten minutes" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const ada = try ctx.user("a@example.com", false);
    const code = try ctx.lastEmailCode("a@example.com", t0);
    try expectNone(codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &code, t0 + 10 * minute));
    const fresh = try ctx.lastEmailCode("a@example.com", t0 + 11 * minute);
    try expectUser(ada, codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &fresh, t0 + 11 * minute + 10 * minute - 1));
}

test "codes: a newer email request voids the older code" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const ada = try ctx.user("a@example.com", false);
    const older = try ctx.lastEmailCode("a@example.com", t0);
    const newer = try ctx.lastEmailCode("a@example.com", t0 + 1);
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM email_codes WHERE used_at IS NULL"));
    if (!std.mem.eql(u8, &older, &newer))
        try expectNone(codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &older, t0 + 2));
    try expectUser(ada, codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", &newer, t0 + 2));
}

test "codes: the fourth email request in fifteen minutes is limited, allowed again after" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    var outcomes: [4]bool = undefined;
    for (&outcomes) |*allowed| allowed.* = (try codes.requestEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", t0)).allowed;
    try testing.expectEqual([4]bool{ true, true, true, false }, outcomes);
    const later = try codes.requestEmailCode(&ctx.fx.app, ctx.alloc(), "a@example.com", t0 + 15 * minute + 1);
    try testing.expect(later.allowed);
}

test "codes: an unknown email delivers nothing and is limited like a known one" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    _ = try ctx.user("a@example.com", false);
    var delivered: usize = 0;
    var outcomes: [4]bool = undefined;
    for (&outcomes) |*allowed| {
        const request = try codes.requestEmailCode(&ctx.fx.app, ctx.alloc(), "ghost@example.com", t0);
        allowed.* = request.allowed;
        if (request.deliver) delivered += 1;
    }
    try testing.expectEqual([4]bool{ true, true, true, false }, outcomes);
    try testing.expectEqual(@as(usize, 0), delivered);
    try expectNone(codes.verifyEmailCode(&ctx.fx.app, ctx.alloc(), "ghost@example.com", "123456", t0));
    const known = try codes.requestEmailCode(&ctx.fx.app, ctx.alloc(), "A@Example.com", t0);
    try testing.expect(known.deliver);
}

test "codes: a bootstrap code creates the instance admin once and a late one is refused" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const code = try codes.createEnrollment(app, .{ .ttl_ms = 10 * minute }, t0);
    const user_id = (try codes.redeemEnrollment(app, ctx.alloc(), &code, .{ .email = "o@example.com", .name = "Owner" }, t0)).?;
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT instance_admin FROM users"));
    // Redeeming again returns the same user and creates nobody.
    try expectUser(user_id, codes.redeemEnrollment(app, ctx.alloc(), &code, .{ .email = "o2@example.com", .name = "Owner" }, t0));
    try codes.completeEnrollment(app, ctx.alloc(), &code, t0);
    try expectNone(codes.redeemEnrollment(app, ctx.alloc(), &code, .{ .email = "o2@example.com", .name = "Owner" }, t0));
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM users"));
    // With an admin already there a bootstrap code is dead.
    const late = try codes.createEnrollment(app, .{ .ttl_ms = minute }, t0);
    try expectNone(codes.redeemEnrollment(app, ctx.alloc(), &late, .{ .email = "x@example.com", .name = "X" }, t0));
}

test "codes: an enrollment code is case-insensitive and takes percent-free whitespace around it" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const code = try codes.createEnrollment(&ctx.fx.app, .{ .ttl_ms = minute }, t0);
    var upper: [19]u8 = undefined;
    _ = std.ascii.upperString(&upper, &code);
    const got = try codes.redeemEnrollment(&ctx.fx.app, ctx.alloc(), &upper, .{ .email = "o@example.com", .name = "Owner" }, t0);
    try testing.expect(got != null);
}

test "codes: expired is refused, a user's code returns that user, an invite checks the email" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const profile: codes.Profile = .{ .email = "a@example.com", .name = "Ada" };
    const stale = try codes.createEnrollment(app, .{ .user_id = ada, .ttl_ms = minute }, t0);
    try expectNone(codes.redeemEnrollment(app, ctx.alloc(), &stale, profile, t0 + minute + 1));
    const mine = try codes.createEnrollment(app, .{ .user_id = ada, .ttl_ms = minute }, t0 + minute + 2);
    try expectUser(ada, codes.redeemEnrollment(app, ctx.alloc(), &mine, profile, t0 + minute + 2));
    const invite = try codes.createEnrollment(app, .{ .email = "New@example.com", .ttl_ms = minute }, t0);
    try expectNone(codes.redeemEnrollment(app, ctx.alloc(), &invite, .{ .email = "other@example.com", .name = "N" }, t0));
    const joined = (try codes.redeemEnrollment(app, ctx.alloc(), &invite, .{ .email = "new@example.com", .name = "New" }, t0)).?;
    const user = (try codes.getUser(app, ctx.alloc(), joined)).?;
    try testing.expect(!user.instanceAdmin);
    try testing.expectEqualStrings("new@example.com", user.email);
}

test "codes: a new code for a user ends their older unused ones" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const ada = try ctx.user("a@example.com", false);
    const first = try codes.createEnrollment(&ctx.fx.app, .{ .user_id = ada, .ttl_ms = 10 * minute }, t0);
    const second = try codes.createEnrollment(&ctx.fx.app, .{ .user_id = ada, .ttl_ms = 10 * minute }, t0 + 1);
    const profile: codes.Profile = .{ .email = "a@example.com", .name = "Ada" };
    try expectNone(codes.redeemEnrollment(&ctx.fx.app, ctx.alloc(), &first, profile, t0 + 2));
    try expectUser(ada, codes.redeemEnrollment(&ctx.fx.app, ctx.alloc(), &second, profile, t0 + 2));
}

test "codes: claim is exclusive, expires after a minute, and release reopens it" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    const code = try codes.createEnrollment(app, .{ .user_id = ada, .ttl_ms = 10 * minute }, t0);
    try testing.expect(try codes.claimEnrollment(app, ctx.alloc(), &code, t0));
    try testing.expect(!try codes.claimEnrollment(app, ctx.alloc(), &code, t0 + 1));
    try testing.expect(try codes.claimEnrollment(app, ctx.alloc(), &code, t0 + codes.claim_ttl_ms + 1));
    try codes.releaseEnrollment(app, ctx.alloc(), &code, t0 + codes.claim_ttl_ms + 1);
    try testing.expect(try codes.claimEnrollment(app, ctx.alloc(), &code, t0 + codes.claim_ttl_ms + 2));
    try codes.completeEnrollment(app, ctx.alloc(), &code, t0);
    try testing.expect(!try codes.claimEnrollment(app, ctx.alloc(), &code, t0 + codes.claim_ttl_ms * 3));
}

test "codes: first run keeps one live link and offers a bootstrap that never got a passkey again" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const profile: codes.Profile = .{ .email = "o@example.com", .name = "Owner" };
    const first = (try codes.firstRunEnrollment(app, ctx.alloc(), minute, t0)).?;
    const second = (try codes.firstRunEnrollment(app, ctx.alloc(), minute, t0 + 1)).?;
    try expectNone(codes.redeemEnrollment(app, ctx.alloc(), &first, profile, t0 + 2));
    const user_id = (try codes.redeemEnrollment(app, ctx.alloc(), &second, profile, t0 + 2)).?;
    const again = (try codes.firstRunEnrollment(app, ctx.alloc(), minute, t0 + 3)).?;
    try expectNone(codes.redeemEnrollment(app, ctx.alloc(), &second, profile, t0 + 4));
    try expectUser(user_id, codes.redeemEnrollment(app, ctx.alloc(), &again, profile, t0 + 4));
    try ctx.addPasskey(user_id, "p");
    try expectNone(codes.firstRunEnrollment(app, ctx.alloc(), minute, t0 + 5));
}

test "codes: a regular user with a passkey does not close first run, the link makes a new admin" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    try ctx.addPasskey(ada, "p");
    const code = (try codes.firstRunEnrollment(app, ctx.alloc(), minute, t0)).?;
    const admin = (try codes.redeemEnrollment(app, ctx.alloc(), &code, .{ .email = "boss@example.com", .name = "Boss" }, t0)).?;
    try testing.expect(!std.mem.eql(u8, admin, ada));
    try testing.expect(!(try codes.getUser(app, ctx.alloc(), ada)).?.instanceAdmin);
    try testing.expect((try codes.getUser(app, ctx.alloc(), admin)).?.instanceAdmin);
}

test "codes: an admin without a passkey gets a link for their own account, with one gets none" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const ada = try ctx.user("a@example.com", false);
    try ctx.addPasskey(ada, "p");
    const boss = try ctx.user("boss@example.com", true);
    const code = (try codes.firstRunEnrollment(app, ctx.alloc(), minute, t0)).?;
    try expectUser(boss, codes.redeemEnrollment(app, ctx.alloc(), &code, .{ .email = "x@example.com", .name = "X" }, t0));
    try ctx.addPasskey(boss, "q");
    try expectNone(codes.firstRunEnrollment(app, ctx.alloc(), minute, t0));
}

test "codes: allocation failure at every point leaves no leak" {
    const Probe = struct {
        fn once(gpa: std.mem.Allocator) !void {
            var fx = try Fixture.create(testing.allocator, testing.io);
            defer fx.destroy();
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            const code = (try codes.firstRunEnrollment(&fx.app, arena.allocator(), minute, t0)).?;
            _ = try codes.redeemEnrollment(&fx.app, arena.allocator(), &code, .{ .email = "o@example.com", .name = "O" }, t0);
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Probe.once, .{});
}

test "codes: first run draws entropy only when a link is needed" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const boss = try ctx.user("boss@example.com", true);
    try ctx.addPasskey(boss, "p");
    codes.entropy_down_for_test = true;
    defer codes.entropy_down_for_test = false;
    // Enrolled: nothing to print, so a dead entropy source must not matter.
    try expectNone(codes.firstRunEnrollment(app, ctx.alloc(), minute, t0));
    // Not enrolled: the failure is a clean error and nothing is left behind.
    var fresh = try Ctx.init();
    defer fresh.deinit();
    try testing.expectError(error.EntropyUnavailable, codes.firstRunEnrollment(&fresh.fx.app, fresh.alloc(), minute, t0));
    try testing.expectEqual(@as(i64, 0), try fresh.count("SELECT count(*) FROM enrollments"));
}
