const std = @import("std");
const App = @import("../app.zig").App;
const Fixture = @import("fixture.zig").Fixture;
const sessions = @import("sessions.zig");

const testing = std.testing;
const t0: i64 = 1_700_000_000_000;

fn fixture(user_ids: []const []const u8) !*Fixture {
    const fx = try Fixture.create(testing.allocator, testing.io);
    errdefer fx.destroy();
    for (user_ids) |id| try fx.addUser(id, std.mem.eql(u8, id, "admin"));
    return fx;
}

fn lookupArena(fx: *Fixture, token: []const u8, now: i64, arena: *std.heap.ArenaAllocator) !?sessions.Session {
    return sessions.lookup(&fx.app, arena.allocator(), token, now);
}

/// One scalar from the sessions table, for asserting what is stored.
fn column(fx: *Fixture, comptime sql: [:0]const u8, id: []const u8) !?i64 {
    const stmt = try fx.db.prepare(sql);
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try testing.expect(try stmt.step());
    return if (stmt.isNull(0)) null else stmt.int(0);
}

test "sessions: a created session is found, and only its hash is stored" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = "agent/1" }, t0);

    try testing.expectEqual(@as(usize, 43), created.token.len);
    for (created.token) |ch| try testing.expect(std.ascii.isAlphanumeric(ch) or ch == '-' or ch == '_');

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const found = (try lookupArena(fx, &created.token, t0 + 1, &arena)).?;
    try testing.expectEqualStrings(&created.id, found.id);
    try testing.expectEqualStrings("u1", found.user_id);
    try testing.expectEqual(sessions.Method.passkey, found.method);
    try testing.expect(!found.instance_admin and !found.slid and found.step_up_at == null);

    const stmt = try fx.db.prepare("SELECT token_hash, user_agent, created_at, last_seen_at, expires_at FROM sessions");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    const stored = (try stmt.text(0)).?;
    try testing.expectEqualStrings(&sessions.tokenHash(&created.token), stored);
    try testing.expect(!std.mem.eql(u8, stored, &created.token));
    try testing.expectEqual(@as(usize, 64), stored.len);
    try testing.expectEqualStrings("agent/1", (try stmt.text(1)).?);
    try testing.expectEqual(t0, stmt.int(2));
    try testing.expectEqual(t0, stmt.int(3));
    try testing.expectEqual(t0 + sessions.ttl_ms, stmt.int(4));
}

test "sessions: token hash is sha256 hex of the token" {
    // echo -n abc | shasum -a 256
    try testing.expectEqualStrings(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        &sessions.tokenHash("abc"),
    );
}

test "sessions: unknown, empty and near-miss tokens find nothing" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expect(try lookupArena(fx, "", t0, &arena) == null);
    try testing.expect(try lookupArena(fx, "not-a-token", t0, &arena) == null);
    var altered = created.token;
    altered[0] = if (altered[0] == 'A') 'B' else 'A';
    try testing.expect(try lookupArena(fx, &altered, t0, &arena) == null);
    try testing.expect(try lookupArena(fx, created.token[0 .. created.token.len - 1], t0, &arena) == null);
}

test "sessions: absolute expiry is exclusive at expires_at" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    // `expires_at > now`: alive one ms before the deadline, gone at it.
    try testing.expect(try sessions.expiresAt(&fx.app, &created.id, t0 + sessions.ttl_ms - 1) != null);
    try testing.expectEqual(@as(?i64, null), try sessions.expiresAt(&fx.app, &created.id, t0 + sessions.ttl_ms));
    try testing.expect(try lookupArena(fx, &created.token, t0 + sessions.ttl_ms, &arena) == null);
    try testing.expect(try lookupArena(fx, &created.token, t0 + sessions.ttl_ms - 1, &arena) != null);
}

test "sessions: the expiry slides once per hour of inactivity" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();

    const early = (try lookupArena(fx, &created.token, t0 + sessions.slide_every_ms - 1, &arena)).?;
    try testing.expect(!early.slid);
    try testing.expectEqual(@as(?i64, t0), try column(fx, "SELECT last_seen_at FROM sessions WHERE id = ?", &created.id));
    try testing.expectEqual(@as(?i64, t0 + sessions.ttl_ms), try column(fx, "SELECT expires_at FROM sessions WHERE id = ?", &created.id));

    const at = t0 + sessions.slide_every_ms;
    const slid = (try lookupArena(fx, &created.token, at, &arena)).?;
    try testing.expect(slid.slid);
    try testing.expectEqual(@as(?i64, at), try column(fx, "SELECT last_seen_at FROM sessions WHERE id = ?", &created.id));
    try testing.expectEqual(@as(?i64, at + sessions.ttl_ms), try column(fx, "SELECT expires_at FROM sessions WHERE id = ?", &created.id));

    // The slide restarted the hour.
    const again = (try lookupArena(fx, &created.token, at + 1, &arena)).?;
    try testing.expect(!again.slid);
    try testing.expectEqual(at + sessions.ttl_ms, (try sessions.expiresAt(&fx.app, &created.id, at + 1)).?);
}

test "sessions: a session kept alive by sliding outlives its first thirty days" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var now = t0;
    while (now < t0 + 2 * sessions.ttl_ms) : (now += sessions.slide_every_ms * 24) {
        try testing.expect(try lookupArena(fx, &created.token, now, &arena) != null);
    }
    // And a gap longer than the TTL ends it.
    try testing.expect(try lookupArena(fx, &created.token, now + sessions.ttl_ms + 1, &arena) == null);
}

test "sessions: revocation takes effect on the next lookup and only once" {
    const fx = try fixture(&.{ "u1", "u2" });
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expect(try lookupArena(fx, &created.token, t0, &arena) != null);

    try testing.expect(!try sessions.revoke(&fx.app, "u2", &created.id, t0 + 1));
    try testing.expect(try lookupArena(fx, &created.token, t0 + 1, &arena) != null);
    try testing.expect(!try sessions.revoke(&fx.app, "u1", "no-such-session", t0 + 1));

    try testing.expect(try sessions.revoke(&fx.app, "u1", &created.id, t0 + 2));
    try testing.expect(try lookupArena(fx, &created.token, t0 + 2, &arena) == null);
    try testing.expectEqual(@as(?i64, null), try sessions.expiresAt(&fx.app, &created.id, t0 + 2));
    try testing.expect(!try sessions.revoke(&fx.app, "u1", &created.id, t0 + 3));
    // The first revocation time stays.
    try testing.expectEqual(@as(?i64, t0 + 2), try column(fx, "SELECT revoked_at FROM sessions WHERE id = ?", &created.id));
}

test "sessions: recovery and enroll sessions start with a fresh step-up, others without" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    for ([_]struct { sessions.Method, bool }{
        .{ .passkey, false },
        .{ .email, false },
        .{ .recovery, true },
        .{ .enroll, true },
    }) |case| {
        const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = case[0], .user_agent = null }, t0);
        const found = (try lookupArena(fx, &created.token, t0, &arena)).?;
        try testing.expectEqual(case[0], found.method);
        try testing.expectEqual(@as(?i64, if (case[1]) t0 else null), found.step_up_at);
        try testing.expectEqual(case[1], sessions.hasFreshStepUp(found.step_up_at, t0 + 1));
    }
}

test "sessions: step-up freshness window is five minutes, exclusive" {
    try testing.expect(!sessions.hasFreshStepUp(null, t0));
    try testing.expect(sessions.hasFreshStepUp(t0, t0));
    try testing.expect(sessions.hasFreshStepUp(t0, t0 + sessions.step_up_ms - 1));
    try testing.expect(!sessions.hasFreshStepUp(t0, t0 + sessions.step_up_ms));
    try testing.expect(sessions.hasFreshStepUp(t0 + 10, t0));
    try testing.expect(!sessions.hasFreshStepUp(std.math.minInt(i64), std.math.maxInt(i64)));
}

test "sessions: the instance admin flag and the step-up stamp come from the rows" {
    const fx = try fixture(&.{ "admin", "plain" });
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const admin = try sessions.create(&fx.app, .{ .user_id = "admin", .method = .passkey, .user_agent = null }, t0);
    const plain = try sessions.create(&fx.app, .{ .user_id = "plain", .method = .passkey, .user_agent = null }, t0);
    try testing.expect((try lookupArena(fx, &admin.token, t0, &arena)).?.instance_admin);
    try testing.expect(!(try lookupArena(fx, &plain.token, t0, &arena)).?.instance_admin);

    try fx.run("UPDATE sessions SET step_up_at = 12345");
    try testing.expectEqual(@as(?i64, 12345), (try lookupArena(fx, &plain.token, t0, &arena)).?.step_up_at);
}

test "sessions: every call refuses to run without a database" {
    var app = App.init(testing.allocator, testing.io);
    try testing.expectError(error.NoDatabase, sessions.create(&app, .{ .user_id = "u", .method = .passkey, .user_agent = null }, t0));
    try testing.expectError(error.NoDatabase, sessions.lookup(&app, testing.allocator, "x", t0));
    try testing.expectError(error.NoDatabase, sessions.revoke(&app, "u", "s", t0));
    try testing.expectError(error.NoDatabase, sessions.expiresAt(&app, "s", t0));
}

test "sessions: a session of an unknown user cannot be created" {
    const fx = try fixture(&.{});
    defer fx.destroy();
    try testing.expectError(error.Constraint, sessions.create(&fx.app, .{ .user_id = "ghost", .method = .passkey, .user_agent = null }, t0));
}

fn lookupUnderFailure(alloc: std.mem.Allocator, fx: *Fixture, token: []const u8) !void {
    const found = try sessions.lookup(&fx.app, alloc, token, t0 + 1);
    if (found) |session| {
        alloc.free(session.id);
        alloc.free(session.user_id);
    }
}

test "sessions: lookup survives every allocation failure without leaking" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    try testing.checkAllAllocationFailures(testing.allocator, lookupUnderFailure, .{ fx, @as([]const u8, &created.token) });
}

const Hammer = struct {
    fx: *Fixture,
    user: []const u8,
    failed: std.atomic.Value(bool) = .init(false),

    fn fail(self: *Hammer) void {
        self.failed.store(true, .release);
    }

    fn run(self: *Hammer) void {
        for (0..60) |i| {
            var arena: std.heap.ArenaAllocator = .init(testing.allocator);
            defer arena.deinit();
            const now = t0 + @as(i64, @intCast(i));
            const created = sessions.create(&self.fx.app, .{ .user_id = self.user, .method = .passkey, .user_agent = null }, now) catch return self.fail();
            const found = sessions.lookup(&self.fx.app, arena.allocator(), &created.token, now) catch return self.fail();
            if (found == null) return self.fail();
            const revoked = sessions.revoke(&self.fx.app, self.user, &created.id, now) catch return self.fail();
            if (!revoked) return self.fail();
            // A revoked session is dead for every thread at once, not only for the one that revoked it.
            const after = sessions.lookup(&self.fx.app, arena.allocator(), &created.token, now) catch return self.fail();
            if (after != null) return self.fail();
            const twice = sessions.revoke(&self.fx.app, self.user, &created.id, now) catch return self.fail();
            if (twice) return self.fail();
        }
    }
};

test "sessions: threads creating, looking up and revoking never see a revoked session alive" {
    const fx = try fixture(&.{ "a", "b", "c", "d" });
    defer fx.destroy();
    var hammers: [4]Hammer = undefined;
    for (&hammers, [_][]const u8{ "a", "b", "c", "d" }) |*hammer, user| hammer.* = .{ .fx = fx, .user = user };
    var threads: [4]std.Thread = undefined;
    for (&threads, &hammers) |*thread, *hammer| thread.* = try std.Thread.spawn(.{}, Hammer.run, .{hammer});
    for (threads) |thread| thread.join();
    for (&hammers) |*hammer| try testing.expect(!hammer.failed.load(.acquire));
    const stmt = try fx.db.prepare("SELECT count(*) FROM sessions WHERE revoked_at IS NULL");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqual(@as(i64, 0), stmt.int(0));
}

test "sessions: threads sliding one session agree on a single slide per hour" {
    const fx = try fixture(&.{"u1"});
    defer fx.destroy();
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    const Slider = struct {
        fx: *Fixture,
        token: []const u8,
        slides: std.atomic.Value(u32) = .init(0),
        broken: std.atomic.Value(bool) = .init(false),

        fn run(self: *@This()) void {
            for (0..40) |_| {
                var arena: std.heap.ArenaAllocator = .init(testing.allocator);
                defer arena.deinit();
                const found = sessions.lookup(&self.fx.app, arena.allocator(), self.token, t0 + sessions.slide_every_ms) catch return self.broken.store(true, .release);
                const session = found orelse return self.broken.store(true, .release);
                if (session.slid) _ = self.slides.fetchAdd(1, .acq_rel);
            }
        }
    };
    var slider: Slider = .{ .fx = fx, .token = &created.token };
    var threads: [4]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Slider.run, .{&slider});
    for (threads) |thread| thread.join();
    try testing.expect(!slider.broken.load(.acquire));
    try testing.expectEqual(@as(u32, 1), slider.slides.load(.acquire));
}
