const std = @import("std");
const httpz = @import("httpz");
const App = @import("../app.zig").App;
const Fixture = @import("fixture.zig").Fixture;
const middleware = @import("middleware.zig");
const policy = @import("../http/policy.zig");
const routes = @import("../http/routes.zig");
const server_mod = @import("../http/server.zig");
const sessions = @import("sessions.zig");

const testing = std.testing;
const t0: i64 = 1_700_000_000_000;

var fake_now: std.atomic.Value(i64) = .init(t0);

fn fakeClock(_: std.Io) i64 {
    return fake_now.load(.acquire);
}

fn setNow(ms: i64) void {
    fake_now.store(ms, .release);
}

// ---- cookies ----

fn cookieOf(header: []const u8) !?[]const u8 {
    return middleware.cookieValue(testing.allocator, header, middleware.cookie_name);
}

test "middleware: the cookie value is found among other cookies and trimmed" {
    try testing.expectEqualStrings("abc", (try cookieOf("harness_session=abc")).?);
    try testing.expectEqualStrings("abc", (try cookieOf("a=1; harness_session=abc; b=2")).?);
    try testing.expectEqualStrings("abc", (try cookieOf("a=1;\tharness_session = abc ;b=2")).?);
    try testing.expectEqualStrings("", (try cookieOf("harness_session=")).?);
    try testing.expect(try cookieOf("") == null);
    try testing.expect(try cookieOf("a=1; b=2") == null);
    try testing.expect(try cookieOf("harness_sessionx=abc") == null);
    try testing.expect(try cookieOf("xharness_session=abc") == null);
    try testing.expect(try cookieOf("harness_session") == null);
    try testing.expect(try cookieOf("Harness_Session=abc") == null);
}

test "middleware: quotes are dropped, an illegal value is skipped for the next pair" {
    try testing.expectEqualStrings("abc", (try cookieOf("harness_session=\"abc\"")).?);
    try testing.expectEqualStrings("", (try cookieOf("harness_session=\"")).?);
    try testing.expectEqualStrings("abc", (try cookieOf("harness_session=a\\b; harness_session=abc")).?);
    try testing.expectEqualStrings("first", (try cookieOf("harness_session=first; harness_session=second")).?);
    try testing.expect(try cookieOf("harness_session=a\"b") == null);
    try testing.expect(try cookieOf("harness_session=caf\xc3\xa9") == null);
    try testing.expect(try cookieOf("harness_session=a\x01b") == null);
}

test "middleware: percent escapes are decoded like decodeURIComponent with Hono's fallback" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_][2][]const u8{
        .{ "harness_session=a%41b", "aAb" },
        .{ "harness_session=%C3%A9", "\xc3\xa9" },
        .{ "harness_session=100%", "100%" },
        .{ "harness_session=%zz", "%zz" },
        .{ "harness_session=%4", "%4" },
        .{ "harness_session=%FF%41", "%FF%41" },
        .{ "harness_session=%41%FF", "%41%FF" },
        .{ "harness_session=%41%FFx%41", "%41%FFxA" },
        .{ "harness_session=%E2%82", "%E2%82" },
        .{ "harness_session=%E2%82%AC", "\xe2\x82\xac" },
        .{ "harness_session=%ff%fe", "%ff%fe" },
        .{ "harness_session=a%f0%9f%98%80b", "a\xf0\x9f\x98\x80b" },
    };
    for (cases) |case| try testing.expectEqualStrings(case[1], (try middleware.cookieValue(arena.allocator(), case[0], middleware.cookie_name)).?);
}

test "middleware: the session cookie has Hono's attributes in Hono's order" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqualStrings(
        "harness_session=tok-en_1; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict",
        try middleware.sessionCookie(arena.allocator(), "tok-en_1", false),
    );
    try testing.expectEqualStrings(
        "harness_session=tok-en_1; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict",
        try middleware.sessionCookie(arena.allocator(), "tok-en_1", true),
    );
    try testing.expectError(error.UnsafeToken, middleware.sessionCookie(arena.allocator(), "a;b", true));
    try testing.expectError(error.UnsafeToken, middleware.sessionCookie(arena.allocator(), "", true));
    try testing.expectEqualStrings("harness_session=; Max-Age=0; Path=/", middleware.cleared_cookie);
}

fn cookieHelpersUnderFailure(alloc: std.mem.Allocator) !void {
    const cookie = try middleware.sessionCookie(alloc, "token", true);
    alloc.free(cookie);
    var arena: std.heap.ArenaAllocator = .init(alloc);
    defer arena.deinit();
    const decoded = try middleware.cookieValue(arena.allocator(), "harness_session=%41%C3%A9%FF", middleware.cookie_name);
    try testing.expectEqualStrings("%41%C3%A9%FF", decoded.?);
}

test "middleware: cookie helpers survive every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, cookieHelpersUnderFailure, .{});
}

// ---- the authenticator ----

const AuthFx = struct {
    fx: *Fixture,
    auth: middleware.SessionAuth,

    fn create(secure: bool) !*AuthFx {
        const self = try testing.allocator.create(AuthFx);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, testing.io);
        errdefer self.fx.destroy();
        self.auth = middleware.SessionAuth.init(&self.fx.app, if (secure) "https://harness.example.com" else null);
        self.auth.clock = fakeClock;
        setNow(t0);
        return self;
    }

    fn destroy(self: *AuthFx) void {
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn run(self: *AuthFx, web: *httpz.testing.Testing) !?policy.Actor {
        const installed = self.auth.authenticator();
        return installed.authenticate(installed.ctx, web.req, web.res);
    }
};

fn requestWith(path: []const u8, cookie: ?[]const u8) httpz.testing.Testing {
    var web = httpz.testing.init(.{});
    web.url(path);
    if (cookie) |value| web.header("cookie", value);
    return web;
}

fn cookieFor(created: sessions.Created) [64]u8 {
    var out: [64]u8 = @splat(0);
    _ = std.fmt.bufPrint(&out, "harness_session={s}", .{created.token}) catch unreachable;
    return out;
}

test "middleware: a valid cookie becomes an actor, a fresh one sets no cookie" {
    const fx = try AuthFx.create(false);
    defer fx.destroy();
    try fx.fx.addUser("admin", true);
    const created = try sessions.create(&fx.fx.app, .{ .user_id = "admin", .method = .recovery, .user_agent = null }, t0);
    const cookie = cookieFor(created);

    var web = requestWith("/api/auth/me", cookie[0 .. "harness_session=".len + created.token.len]);
    defer web.deinit();
    const actor = (try fx.run(&web)).?;
    try testing.expectEqualStrings("admin", actor.user_id);
    try testing.expectEqualStrings(&created.id, actor.session_id);
    try testing.expectEqualStrings("recovery", actor.method);
    try testing.expectEqual(@as(?i64, t0), actor.step_up_at);
    try testing.expect(actor.instance_admin);
    try testing.expect(web.res.headers.get("set-cookie") == null);
}

test "middleware: no cookie, garbage, an empty value and a bearer token are all no session" {
    const fx = try AuthFx.create(false);
    defer fx.destroy();
    try fx.fx.addUser("u1", false);
    const created = try sessions.create(&fx.fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);

    var none = requestWith("/api/auth/me", null);
    defer none.deinit();
    try testing.expect(try fx.run(&none) == null);

    var garbage = requestWith("/api/auth/me", "harness_session=not-a-token");
    defer garbage.deinit();
    try testing.expect(try fx.run(&garbage) == null);

    var empty = requestWith("/api/auth/me", "harness_session=");
    defer empty.deinit();
    try testing.expect(try fx.run(&empty) == null);

    var bearer = requestWith("/api/auth/me", null);
    defer bearer.deinit();
    var line: [64]u8 = undefined;
    bearer.header("authorization", try std.fmt.bufPrint(&line, "Bearer {s}", .{created.token}));
    try testing.expect(try fx.run(&bearer) == null);

    var wrong_name = requestWith("/api/auth/me", null);
    defer wrong_name.deinit();
    var other: [64]u8 = undefined;
    wrong_name.header("cookie", try std.fmt.bufPrint(&other, "session={s}", .{created.token}));
    try testing.expect(try fx.run(&wrong_name) == null);
}

test "middleware: expired and revoked sessions are refused at once" {
    const fx = try AuthFx.create(false);
    defer fx.destroy();
    try fx.fx.addUser("u1", false);
    const created = try sessions.create(&fx.fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var buf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&buf, "harness_session={s}", .{created.token});

    var alive = requestWith("/api/auth/me", cookie);
    defer alive.deinit();
    try testing.expect(try fx.run(&alive) != null);

    try testing.expect(try sessions.revoke(&fx.fx.app, "u1", &created.id, t0));
    var revoked = requestWith("/api/auth/me", cookie);
    defer revoked.deinit();
    try testing.expect(try fx.run(&revoked) == null);

    const lapsed = try sessions.create(&fx.fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var lapsed_cookie_buf: [64]u8 = undefined;
    const lapsed_cookie = try std.fmt.bufPrint(&lapsed_cookie_buf, "harness_session={s}", .{lapsed.token});
    setNow(t0 + sessions.ttl_ms);
    var expired = requestWith("/api/auth/me", lapsed_cookie);
    defer expired.deinit();
    try testing.expect(try fx.run(&expired) == null);
}

test "middleware: a lookup that slid the expiry sets the cookie again, on /api only" {
    for ([_]bool{ false, true }) |secure| {
        const fx = try AuthFx.create(secure);
        defer fx.destroy();
        try fx.fx.addUser("u1", false);
        const created = try sessions.create(&fx.fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
        var buf: [64]u8 = undefined;
        const cookie = try std.fmt.bufPrint(&buf, "harness_session={s}", .{created.token});

        setNow(t0 + sessions.slide_every_ms);
        var ws = requestWith("/ws", cookie);
        defer ws.deinit();
        try testing.expect(try fx.run(&ws) != null);
        try testing.expect(ws.res.headers.get("set-cookie") == null);

        setNow(t0 + 2 * sessions.slide_every_ms);
        var api = requestWith("/api/auth/me", cookie);
        defer api.deinit();
        try testing.expect(try fx.run(&api) != null);
        var expected: [128]u8 = undefined;
        const want = try std.fmt.bufPrint(&expected, "harness_session={s}; Max-Age=2592000; Path=/; HttpOnly{s}; SameSite=Strict", .{
            created.token,
            if (secure) "; Secure" else "",
        });
        try testing.expectEqualStrings(want, api.res.headers.get("set-cookie").?);

        var quiet = requestWith("/api/auth/me", cookie);
        defer quiet.deinit();
        try testing.expect(try fx.run(&quiet) != null);
        try testing.expect(quiet.res.headers.get("set-cookie") == null);
    }
}

test "middleware: a database failure is an error, not a missing session" {
    var app = App.init(testing.allocator, testing.io);
    var auth = middleware.SessionAuth.init(&app, null);
    var web = requestWith("/api/auth/me", "harness_session=abc");
    defer web.deinit();
    const installed = auth.authenticator();
    try testing.expectError(error.NoDatabase, installed.authenticate(installed.ctx, web.req, web.res));
}

// ---- through the whole chain ----

fn routeFor(method: httpz.Method, path: []const u8) ?*const routes.Route {
    for (&routes.table) |*route| {
        if (!std.mem.eql(u8, route.path, path)) continue;
        if (route.method == .any or std.mem.eql(u8, @tagName(route.method), @tagName(method))) return route;
    }
    return null;
}

const ChainFx = struct {
    fx: *AuthFx,
    server: server_mod.Server,

    fn create() !*ChainFx {
        const self = try testing.allocator.create(ChainFx);
        errdefer testing.allocator.destroy(self);
        self.fx = try AuthFx.create(false);
        errdefer self.fx.destroy();
        self.server = server_mod.Server.init(.{ .app = &self.fx.fx.app, .health = .{ .instance_id = @splat('a') } }, testing.io, .{
            .host = "127.0.0.1",
            .port = 4100,
            .authenticator = self.fx.auth.authenticator(),
        });
        return self;
    }

    fn destroy(self: *ChainFx) void {
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn call(self: *ChainFx, method: httpz.Method, path: []const u8, cookie: ?[]const u8, origin: bool) !httpz.testing.Testing {
        var web = httpz.testing.init(.{});
        errdefer web.deinit();
        web.req.method = method;
        web.url(path);
        web.header("host", "localhost:4100");
        if (origin) web.header("origin", "http://localhost:4100");
        if (cookie) |value| web.header("cookie", value);
        try self.server.chain(web.req, web.res, routeFor(method, path));
        return web;
    }
};

test "middleware: me and logout through the chain, and the revoked cookie is dead right after" {
    const chain = try ChainFx.create();
    defer chain.destroy();
    const fx = chain.fx.fx;
    try fx.addUser("u1", false);
    try fx.run("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o2', 'beta', 'Beta', 20), ('o1', 'alpha', 'Alpha', 10), ('o3', 'gamma', 'Gamma', 30)");
    try fx.run(
        \\INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at) VALUES
        \\  ('m1', 'o1', 'human', 'u1', 'lin', 'Lin', 'owner', 1),
        \\  ('m2', 'o2', 'human', 'u1', 'lin', 'Lin', 'viewer', 1)
    );
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var buf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&buf, "harness_session={s}", .{created.token});

    var me = try chain.call(.GET, "/api/auth/me", cookie, false);
    defer me.deinit();
    try me.expectStatus(200);
    var expected: [512]u8 = undefined;
    try me.expectBody(try std.fmt.bufPrint(
        &expected,
        "{{\"user\":{{\"id\":\"u1\",\"email\":\"u1@example.test\",\"name\":\"Test\",\"instanceAdmin\":false,\"createdAt\":1000}}," ++
            "\"session\":{{\"id\":\"{s}\",\"method\":\"passkey\",\"stepUpAt\":null,\"stepUpFresh\":false}}," ++
            "\"orgs\":[{{\"id\":\"o1\",\"slug\":\"alpha\",\"name\":\"Alpha\",\"createdAt\":10,\"role\":\"owner\"}}," ++
            "{{\"id\":\"o2\",\"slug\":\"beta\",\"name\":\"Beta\",\"createdAt\":20,\"role\":\"viewer\"}}]}}",
        .{created.id},
    ));

    var anonymous = try chain.call(.GET, "/api/auth/me", null, false);
    defer anonymous.deinit();
    try anonymous.expectStatus(401);
    try anonymous.expectBody("{\"error\":\"unauthorized\"}");

    var no_origin = try chain.call(.POST, "/api/auth/logout", cookie, false);
    defer no_origin.deinit();
    try no_origin.expectStatus(403);
    try no_origin.expectBody("{\"error\":\"forbidden origin\"}");
    var still = try chain.call(.GET, "/api/auth/me", cookie, false);
    defer still.deinit();
    try still.expectStatus(200);

    var out = try chain.call(.POST, "/api/auth/logout", cookie, true);
    defer out.deinit();
    try out.expectStatus(200);
    try out.expectBody("{\"ok\":true}");
    try testing.expectEqualStrings("harness_session=; Max-Age=0; Path=/", out.res.headers.get("set-cookie").?);

    var after = try chain.call(.GET, "/api/auth/me", cookie, false);
    defer after.deinit();
    try after.expectStatus(401);
}

test "middleware: admin rows need an instance admin, with the real session lookup" {
    const chain = try ChainFx.create();
    defer chain.destroy();
    const fx = chain.fx.fx;
    try fx.addUser("admin", true);
    try fx.addUser("plain", false);
    const admin = try sessions.create(&fx.app, .{ .user_id = "admin", .method = .passkey, .user_agent = null }, t0);
    const plain = try sessions.create(&fx.app, .{ .user_id = "plain", .method = .passkey, .user_agent = null }, t0);
    var admin_buf: [64]u8 = undefined;
    var plain_buf: [64]u8 = undefined;
    const admin_cookie = try std.fmt.bufPrint(&admin_buf, "harness_session={s}", .{admin.token});
    const plain_cookie = try std.fmt.bufPrint(&plain_buf, "harness_session={s}", .{plain.token});

    var member = try chain.call(.GET, "/api/runs", plain_cookie, false);
    defer member.deinit();
    try member.expectStatus(403);
    try member.expectBody("{\"error\":\"forbidden\"}");
    var owner = try chain.call(.GET, "/api/runs", admin_cookie, false);
    defer owner.deinit();
    try owner.expectStatus(200);
    try owner.expectBody("[]");
    var unknown = try chain.call(.GET, "/api/nope", plain_cookie, false);
    defer unknown.deinit();
    try unknown.expectStatus(404);
}

// ---- gates ----

test "middleware: the step-up gate answers 403 step_up_required until a fresh step-up" {
    const gate = struct {
        fn run(actor: policy.Actor, now: i64) !struct { bool, u16 } {
            var web = httpz.testing.init(.{});
            defer web.deinit();
            const passed = try middleware.requireStepUp(web.res, actor, now);
            if (!passed) try web.expectBody("{\"error\":\"step_up_required\"}");
            return .{ passed, web.res.status };
        }
    };
    const stale = try gate.run(.{ .step_up_at = t0 }, t0 + sessions.step_up_ms);
    try testing.expect(!stale[0]);
    try testing.expectEqual(@as(u16, 403), stale[1]);
    const never = try gate.run(.{}, t0);
    try testing.expect(!never[0]);
    const fresh = try gate.run(.{ .step_up_at = t0 }, t0 + sessions.step_up_ms - 1);
    try testing.expect(fresh[0]);
}

test "middleware: org admin gate lets instance admins, owners and admins through" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    for ([_][]const u8{ "owner", "admin", "member", "viewer", "nobody" }) |id| try fx.addUser(id, false);
    try fx.run("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1', 'alpha', 'Alpha', 10)");
    try fx.run(
        \\INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at) VALUES
        \\  ('m1', 'o1', 'human', 'owner', 'a', 'A', 'owner', 1),
        \\  ('m2', 'o1', 'human', 'admin', 'b', 'B', 'admin', 1),
        \\  ('m3', 'o1', 'human', 'member', 'c', 'C', 'member', 1),
        \\  ('m4', 'o1', 'human', 'viewer', 'd', 'D', 'viewer', 1)
    );
    const cases = [_]struct { []const u8, bool, bool }{
        .{ "owner", false, true },
        .{ "admin", false, true },
        .{ "member", false, false },
        .{ "viewer", false, false },
        .{ "nobody", false, false },
        .{ "nobody", true, true },
    };
    for (cases) |case| {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        const passed = try middleware.requireOrgAdmin(&fx.app, web.res, .{ .user_id = case[0], .instance_admin = case[1] });
        try testing.expectEqual(case[2], passed);
        if (!passed) {
            try web.expectStatus(403);
            try web.expectBody("{\"error\":\"forbidden\"}");
        }
    }
}

// ---- rate limit ----

const LimitFx = struct {
    fx: *Fixture,
    limiter: middleware.RateLimiter,

    fn create(trust_proxy: bool) !*LimitFx {
        const self = try testing.allocator.create(LimitFx);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, testing.io);
        self.limiter = middleware.RateLimiter.init(testing.allocator, &self.fx.app, trust_proxy);
        self.limiter.clock = fakeClock;
        setNow(t0);
        return self;
    }

    fn destroy(self: *LimitFx) void {
        self.limiter.deinit();
        self.fx.destroy();
        testing.allocator.destroy(self);
    }
};

test "middleware: the limiter allows ten a minute per key and reports the wait" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    for (0..10) |_| try testing.expectEqual(middleware.RateLimiter.Decision.allow, try fx.limiter.hit("1.2.3.4", t0));
    try testing.expectEqual(middleware.RateLimiter.Decision{ .limited = 60 }, try fx.limiter.hit("1.2.3.4", t0));
    try testing.expectEqual(middleware.RateLimiter.Decision{ .limited = 1 }, try fx.limiter.hit("1.2.3.4", t0 + 59_500));
    try testing.expectEqual(middleware.RateLimiter.Decision{ .limited = 1 }, try fx.limiter.hit("1.2.3.4", t0 + 59_999));
    // Another client is untouched, and the window ends exactly at reset_at.
    try testing.expectEqual(middleware.RateLimiter.Decision.allow, try fx.limiter.hit("5.6.7.8", t0));
    try testing.expectEqual(middleware.RateLimiter.Decision.allow, try fx.limiter.hit("1.2.3.4", t0 + 60_000));
    for (0..9) |_| try testing.expectEqual(middleware.RateLimiter.Decision.allow, try fx.limiter.hit("1.2.3.4", t0 + 60_000));
    try testing.expectEqual(middleware.RateLimiter.Decision{ .limited = 60 }, try fx.limiter.hit("1.2.3.4", t0 + 60_000));
}

test "middleware: expired entries are swept once more than max_tracked keys exist" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    fx.limiter.max_tracked = 3;
    for ([_][]const u8{ "a", "b", "c", "d" }) |key| _ = try fx.limiter.hit(key, t0);
    try testing.expectEqual(@as(u32, 4), fx.limiter.hits.count());
    // Five entries are over the cap, all expired by now; only the new key remains.
    _ = try fx.limiter.hit("e", t0 + 60_000);
    try testing.expectEqual(@as(u32, 1), fx.limiter.hits.count());
    // Live entries are never swept, so the map may grow past the cap, like the TS map.
    for ([_][]const u8{ "f", "g", "h", "i" }) |key| _ = try fx.limiter.hit(key, t0 + 60_000);
    try testing.expectEqual(@as(u32, 5), fx.limiter.hits.count());
}

test "middleware: sweeping thousands of colliding keys frees exactly the expired ones" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    fx.limiter.max_tracked = std.math.maxInt(usize);
    var key: [16]u8 = undefined;
    for (0..4000) |n| {
        const text = try std.fmt.bufPrint(&key, "key-{d}", .{n});
        // Even keys start their window at t0, odd ones a minute later, so half expire together.
        _ = try fx.limiter.hit(text, if (n % 2 == 0) t0 else t0 + 60_000);
    }
    try testing.expectEqual(@as(u32, 4000), fx.limiter.hits.count());
    fx.limiter.max_tracked = 1;
    _ = try fx.limiter.hit("trigger", t0 + 60_000);
    // Odd keys (window ends t0 + 120_000) and the trigger stay.
    try testing.expectEqual(@as(u32, 2001), fx.limiter.hits.count());
    for (0..4000) |n| {
        const text = try std.fmt.bufPrint(&key, "key-{d}", .{n});
        try testing.expectEqual(n % 2 == 1, fx.limiter.hits.contains(text));
    }
    try testing.expectEqual(@as(u32, 0), fx.limiter.sweeps_skipped);
}

fn limiterUnderFailure(alloc: std.mem.Allocator, app: *App) !void {
    var limiter = middleware.RateLimiter.init(alloc, app, false);
    defer limiter.deinit();
    limiter.max_tracked = 1;
    for ([_][]const u8{ "a", "b", "c" }) |key| _ = try limiter.hit(key, t0);
    _ = try limiter.hit("d", t0 + 60_000);
}

test "middleware: the limiter survives every allocation failure without leaking" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try testing.checkAllAllocationFailures(testing.allocator, limiterUnderFailure, .{&fx.app});
}

test "middleware: threads hammering one key are let through exactly the limit" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    const Worker = struct {
        limiter: *middleware.RateLimiter,
        allowed: *std.atomic.Value(u32),
        failed: *std.atomic.Value(bool),

        fn run(self: @This()) void {
            for (0..50) |_| {
                const decision = self.limiter.hit("9.9.9.9", t0) catch return self.failed.store(true, .release);
                if (decision == .allow) _ = self.allowed.fetchAdd(1, .acq_rel);
            }
        }
    };
    var allowed: std.atomic.Value(u32) = .init(0);
    var failed: std.atomic.Value(bool) = .init(false);
    var threads: [4]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Worker.run, .{Worker{ .limiter = &fx.limiter, .allowed = &allowed, .failed = &failed }});
    for (threads) |thread| thread.join();
    try testing.expect(!failed.load(.acquire));
    try testing.expectEqual(@as(u32, 10), allowed.load(.acquire));
}

test "middleware: threads on many keys keep every counter" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    const Worker = struct {
        limiter: *middleware.RateLimiter,
        id: u8,
        failed: *std.atomic.Value(bool),

        fn run(self: @This()) void {
            var key: [8]u8 = undefined;
            for (0..40) |n| {
                const text = std.fmt.bufPrint(&key, "k{d}-{d}", .{ self.id, n % 8 }) catch return self.failed.store(true, .release);
                _ = self.limiter.hit(text, t0) catch return self.failed.store(true, .release);
            }
        }
    };
    var failed: std.atomic.Value(bool) = .init(false);
    var threads: [4]std.Thread = undefined;
    for (&threads, 0..) |*thread, id| thread.* = try std.Thread.spawn(.{}, Worker.run, .{Worker{ .limiter = &fx.limiter, .id = @intCast(id), .failed = &failed }});
    for (threads) |thread| thread.join();
    try testing.expect(!failed.load(.acquire));
    try testing.expectEqual(@as(u32, 32), fx.limiter.hits.count());
    var it = fx.limiter.hits.valueIterator();
    while (it.next()) |entry| try testing.expectEqual(@as(u32, 5), entry.count);
}

test "middleware: the limiter covers login, email, recovery and enroll under /api/auth" {
    const limited = [_][]const u8{
        "/api/auth/login/options",
        "/api/auth/login/verify",
        "/api/auth/login",
        "/api/auth/login/",
        "/api/auth/email/request",
        "/api/auth/email",
        "/api/auth/recovery",
        "/api/auth/enroll/abc/options",
        "/api/auth/enroll",
    };
    const open = [_][]const u8{
        "/api/auth/me",
        "/api/auth/logout",
        "/api/auth/recovery/regenerate",
        "/api/auth/recovery/",
        "/api/auth/loginx",
        "/api/auth/emails",
        "/api/auth/enrolled",
        "/api/auth/step-up/options",
        "/api/health",
        "/login/options",
        "/api/auth",
        "/api/authx/login",
    };
    for (limited) |path| try testing.expect(middleware.isLimitedPath(path));
    for (open) |path| try testing.expect(!middleware.isLimitedPath(path));
}

test "middleware: the peer address has no port, IPv6 is compact" {
    const cases = [_][2][]const u8{
        .{ "127.0.0.1", "127.0.0.1" },
        .{ "10.20.30.40", "10.20.30.40" },
        .{ "::1", "::1" },
        .{ "2001:db8::1", "2001:db8::1" },
    };
    for (cases) |case| {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        web.req.address = try std.Io.net.IpAddress.parse(case[0], 4100);
        try testing.expectEqualStrings(case[1], try middleware.clientKey(web.arena, web.req, false));
    }
}

test "middleware: X-Forwarded-For is ignored without a proxy and the rightmost entry counts behind one" {
    const Case = struct { []const []const u8, []const u8, []const u8 };
    const cases = [_]Case{
        .{ &.{"203.0.113.9"}, "203.0.113.9", "203.0.113.9" },
        .{ &.{"6.6.6.6, 203.0.113.9"}, "203.0.113.9", "203.0.113.9" },
        .{ &.{"6.6.6.6,   203.0.113.9  "}, "203.0.113.9", "203.0.113.9" },
        .{ &.{"203.0.113.9, "}, "127.0.0.1", "127.0.0.1" },
        .{ &.{""}, "127.0.0.1", "127.0.0.1" },
        .{ &.{ "6.6.6.6", "203.0.113.9" }, "203.0.113.9", "203.0.113.9" },
        .{ &.{}, "127.0.0.1", "127.0.0.1" },
    };
    for (cases) |case| {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        web.req.address = try std.Io.net.IpAddress.parse("127.0.0.1", 4100);
        for (case[0]) |value| web.header("x-forwarded-for", value);
        try testing.expectEqualStrings(case[1], try middleware.clientKey(web.arena, web.req, true));
        try testing.expectEqualStrings("127.0.0.1", try middleware.clientKey(web.arena, web.req, false));
    }
}

test "middleware: the throttle answers 429 with retry-after on the eleventh attempt and ignores other paths" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    const throttle = fx.limiter.throttle();
    for (0..10) |_| {
        var web = requestWith("/api/auth/login/options", null);
        defer web.deinit();
        try testing.expect(try throttle.check(throttle.ctx, web.req, web.res));
    }
    var blocked = requestWith("/api/auth/login/options", null);
    defer blocked.deinit();
    try testing.expect(!try throttle.check(throttle.ctx, blocked.req, blocked.res));
    try blocked.expectStatus(429);
    try blocked.expectBody("{\"error\":\"too many attempts\"}");
    try testing.expectEqualStrings("60", blocked.res.headers.get("retry-after").?);

    var other = requestWith("/api/auth/me", null);
    defer other.deinit();
    try testing.expect(try throttle.check(throttle.ctx, other.req, other.res));

    // A percent-encoded letter does not step around the limit.
    var encoded = requestWith("/api/auth/log%69n/verify", null);
    defer encoded.deinit();
    try testing.expect(!try throttle.check(throttle.ctx, encoded.req, encoded.res));
}

test "middleware: the throttle sits in the chain after the origin guard and before routing" {
    const fx = try LimitFx.create(false);
    defer fx.destroy();
    var server = server_mod.Server.init(.{ .app = &fx.fx.app, .health = .{ .instance_id = @splat('a') } }, testing.io, .{
        .host = "127.0.0.1",
        .port = 4100,
        .throttle = fx.limiter.throttle(),
    });
    for (0..11) |n| {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        web.req.method = .POST;
        web.url("/api/auth/email/request");
        web.header("host", "localhost:4100");
        web.header("origin", "http://localhost:4100");
        server.chain(web.req, web.res, routeFor(.POST, "/api/auth/email/request")) catch |err| server.uncaughtError(web.req, web.res, err);
        try web.expectStatus(if (n < 10) 400 else 429);
    }
    // A request the origin guard refuses never counts against the client.
    var refused = httpz.testing.init(.{});
    defer refused.deinit();
    refused.req.method = .POST;
    refused.url("/api/auth/email/request");
    refused.header("host", "localhost:4100");
    try server.chain(refused.req, refused.res, routeFor(.POST, "/api/auth/email/request"));
    try refused.expectStatus(403);
}

// ---- a real listener ----

const WireFx = struct {
    auth: *AuthFx,
    limiter: middleware.RateLimiter,
    handler: server_mod.Server,
    running: server_mod.Running,

    fn create() !*WireFx {
        const self = try testing.allocator.create(WireFx);
        errdefer testing.allocator.destroy(self);
        self.auth = try AuthFx.create(false);
        errdefer self.auth.destroy();
        self.limiter = middleware.RateLimiter.init(testing.allocator, &self.auth.fx.app, false);
        self.limiter.clock = fakeClock;
        errdefer self.limiter.deinit();
        const options: server_mod.Options = .{
            .host = "127.0.0.1",
            .port = 0,
            .threads = 2,
            .authenticator = self.auth.auth.authenticator(),
            .throttle = self.limiter.throttle(),
        };
        self.handler = server_mod.Server.init(.{ .app = &self.auth.fx.app, .health = .{ .instance_id = @splat('a') } }, testing.io, options);
        self.running = try server_mod.start(testing.allocator, testing.io, &self.handler, options);
        return self;
    }

    fn destroy(self: *WireFx) void {
        self.running.stop();
        self.running.deinit();
        self.limiter.deinit();
        self.auth.destroy();
        testing.allocator.destroy(self);
    }

    /// One request with `Connection: close`; `extra` is complete header lines. Returns the raw response.
    fn send(self: *WireFx, method: []const u8, path: []const u8, extra: []const u8) ![]u8 {
        const request = try std.fmt.allocPrint(
            testing.allocator,
            "{s} {s} HTTP/1.1\r\nHost: localhost:{d}\r\n{s}Connection: close\r\nContent-Length: 0\r\n\r\n",
            .{ method, path, self.running.port, extra },
        );
        defer testing.allocator.free(request);
        const address: std.Io.net.IpAddress = .{ .ip4 = .loopback(self.running.port) };
        var stream = try address.connect(testing.io, .{ .mode = .stream });
        defer stream.close(testing.io);
        var read_buffer: [4096]u8 = undefined;
        var write_buffer: [4096]u8 = undefined;
        var reader = stream.reader(testing.io, &read_buffer);
        var writer = stream.writer(testing.io, &write_buffer);
        try writer.interface.writeAll(request);
        try writer.interface.flush();
        return reader.interface.allocRemaining(testing.allocator, .limited(1024 * 1024)) catch |err| switch (err) {
            error.ReadFailed => reader.err.?,
            else => |e| e,
        };
    }
};

/// The three digits of the status line; httpz sends no reason phrase.
fn statusLine(response: []const u8) []const u8 {
    return if (response.len >= 12) response[9..12] else response;
}

fn wireHeader(response: []const u8, name: []const u8) ?[]const u8 {
    const head_end = std.mem.find(u8, response, "\r\n\r\n") orelse response.len;
    var lines = std.mem.splitSequence(u8, response[0..head_end], "\r\n");
    _ = lines.next();
    while (lines.next()) |line| {
        const colon = std.mem.findScalar(u8, line, ':') orelse continue;
        if (std.ascii.eqlIgnoreCase(line[0..colon], name)) return std.mem.trim(u8, line[colon + 1 ..], " ");
    }
    return null;
}

test "middleware: over a real socket the cookie opens /api/auth/me, logout closes it, attempts are limited" {
    const wire = try WireFx.create();
    defer wire.destroy();
    try wire.auth.fx.addUser("u1", false);
    const created = try sessions.create(&wire.auth.fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, t0);
    var cookie_buf: [128]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cookie_buf, "Cookie: theme=dark; harness_session={s}\r\n", .{created.token});

    const me = try wire.send("GET", "/api/auth/me", cookie);
    defer testing.allocator.free(me);
    try testing.expectEqualStrings("200", statusLine(me));

    const anonymous = try wire.send("GET", "/api/auth/me", "");
    defer testing.allocator.free(anonymous);
    try testing.expectEqualStrings("401", statusLine(anonymous));

    const bearer = try wire.send("GET", "/api/auth/me", "Authorization: Bearer abc\r\n");
    defer testing.allocator.free(bearer);
    try testing.expectEqualStrings("401", statusLine(bearer));

    var origin_buf: [192]u8 = undefined;
    const with_origin = try std.fmt.bufPrint(&origin_buf, "{s}Origin: http://localhost:{d}\r\n", .{ cookie, wire.running.port });
    const logout = try wire.send("POST", "/api/auth/logout", with_origin);
    defer testing.allocator.free(logout);
    try testing.expectEqualStrings("200", statusLine(logout));
    try testing.expectEqualStrings("harness_session=; Max-Age=0; Path=/", wireHeader(logout, "set-cookie").?);

    const after = try wire.send("GET", "/api/auth/me", cookie);
    defer testing.allocator.free(after);
    try testing.expectEqualStrings("401", statusLine(after));

    var origin_only: [64]u8 = undefined;
    const origin_header = try std.fmt.bufPrint(&origin_only, "Origin: http://localhost:{d}\r\n", .{wire.running.port});
    for (0..10) |_| {
        const attempt = try wire.send("POST", "/api/auth/email/request", origin_header);
        defer testing.allocator.free(attempt);
        try testing.expectEqualStrings("400", statusLine(attempt));
    }
    const limited = try wire.send("POST", "/api/auth/email/request", origin_header);
    defer testing.allocator.free(limited);
    try testing.expectEqualStrings("429", statusLine(limited));
    try testing.expectEqualStrings("60", wireHeader(limited, "retry-after").?);
}
