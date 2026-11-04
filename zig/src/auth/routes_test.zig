//! Tests for routes.zig through the whole chain of `Server.chain` (host guard, Origin guard,
//! session gate, handler). The passkey ceremonies are the recorded ones of fixtures/webauthn.json:
//! the options step runs for real and the challenge it stored is replaced by the recorded one,
//! because a recorded response can only answer the challenge it was made for.
const std = @import("std");
const httpz = @import("httpz");
const codes = @import("codes.zig");
const middleware = @import("middleware.zig");
const passkeys_test = @import("passkeys_test.zig");
const routes = @import("routes.zig");
const server_mod = @import("../http/server.zig");
const http_routes = @import("../http/routes.zig");
const sessions = @import("sessions.zig");
const sqlite = @import("../db/sqlite.zig");
const Ctx = @import("codes_test.zig").Ctx;

const testing = std.testing;
const Server = server_mod.Server;
const Value = std.json.Value;

fn repeat(comptime unit: []const u8, comptime n: usize) *const [unit.len * n]u8 {
    comptime {
        @setEvalBranchQuota(100_000);
        var buf: [unit.len * n]u8 = undefined;
        for (0..n) |i| @memcpy(buf[i * unit.len ..][0..unit.len], unit);
        const final = buf;
        return &final;
    }
}

/// A named empty struct: an anonymous `.{}` would be written as `[]`.
const NoExtensions = struct {};

const Answer = struct {
    status: u16,
    body: []const u8,
    set_cookie: ?[]const u8,

    fn json(self: Answer, arena: std.mem.Allocator) !Value {
        return std.json.parseFromSliceLeaky(Value, arena, self.body, .{});
    }

    /// `name=value` of the Set-Cookie header, ready to be sent back.
    fn cookie(self: Answer) []const u8 {
        const header = self.set_cookie.?;
        return header[0..std.mem.findScalar(u8, header, ';').?];
    }
};

const Req = struct {
    method: httpz.Method = .POST,
    pattern: []const u8,
    url: ?[]const u8 = null,
    params: []const [2][]const u8 = &.{},
    cookie: ?[]const u8 = null,
    body: ?[]const u8 = null,
    user_agent: ?[]const u8 = null,
    /// Makes the handler's allocator fail at this allocation (counted from zero).
    fail_index: ?usize = null,
};

const Rig = struct {
    ctx: Ctx,
    auth: middleware.SessionAuth,
    server: Server,
    host: []const u8,
    origin: []const u8,
    all: passkeys_test.Fixtures,
    /// Whether the last request with a `fail_index` hit its induced failure.
    induced: bool,
    /// Allocations the handler made in the last request with a `fail_index`.
    allocations: usize,

    fn create(configured_origin: ?[]const u8) !*Rig {
        const rig = try testing.allocator.create(Rig);
        errdefer testing.allocator.destroy(rig);
        rig.ctx = try Ctx.init();
        errdefer rig.ctx.deinit();
        rig.auth = middleware.SessionAuth.init(&rig.ctx.fx.app, configured_origin);
        rig.origin = configured_origin orelse "http://localhost:4100";
        rig.host = rig.origin[std.mem.find(u8, rig.origin, "://").? + 3 ..];
        rig.server = Server.init(.{ .app = &rig.ctx.fx.app, .health = .{ .instance_id = @splat('a') } }, testing.io, .{
            .host = "127.0.0.1",
            .port = 4100,
            .origin = configured_origin,
            .authenticator = rig.auth.authenticator(),
        });
        rig.all = try passkeys_test.fixtures(rig.ctx.alloc());
        rig.induced = false;
        rig.allocations = 0;
        return rig;
    }

    fn destroy(rig: *Rig) void {
        rig.ctx.deinit();
        testing.allocator.destroy(rig);
    }

    fn alloc(rig: *Rig) std.mem.Allocator {
        return rig.ctx.alloc();
    }

    fn routeFor(r: Req) ?*const http_routes.Route {
        for (&http_routes.table) |*route| {
            if (!std.mem.eql(u8, route.path, r.pattern)) continue;
            if (route.method == .any or std.mem.eql(u8, @tagName(route.method), @tagName(r.method))) return route;
        }
        return null;
    }

    fn send(rig: *Rig, r: Req) !Answer {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        web.req.method = r.method;
        web.url(r.url orelse r.pattern);
        for (r.params) |pair| web.param(pair[0], pair[1]);
        web.header("host", rig.host);
        if (r.method != .GET) web.header("origin", rig.origin);
        if (r.cookie) |cookie| web.header("cookie", cookie);
        if (r.user_agent) |agent| web.header("user-agent", agent);
        if (r.body) |body| web.body(body);
        var failing = std.testing.FailingAllocator.init(rig.alloc(), .{ .fail_index = r.fail_index orelse std.math.maxInt(usize) });
        if (r.fail_index != null) web.res.arena = failing.allocator();
        rig.server.chain(web.req, web.res, routeFor(r)) catch |err| rig.server.uncaughtError(web.req, web.res, err);
        rig.induced = failing.has_induced_failure;
        rig.allocations = failing.allocations;
        // Only the handler is meant to fail; reading the answer back must not.
        failing.fail_index = std.math.maxInt(usize);
        const parsed = try web.parseResponse();
        return .{
            .status = parsed.status,
            .body = try rig.alloc().dupe(u8, parsed.body),
            .set_cookie = if (parsed.headers.get("set-cookie")) |header| try rig.alloc().dupe(u8, header) else null,
        };
    }

    /// Waits for the email deliveries the request handed over, so a capturing sink has seen them.
    fn post(rig: *Rig, pattern: []const u8, body: ?[]const u8, cookie: ?[]const u8) !Answer {
        const answer = try rig.send(.{ .pattern = pattern, .body = body orelse "{}", .cookie = cookie });
        routes.drainDeliveries(testing.io);
        return answer;
    }

    fn get(rig: *Rig, pattern: []const u8, cookie: ?[]const u8) !Answer {
        return rig.send(.{ .method = .GET, .pattern = pattern, .cookie = cookie });
    }

    fn fmt(rig: *Rig, comptime format: []const u8, args: anytype) ![]const u8 {
        return std.fmt.allocPrint(rig.alloc(), format, args);
    }

    // ---- ceremonies ----

    const SwapArgs = struct { id: []const u8, challenge: []const u8 };

    fn swapLocked(db: sqlite.Db, a: SwapArgs) codes.Error!void {
        try codes.execute(db, "UPDATE challenges SET challenge = ? WHERE id = ?", &.{ .{ .text = a.challenge }, .{ .text = a.id } });
    }

    /// Puts the recorded challenge where the server stored its own.
    fn swapChallenge(rig: *Rig, id: []const u8, challenge: []const u8) !void {
        try codes.run(&rig.ctx.fx.app, SwapArgs{ .id = id, .challenge = challenge }, swapLocked);
    }

    fn attestation(rig: *Rig, v: passkeys_test.Vector, challenge_id: []const u8, user_id: []const u8, name: ?[]const u8) ![]const u8 {
        const r = v.input.response;
        return std.json.Stringify.valueAlloc(rig.alloc(), .{
            .challengeId = challenge_id,
            .userId = user_id,
            .name = name,
            .response = .{
                .id = r.id.?,
                .rawId = r.rawId.?,
                .type = r.type.?,
                .clientExtensionResults = NoExtensions{},
                .response = .{
                    .clientDataJSON = r.response.?.clientDataJSON.?,
                    .attestationObject = r.response.?.attestationObject.?,
                    .transports = r.response.?.transports,
                },
            },
        }, .{ .emit_null_optional_fields = false });
    }

    fn assertion(rig: *Rig, v: passkeys_test.Vector, challenge_id: []const u8) ![]const u8 {
        const r = v.input.response;
        return std.json.Stringify.valueAlloc(rig.alloc(), .{
            .challengeId = challenge_id,
            .response = .{
                .id = r.id.?,
                .rawId = r.rawId.?,
                .type = r.type.?,
                .clientExtensionResults = NoExtensions{},
                .response = .{
                    .clientDataJSON = r.response.?.clientDataJSON.?,
                    .authenticatorData = r.response.?.authenticatorData.?,
                    .signature = r.response.?.signature.?,
                },
            },
        }, .{});
    }

    fn vector(rig: *Rig, name: []const u8) !passkeys_test.Vector {
        return passkeys_test.vectorNamed(rig.all, name);
    }

    /// The first-owner bootstrap: a code, the options, the recorded registration.
    fn enrollOwner(rig: *Rig) !Answer {
        const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
        return rig.enrollWith(&code, "Owner@Example.com");
    }

    fn enrollWith(rig: *Rig, code: []const u8, email: []const u8) !Answer {
        return rig.enrollWithFailure(code, email, null);
    }

    fn enrollWithFailure(rig: *Rig, code: []const u8, email: []const u8, fail_index: ?usize) !Answer {
        const options = try rig.send(.{
            .pattern = "/api/auth/enroll/:code/options",
            .url = try rig.fmt("/api/auth/enroll/{s}/options", .{code}),
            .params = &.{.{ "code", code }},
            .body = try rig.fmt("{{\"email\":\"{s}\",\"name\":\" Owner \"}}", .{email}),
        });
        try testing.expectEqual(@as(u16, 200), options.status);
        const parsed = try options.json(rig.alloc());
        const challenge_id = parsed.object.get("challengeId").?.string;
        const user_id = parsed.object.get("userId").?.string;
        const v = try rig.vector("es256: registration");
        try rig.swapChallenge(challenge_id, v.input.challenge);
        return rig.send(.{
            .pattern = "/api/auth/enroll/:code/verify",
            .url = try rig.fmt("/api/auth/enroll/{s}/verify", .{code}),
            .params = &.{.{ "code", code }},
            .body = try rig.attestation(v, challenge_id, user_id, "Laptop"),
            .fail_index = fail_index,
        });
    }

    fn loginWith(rig: *Rig, vector_name: []const u8) !Answer {
        const options = try rig.post("/api/auth/login/options", null, null);
        try testing.expectEqual(@as(u16, 200), options.status);
        const challenge_id = (try options.json(rig.alloc())).object.get("challengeId").?.string;
        const v = try rig.vector(vector_name);
        try rig.swapChallenge(challenge_id, v.input.challenge);
        return rig.post("/api/auth/login/verify", try rig.assertion(v, challenge_id), null);
    }

    fn stepUpWith(rig: *Rig, vector_name: []const u8, cookie: []const u8) !Answer {
        const options = try rig.post("/api/auth/step-up/options", null, cookie);
        try testing.expectEqual(@as(u16, 200), options.status);
        const challenge_id = (try options.json(rig.alloc())).object.get("challengeId").?.string;
        const v = try rig.vector(vector_name);
        try rig.swapChallenge(challenge_id, v.input.challenge);
        return rig.post("/api/auth/step-up/verify", try rig.assertion(v, challenge_id), cookie);
    }
};

fn expectError(answer: Answer, status: u16, message: []const u8) !void {
    try testing.expectEqual(status, answer.status);
    var buf: [256]u8 = undefined;
    try testing.expectEqualStrings(try std.fmt.bufPrint(&buf, "{{\"error\":\"{s}\"}}", .{message}), answer.body);
}

fn methodOf(rig: *Rig, answer: Answer) ![]const u8 {
    const me = try rig.get("/api/auth/me", answer.cookie());
    try testing.expectEqual(@as(u16, 200), me.status);
    return (try me.json(rig.alloc())).object.get("session").?.object.get("method").?.string;
}

// ---- enrollment ----

test "auth routes: bootstrap enrollment registers a passkey, returns recovery codes and a cookie" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const done = try rig.enrollOwner();
    try testing.expectEqual(@as(u16, 200), done.status);
    const body = try done.json(rig.alloc());
    const user = body.object.get("user").?.object;
    try testing.expectEqualStrings("owner@example.com", user.get("email").?.string);
    try testing.expectEqualStrings("Owner", user.get("name").?.string);
    try testing.expect(user.get("instanceAdmin").?.bool);
    try testing.expectEqual(@as(usize, 10), body.object.get("recoveryCodes").?.array.items.len);
    // Key order of `{ user, ...extra }`.
    try testing.expect(std.mem.find(u8, done.body, "\"user\"").? < std.mem.find(u8, done.body, "\"recoveryCodes\"").?);

    const header = done.set_cookie.?;
    try testing.expect(std.mem.startsWith(u8, header, "harness_session="));
    for ([_][]const u8{ "; Max-Age=2592000", "; Path=/", "; HttpOnly", "; SameSite=Strict" }) |part|
        try testing.expect(std.mem.find(u8, header, part) != null);
    try testing.expect(std.mem.find(u8, header, "Secure") == null);

    const me = try rig.get("/api/auth/me", done.cookie());
    const session = (try me.json(rig.alloc())).object.get("session").?.object;
    try testing.expectEqualStrings("enroll", session.get("method").?.string);
    try testing.expect(session.get("stepUpFresh").?.bool);
    try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM passkeys"));
}

test "auth routes: the options carry userId after challengeId, and the recorded response is spent" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
    const options = try rig.send(.{
        .pattern = "/api/auth/enroll/:code/options",
        .url = try rig.fmt("/api/auth/enroll/{s}/options", .{&code}),
        .params = &.{.{ "code", &code }},
        .body = "{\"email\":\"o@example.com\",\"name\":\"O\"}",
    });
    try testing.expectEqual(@as(u16, 200), options.status);
    try testing.expect(std.mem.find(u8, options.body, "\"challengeId\"").? < std.mem.find(u8, options.body, "\"userId\"").?);
    try testing.expect(std.mem.endsWith(u8, options.body, "\"}"));
    const parsed = try options.json(rig.alloc());
    try testing.expectEqualStrings("localhost", parsed.object.get("rp").?.object.get("id").?.string);
    try testing.expectEqualStrings("Harness", parsed.object.get("rp").?.object.get("name").?.string);
}

test "auth routes: a finished code is dead, in both steps" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
    try testing.expectEqual(@as(u16, 200), (try rig.enrollWith(&code, "o@example.com")).status);
    const again = try rig.send(.{
        .pattern = "/api/auth/enroll/:code/options",
        .url = try rig.fmt("/api/auth/enroll/{s}/options", .{&code}),
        .params = &.{.{ "code", &code }},
        .body = "{\"email\":\"o@example.com\",\"name\":\"O\"}",
    });
    try expectError(again, 400, "enrollment code is not valid");
    const verify = try rig.send(.{
        .pattern = "/api/auth/enroll/:code/verify",
        .url = try rig.fmt("/api/auth/enroll/{s}/verify", .{&code}),
        .params = &.{.{ "code", &code }},
        .body = try rig.attestation(try rig.vector("es256: registration"), "x", "y", null),
    });
    try expectError(verify, 400, "enrollment code is not valid");
}

test "auth routes: a failed passkey prompt can retry the same code" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
    const url_options = try rig.fmt("/api/auth/enroll/{s}/options", .{&code});
    const url_verify = try rig.fmt("/api/auth/enroll/{s}/verify", .{&code});
    const params: []const [2][]const u8 = &.{.{ "code", &code }};
    const v = try rig.vector("es256: registration");
    const first = try (try rig.send(.{ .pattern = "/api/auth/enroll/:code/options", .url = url_options, .params = params, .body = "{\"email\":\"o@example.com\",\"name\":\"O\"}" })).json(rig.alloc());
    // The server's own challenge is not the recorded one: the browser's answer fails.
    const failed = try rig.send(.{ .pattern = "/api/auth/enroll/:code/verify", .url = url_verify, .params = params, .body = try rig.attestation(v, first.object.get("challengeId").?.string, first.object.get("userId").?.string, null) });
    try expectError(failed, 400, "Unexpected response challenge");
    // The same code asks again for the same user and gets a fresh challenge.
    const second = try (try rig.send(.{ .pattern = "/api/auth/enroll/:code/options", .url = url_options, .params = params, .body = "{\"email\":\"other@example.com\",\"name\":\"Other\"}" })).json(rig.alloc());
    try testing.expectEqualStrings(first.object.get("userId").?.string, second.object.get("userId").?.string);
    try testing.expect(!std.mem.eql(u8, first.object.get("challengeId").?.string, second.object.get("challengeId").?.string));
    try rig.swapChallenge(second.object.get("challengeId").?.string, v.input.challenge);
    const done = try rig.send(.{ .pattern = "/api/auth/enroll/:code/verify", .url = url_verify, .params = params, .body = try rig.attestation(v, second.object.get("challengeId").?.string, second.object.get("userId").?.string, null) });
    try testing.expectEqual(@as(u16, 200), done.status);
    try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM users"));
    try testing.expectEqualStrings("Passkey", blk: {
        const stmt = try rig.ctx.fx.db.prepare("SELECT name FROM passkeys");
        defer stmt.finalize();
        _ = try stmt.step();
        break :blk try rig.alloc().dupe(u8, (try stmt.text(0)).?);
    });
}

test "auth routes: enroll verify refuses another user's id and a claimed code" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const now = @import("../ids.zig").nowMs(testing.io);
    const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, now);
    const url_options = try rig.fmt("/api/auth/enroll/{s}/options", .{&code});
    const url_verify = try rig.fmt("/api/auth/enroll/{s}/verify", .{&code});
    const params: []const [2][]const u8 = &.{.{ "code", &code }};
    const options = try (try rig.send(.{ .pattern = "/api/auth/enroll/:code/options", .url = url_options, .params = params, .body = "{\"email\":\"o@example.com\",\"name\":\"O\"}" })).json(rig.alloc());
    const v = try rig.vector("es256: registration");
    const challenge_id = options.object.get("challengeId").?.string;
    try rig.swapChallenge(challenge_id, v.input.challenge);
    const wrong_user = try rig.send(.{ .pattern = "/api/auth/enroll/:code/verify", .url = url_verify, .params = params, .body = try rig.attestation(v, challenge_id, "someone-else", null) });
    try expectError(wrong_user, 400, "enrollment code is not valid");
    // The refusal came before the challenge was touched.
    try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM challenges"));
    try testing.expect(try codes.claimEnrollment(&rig.ctx.fx.app, rig.alloc(), &code, now));
    const claimed = try rig.send(.{ .pattern = "/api/auth/enroll/:code/verify", .url = url_verify, .params = params, .body = try rig.attestation(v, challenge_id, options.object.get("userId").?.string, null) });
    try expectError(claimed, 409, "enrollment already in progress");
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM passkeys"));
}

test "auth routes: an https origin makes the cookie Secure and moves the rp" {
    const rig = try Rig.create("https://harness.example.com");
    defer rig.destroy();
    const done = try rig.enrollOwner();
    // The recorded ceremony is for localhost, so the https rp refuses it; the cookie rule is
    // checked on a login that the rig creates by hand instead.
    try expectError(done, 400, "Unexpected response origin");
    try testing.expect(done.set_cookie == null);
    _ = try rig.ctx.user("a@example.com", false);
    const sink = EmailCapture.install();
    defer sink.restore();
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"a@example.com\"}", null);
    const verified = try rig.post("/api/auth/email/verify", try rig.fmt("{{\"email\":\"a@example.com\",\"code\":\"{s}\"}}", .{EmailCapture.last()}), null);
    try testing.expectEqual(@as(u16, 200), verified.status);
    try testing.expect(std.mem.find(u8, verified.set_cookie.?, "; Secure") != null);
}

// ---- login ----

test "auth routes: the recorded login opens a session, a replay and bad bodies do not" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    try testing.expectEqual(@as(u16, 200), (try rig.enrollOwner()).status);
    const login = try rig.loginWith("es256: login, counter 1");
    try testing.expectEqual(@as(u16, 200), login.status);
    try testing.expectEqualStrings("passkey", try methodOf(rig, login));
    // The same recorded bytes again, with a challenge row that matches them: the counter says no.
    try expectError(try rig.loginWith("es256: login, counter 1"), 401, "unauthorized");
    // A challenge id that was never issued.
    const v = try rig.vector("es256: login, counter 1");
    try expectError(try rig.post("/api/auth/login/verify", try rig.assertion(v, "nope"), null), 401, "unauthorized");
    for ([_][]const u8{ "", "null", "{}", "{\"challengeId\":\"c\"}", "{\"challengeId\":1,\"response\":{}}" }) |bad|
        try expectError(try rig.send(.{ .pattern = "/api/auth/login/verify", .body = if (bad.len == 0) null else bad }), 400, "invalid body");
}

test "auth routes: login options are discoverable and leave one challenge behind" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const options = try rig.post("/api/auth/login/options", null, null);
    try testing.expectEqual(@as(u16, 200), options.status);
    try testing.expect(std.mem.find(u8, options.body, "allowCredentials") == null);
    try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM challenges WHERE purpose = 'login' AND user_id IS NULL"));
}

// ---- email codes ----

const EmailCapture = struct {
    var email_buf: [254]u8 = undefined;
    var code_buf: [6]u8 = undefined;
    var email_len: usize = 0;
    var count: usize = 0;
    var previous: routes.EmailSink = undefined;

    fn capture(_: std.Io, email: []const u8, code: []const u8) void {
        @memcpy(email_buf[0..email.len], email);
        email_len = email.len;
        @memcpy(&code_buf, code);
        count += 1;
    }

    fn install() EmailCapture {
        previous = routes.email_sink;
        routes.email_sink = capture;
        count = 0;
        return .{};
    }

    fn restore(_: EmailCapture) void {
        routes.email_sink = previous;
    }

    fn last() []const u8 {
        return &code_buf;
    }
};

test "auth routes: an email code signs in once, and an email session is not step-up" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const sink = EmailCapture.install();
    defer sink.restore();
    _ = try rig.ctx.user("a@example.com", false);
    const request = try rig.post("/api/auth/email/request", "{\"email\":\" A@Example.com \"}", null);
    try testing.expectEqual(@as(u16, 200), request.status);
    try testing.expectEqualStrings("{\"ok\":true}", request.body);
    try testing.expectEqual(@as(usize, 1), EmailCapture.count);
    try testing.expectEqualStrings("a@example.com", EmailCapture.email_buf[0..EmailCapture.email_len]);

    const body = try rig.fmt("{{\"email\":\"a@example.com\",\"code\":\" {s} \"}}", .{EmailCapture.last()});
    const verified = try rig.post("/api/auth/email/verify", body, null);
    try testing.expectEqual(@as(u16, 200), verified.status);
    try testing.expectEqualStrings("email", try methodOf(rig, verified));
    try expectError(try rig.post("/api/auth/email/verify", body, null), 401, "unauthorized");

    // An email session never unlocks the dangerous routes.
    try expectError(try rig.post("/api/auth/passkeys/options", null, verified.cookie()), 403, "step_up_required");
    try expectError(try rig.post("/api/auth/recovery/regenerate", null, verified.cookie()), 403, "step_up_required");
}

test "auth routes: unknown addresses get the same reply, the same limit and no mail" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const sink = EmailCapture.install();
    defer sink.restore();
    _ = try rig.ctx.user("a@example.com", false);
    for (0..3) |_| {
        const ghost = try rig.post("/api/auth/email/request", "{\"email\":\"ghost@example.com\"}", null);
        try testing.expectEqualStrings("{\"ok\":true}", ghost.body);
    }
    try expectError(try rig.post("/api/auth/email/request", "{\"email\":\"ghost@example.com\"}", null), 429, "too many attempts");
    try testing.expectEqual(@as(usize, 0), EmailCapture.count);
    try expectError(try rig.post("/api/auth/email/verify", "{\"email\":\"ghost@example.com\",\"code\":\"123456\"}", null), 401, "unauthorized");
    for ([_][]const u8{ "{}", "{\"email\":\"not an email\"}", "{\"email\":\"a@example.com\",\"code\":\"\"}" }) |bad| {
        const answer = try rig.post("/api/auth/email/verify", bad, null);
        try expectError(answer, 400, "invalid body");
    }
}

test "auth routes: five wrong email codes kill the code, the right one included" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const sink = EmailCapture.install();
    defer sink.restore();
    _ = try rig.ctx.user("a@example.com", false);
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"a@example.com\"}", null);
    const right = try rig.fmt("{{\"email\":\"a@example.com\",\"code\":\"{s}\"}}", .{EmailCapture.last()});
    const wrong = if (std.mem.eql(u8, EmailCapture.last(), "000000")) "{\"email\":\"a@example.com\",\"code\":\"000001\"}" else "{\"email\":\"a@example.com\",\"code\":\"000000\"}";
    for (0..5) |_| try expectError(try rig.post("/api/auth/email/verify", wrong, null), 401, "unauthorized");
    try expectError(try rig.post("/api/auth/email/verify", right, null), 401, "unauthorized");
}

// ---- recovery ----

test "auth routes: a recovery code logs in once and regenerating replaces the set" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const enrolled = try rig.enrollOwner();
    const set = (try enrolled.json(rig.alloc())).object.get("recoveryCodes").?.array.items;
    const first = try rig.fmt("{{\"email\":\"owner@example.com\",\"code\":\"{s}\"}}", .{set[0].string});
    const logged_in = try rig.post("/api/auth/recovery", first, null);
    try testing.expectEqual(@as(u16, 200), logged_in.status);
    try testing.expectEqualStrings("recovery", try methodOf(rig, logged_in));
    try expectError(try rig.post("/api/auth/recovery", first, null), 401, "unauthorized");

    // A recovery session proved possession of a one-time secret, so it may regenerate at once.
    const regenerated = try rig.post("/api/auth/recovery/regenerate", null, logged_in.cookie());
    try testing.expectEqual(@as(u16, 200), regenerated.status);
    try testing.expectEqual(@as(usize, 10), (try regenerated.json(rig.alloc())).object.get("recoveryCodes").?.array.items.len);
    const old = try rig.fmt("{{\"email\":\"owner@example.com\",\"code\":\"{s}\"}}", .{set[1].string});
    try expectError(try rig.post("/api/auth/recovery", old, null), 401, "unauthorized");
}

// ---- step-up, passkeys, sessions ----

test "auth routes: a recorded step-up unlocks passkey management for five minutes" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    try testing.expectEqual(@as(u16, 200), (try rig.enrollOwner()).status);
    const login = try rig.loginWith("es256: login, counter 1");
    try expectError(try rig.post("/api/auth/passkeys/options", null, login.cookie()), 403, "step_up_required");
    const up = try rig.stepUpWith("es256: step-up with UV required, counter 2", login.cookie());
    try testing.expectEqual(@as(u16, 200), up.status);
    try testing.expectEqualStrings("{\"ok\":true}", up.body);
    const me = try rig.get("/api/auth/me", login.cookie());
    try testing.expect((try me.json(rig.alloc())).object.get("session").?.object.get("stepUpFresh").?.bool);
    const options = try rig.post("/api/auth/passkeys/options", null, login.cookie());
    try testing.expectEqual(@as(u16, 200), options.status);
    try testing.expectEqual(@as(usize, 1), (try options.json(rig.alloc())).object.get("excludeCredentials").?.array.items.len);
}

test "auth routes: a failed step-up is 401 and sets nothing" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    try testing.expectEqual(@as(u16, 200), (try rig.enrollOwner()).status);
    const login = try rig.loginWith("es256: login, counter 1");
    // The recorded step-up carries a signature for the challenge the rig swaps in; here the
    // server's own challenge stays, so the signed one does not match.
    const options = try rig.post("/api/auth/step-up/options", null, login.cookie());
    const challenge_id = (try options.json(rig.alloc())).object.get("challengeId").?.string;
    const v = try rig.vector("es256: step-up with UV required, counter 2");
    try expectError(try rig.post("/api/auth/step-up/verify", try rig.assertion(v, challenge_id), login.cookie()), 401, "step-up failed");
    try expectError(try rig.post("/api/auth/step-up/verify", "{}", login.cookie()), 400, "invalid body");
    const me = try rig.get("/api/auth/me", login.cookie());
    try testing.expect(!(try me.json(rig.alloc())).object.get("session").?.object.get("stepUpFresh").?.bool);
    try expectError(try rig.post("/api/auth/step-up/options", null, null), 401, "unauthorized");
}

test "auth routes: passkeys list, and the last one stays" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const enrolled = try rig.enrollOwner();
    const list = try rig.get("/api/auth/passkeys", enrolled.cookie());
    try testing.expectEqual(@as(u16, 200), list.status);
    const items = (try list.json(rig.alloc())).array.items;
    try testing.expectEqual(@as(usize, 1), items.len);
    const passkey = items[0].object;
    try testing.expectEqualStrings("d5vuaACMtyd06IvKP1BTvg", passkey.get("id").?.string);
    try testing.expectEqualStrings("Laptop", passkey.get("name").?.string);
    try testing.expect(passkey.get("lastUsedAt").? == .null);
    try testing.expect(std.mem.find(u8, list.body, "\"id\"").? < std.mem.find(u8, list.body, "\"createdAt\"").?);

    // The enrollment session is fresh, so no step-up is needed to try.
    const url = "/api/auth/passkeys/d5vuaACMtyd06IvKP1BTvg";
    const last = try rig.send(.{ .method = .DELETE, .pattern = "/api/auth/passkeys/:id", .url = url, .params = &.{.{ "id", "d5vuaACMtyd06IvKP1BTvg" }}, .cookie = enrolled.cookie() });
    try expectError(last, 409, "cannot delete the last passkey");
    const unknown = try rig.send(.{ .method = .DELETE, .pattern = "/api/auth/passkeys/:id", .url = "/api/auth/passkeys/zzz", .params = &.{.{ "id", "zzz" }}, .cookie = enrolled.cookie() });
    try expectError(unknown, 404, "unknown passkey");
    try expectError(try rig.get("/api/auth/passkeys", null), 401, "unauthorized");
}

test "auth routes: sessions are listed, revoking another needs step-up, revoking this one does not" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const sink = EmailCapture.install();
    defer sink.restore();
    const enrolled = try rig.enrollOwner();
    try testing.expectEqual(@as(u16, 200), enrolled.status);
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"owner@example.com\"}", null);
    const email_session = try rig.post("/api/auth/email/verify", try rig.fmt("{{\"email\":\"owner@example.com\",\"code\":\"{s}\"}}", .{EmailCapture.last()}), null);
    const list = try rig.get("/api/auth/sessions", email_session.cookie());
    const items = (try list.json(rig.alloc())).array.items;
    try testing.expectEqual(@as(usize, 2), items.len);
    var current: usize = 0;
    var other: []const u8 = "";
    for (items) |item| {
        if (item.object.get("current").?.bool) current += 1 else other = item.object.get("id").?.string;
    }
    try testing.expectEqual(@as(usize, 1), current);
    try testing.expect(std.mem.find(u8, list.body, "\"expiresAt\"").? < std.mem.find(u8, list.body, "\"current\"").?);

    const url = try rig.fmt("/api/auth/sessions/{s}", .{other});
    const params: []const [2][]const u8 = &.{.{ "id", other }};
    try expectError(try rig.send(.{ .method = .DELETE, .pattern = "/api/auth/sessions/:id", .url = url, .params = params, .cookie = email_session.cookie() }), 403, "step_up_required");
    try expectError(try rig.send(.{ .method = .DELETE, .pattern = "/api/auth/sessions/:id", .url = "/api/auth/sessions/nope", .params = &.{.{ "id", "nope" }}, .cookie = email_session.cookie() }), 403, "step_up_required");

    const login = try rig.loginWith("es256: login, counter 1");
    _ = try rig.stepUpWith("es256: step-up with UV required, counter 2", login.cookie());
    const gone = try rig.send(.{ .method = .DELETE, .pattern = "/api/auth/sessions/:id", .url = url, .params = params, .cookie = login.cookie() });
    try testing.expectEqual(@as(u16, 200), gone.status);
    try expectError(try rig.send(.{ .method = .DELETE, .pattern = "/api/auth/sessions/:id", .url = "/api/auth/sessions/nope", .params = &.{.{ "id", "nope" }}, .cookie = login.cookie() }), 404, "unknown session");
    // The session that was listed as the other one is gone, the two in use are not.
    try expectError(try rig.get("/api/auth/me", enrolled.cookie()), 401, "unauthorized");
    try testing.expectEqual(@as(u16, 200), (try rig.get("/api/auth/me", email_session.cookie())).status);
    try testing.expectEqual(@as(u16, 200), (try rig.get("/api/auth/me", login.cookie())).status);
}

test "auth routes: signing in stores the user agent cut at 200 UTF-16 units and runs the org hook" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const Hook = struct {
        var calls: usize = 0;
        fn run(_: sqlite.Db, _: std.Io, _: std.mem.Allocator, user: codes.User) codes.Error!void {
            calls += 1;
            std.debug.assert(std.mem.eql(u8, "owner@example.com", user.email));
        }
    };
    codes.personal_org_hook = Hook.run;
    defer codes.personal_org_hook = null;
    const sink = EmailCapture.install();
    defer sink.restore();
    _ = try rig.ctx.user("owner@example.com", false);
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"owner@example.com\"}", null);
    const long_agent = "Mozilla/5.0 " ++ comptime repeat("y", 300);
    const answer = try rig.send(.{
        .pattern = "/api/auth/email/verify",
        .body = try rig.fmt("{{\"email\":\"owner@example.com\",\"code\":\"{s}\"}}", .{EmailCapture.last()}),
        .user_agent = long_agent,
    });
    try testing.expectEqual(@as(u16, 200), answer.status);
    try testing.expectEqual(@as(usize, 1), Hook.calls);
    const stmt = try rig.ctx.fx.db.prepare("SELECT length(user_agent) FROM sessions");
    defer stmt.finalize();
    _ = try stmt.step();
    try testing.expectEqual(@as(i64, 200), stmt.int(0));
}

test "auth routes: the user agent is cut like String.slice(0, 200)" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("abc", try routes.truncateUtf16(a, "abc", 200));
    try testing.expectEqual(@as(usize, 200), (try routes.truncateUtf16(a, comptime repeat("y", 250), 200)).len);
    // 199 units then an astral character: the pair does not fit and its half is U+FFFD.
    const edge = comptime repeat("y", 199) ++ "\u{1F600}";
    const cut = try routes.truncateUtf16(a, edge, 200);
    try testing.expectEqualStrings(comptime repeat("y", 199) ++ "\u{fffd}", cut);
    // 198 units then an astral character fits exactly.
    const fits = try routes.truncateUtf16(a, comptime repeat("y", 198) ++ "\u{1F600}x", 200);
    try testing.expectEqualStrings(comptime repeat("y", 198) ++ "\u{1F600}", fits);
    // A header that is not UTF-8 is read as Latin-1.
    try testing.expectEqualStrings("caf\u{e9}", try routes.truncateUtf16(a, "caf\xe9", 200));
    try testing.expectEqualStrings("localhost", routes.hostnameOf("http://localhost:4100"));
    try testing.expectEqualStrings("harness.example.com", routes.hostnameOf("https://harness.example.com"));
}

test "auth routes: public routes answer on the browser host only and need the exact Origin" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.req.method = .POST;
    web.url("/api/auth/login/options");
    web.header("host", rig.host);
    web.header("origin", "http://evil.test");
    try rig.server.chain(web.req, web.res, Rig.routeFor(.{ .pattern = "/api/auth/login/options" }));
    try web.expectStatus(403);
    try web.expectBody("{\"error\":\"forbidden origin\"}");
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM challenges"));
}

test "auth routes: a failure while finishing enrollment leaves no passkey and the code can retry" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
    try rig.ctx.sql("CREATE TRIGGER fail_complete BEFORE UPDATE OF used_at ON enrollments BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const failed = try rig.enrollWith(&code, "o@example.com");
    try testing.expectEqual(@as(u16, 500), failed.status);
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM passkeys"));
    try rig.ctx.sql("DROP TRIGGER fail_complete");
    // The claim was released and the code is still live, so the same code works again.
    const retried = try rig.enrollWith(&code, "o@example.com");
    try testing.expectEqual(@as(u16, 200), retried.status);
    try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM passkeys"));
}

const BlockedSink = struct {
    var release: std.atomic.Value(bool) = .init(false);
    var received: std.atomic.Value(u32) = .init(0);

    fn sink(io: std.Io, _: []const u8, _: []const u8) void {
        while (!release.load(.acquire)) io.sleep(.fromMilliseconds(1), .awake) catch return;
        _ = received.fetchAdd(1, .release);
    }
};

test "auth routes: a blocked mail sink does not delay the reply and still gets the message" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    _ = try rig.ctx.user("a@example.com", false);
    const previous = routes.email_sink;
    routes.email_sink = BlockedSink.sink;
    defer routes.email_sink = previous;
    BlockedSink.release.store(false, .release);
    BlockedSink.received.store(0, .release);
    // The reply is back while the sink is still stuck, for a known and an unknown address alike.
    const known = try rig.send(.{ .pattern = "/api/auth/email/request", .body = "{\"email\":\"a@example.com\"}" });
    const unknown = try rig.send(.{ .pattern = "/api/auth/email/request", .body = "{\"email\":\"ghost@example.com\"}" });
    try testing.expectEqualStrings("{\"ok\":true}", known.body);
    try testing.expectEqualStrings(known.body, unknown.body);
    try testing.expectEqual(@as(u32, 0), BlockedSink.received.load(.acquire));
    BlockedSink.release.store(true, .release);
    routes.drainDeliveries(testing.io);
    try testing.expectEqual(@as(u32, 1), BlockedSink.received.load(.acquire));
}

test "auth routes: a blocked sink and a flood of requests stay inside the worker bound and shut down on time" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const previous = routes.email_sink;
    routes.email_sink = BlockedSink.sink;
    defer routes.email_sink = previous;
    BlockedSink.release.store(false, .release);
    BlockedSink.received.store(0, .release);
    // One known address per request: the per-address limit would stop a single one at three.
    for (0..150) |n| {
        const email = try rig.fmt("u{d}@example.com", .{n});
        _ = try rig.ctx.user(email, false);
        const answer = try rig.send(.{ .pattern = "/api/auth/email/request", .body = try rig.fmt("{{\"email\":\"{s}\"}}", .{email}) });
        try testing.expectEqualStrings("{\"ok\":true}", answer.body);
    }
    try testing.expect(routes.deliveryThreads(testing.io) <= 2);
    const started = std.Io.Clock.awake.now(testing.io).toMilliseconds();
    routes.drainDeliveriesWithin(testing.io, 300);
    const took = std.Io.Clock.awake.now(testing.io).toMilliseconds() - started;
    try testing.expect(took < 2000);
    // Releasing the sink lets the workers finish what they hold and exit.
    BlockedSink.release.store(true, .release);
    routes.drainDeliveriesWithin(testing.io, 5000);
    try testing.expectEqual(@as(usize, 0), routes.deliveryThreads(testing.io));
    // Two in flight and 64 queued were kept; the rest were dropped, never queued without bound.
    try testing.expect(BlockedSink.received.load(.acquire) <= 66);
    try testing.expect(BlockedSink.received.load(.acquire) >= 2);
}

const QuickSink = struct {
    var received: std.atomic.Value(u32) = .init(0);

    fn sink(_: std.Io, _: []const u8, _: []const u8) void {
        _ = received.fetchAdd(1, .release);
    }
};

test "auth routes: idle delivery workers sleep, and a new code or a shutdown wakes them at once" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const previous = routes.email_sink;
    routes.email_sink = QuickSink.sink;
    defer routes.email_sink = previous;
    QuickSink.received.store(0, .release);
    _ = try rig.ctx.user("a@example.com", false);
    _ = try rig.ctx.user("b@example.com", false);
    _ = try rig.send(.{ .pattern = "/api/auth/email/request", .body = "{\"email\":\"a@example.com\"}" });
    // The first code starts the workers and goes out.
    var waited: usize = 0;
    while (QuickSink.received.load(.acquire) < 1 and waited < 2000) : (waited += 1) try testing.io.sleep(.fromMilliseconds(1), .awake);
    try testing.expectEqual(@as(u32, 1), QuickSink.received.load(.acquire));
    try testing.expectEqual(@as(usize, 2), routes.deliveryThreads(testing.io));
    // 300 ms of idleness: a polling worker would wake about 120 times, a sleeping one not at all.
    const before = routes.delivery_wakeups.load(.monotonic);
    try testing.io.sleep(.fromMilliseconds(300), .awake);
    try testing.expect(routes.delivery_wakeups.load(.monotonic) - before <= 2);
    // A new code wakes a worker well inside the old polling period of a slow poller.
    _ = try rig.send(.{ .pattern = "/api/auth/email/request", .body = "{\"email\":\"b@example.com\"}" });
    waited = 0;
    while (QuickSink.received.load(.acquire) < 2 and waited < 2000) : (waited += 1) try testing.io.sleep(.fromMilliseconds(1), .awake);
    try testing.expectEqual(@as(u32, 2), QuickSink.received.load(.acquire));
    // Shutdown wakes the sleepers instead of waiting for a timer.
    const started = std.Io.Clock.awake.now(testing.io).toMilliseconds();
    routes.drainDeliveriesWithin(testing.io, 5000);
    try testing.expect(std.Io.Clock.awake.now(testing.io).toMilliseconds() - started < 1000);
    try testing.expectEqual(@as(usize, 0), routes.deliveryThreads(testing.io));
}

fn expectNothingStored(rig: *Rig) !void {
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM passkeys"));
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM sessions"));
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM recovery_codes"));
    try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM enrollments WHERE used_at IS NOT NULL OR claimed_at IS NOT NULL"));
}

test "auth routes: an allocation failure while finishing an enrollment leaves nothing and the code retries" {
    var index: usize = 0;
    var failures: usize = 0;
    while (index < 120) : (index += 1) {
        const rig = try Rig.create(null);
        defer rig.destroy();
        const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
        const answer = try rig.enrollWithFailure(&code, "o@example.com", index);
        if (answer.status == 200) {
            try testing.expect(answer.set_cookie != null);
            try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM sessions"));
            try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM passkeys"));
            try testing.expectEqual(@as(i64, 10), try rig.ctx.count("SELECT count(*) FROM recovery_codes"));
        } else {
            failures += 1;
            try testing.expectEqual(@as(u16, 500), answer.status);
            try expectNothingStored(rig);
            try testing.expectEqual(@as(u16, 200), (try rig.enrollWith(&code, "o@example.com")).status);
        }
        if (!rig.induced) break;
    }
    try testing.expect(failures > 0);
}

test "auth routes: an allocation failure while signing in by email code leaves the code usable" {
    var index: usize = 0;
    var failures: usize = 0;
    while (index < 120) : (index += 1) {
        const rig = try Rig.create(null);
        defer rig.destroy();
        const sink = EmailCapture.install();
        defer sink.restore();
        _ = try rig.ctx.user("a@example.com", false);
        _ = try rig.post("/api/auth/email/request", "{\"email\":\"a@example.com\"}", null);
        const verify = try rig.fmt("{{\"email\":\"a@example.com\",\"code\":\"{s}\"}}", .{EmailCapture.last()});
        const answer = try rig.send(.{ .pattern = "/api/auth/email/verify", .body = verify, .fail_index = index });
        if (answer.status == 200) {
            try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM sessions"));
        } else {
            failures += 1;
            try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM sessions"));
            try testing.expectEqual(@as(u16, 200), (try rig.send(.{ .pattern = "/api/auth/email/verify", .body = verify })).status);
        }
        if (!rig.induced) break;
    }
    try testing.expect(failures > 0);
}

test "auth routes: an allocation failure while signing in by recovery code keeps the code" {
    var index: usize = 0;
    var failures: usize = 0;
    while (index < 120) : (index += 1) {
        const rig = try Rig.create(null);
        defer rig.destroy();
        const ada = try rig.ctx.user("a@example.com", false);
        const set = try codes.newRecoveryCodes(&rig.ctx.fx.app, ada);
        const body = try rig.fmt("{{\"email\":\"a@example.com\",\"code\":\"{s}\"}}", .{&set[0]});
        const answer = try rig.send(.{ .pattern = "/api/auth/recovery", .body = body, .fail_index = index });
        if (answer.status == 200) {
            try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM sessions"));
        } else {
            failures += 1;
            try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM sessions"));
            try testing.expectEqual(@as(i64, 0), try rig.ctx.count("SELECT count(*) FROM recovery_codes WHERE used_at IS NOT NULL"));
            try testing.expectEqual(@as(u16, 200), (try rig.send(.{ .pattern = "/api/auth/recovery", .body = body })).status);
        }
        if (!rig.induced) break;
    }
    try testing.expect(failures > 0);
}

const FlakyHook = struct {
    var fail_next = true;

    fn run(_: sqlite.Db, _: std.Io, _: std.mem.Allocator, _: codes.User) codes.Error!void {
        if (fail_next) {
            fail_next = false;
            return error.Step;
        }
    }
};

test "auth routes: a failing personal org hook or entropy source rolls the enrollment back and the retry works" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const code = try codes.createEnrollment(&rig.ctx.fx.app, .{ .ttl_ms = 60_000 }, @import("../ids.zig").nowMs(testing.io));
    codes.personal_org_hook = FlakyHook.run;
    defer codes.personal_org_hook = null;
    FlakyHook.fail_next = true;
    try testing.expectEqual(@as(u16, 500), (try rig.enrollWith(&code, "o@example.com")).status);
    try expectNothingStored(rig);
    // Entropy for the session or the recovery codes is drawn before anything is spent.
    codes.entropy_down_for_test = true;
    try testing.expectEqual(@as(u16, 500), (try rig.enrollWith(&code, "o@example.com")).status);
    codes.entropy_down_for_test = false;
    try expectNothingStored(rig);
    try testing.expectEqual(@as(u16, 200), (try rig.enrollWith(&code, "o@example.com")).status);
    try testing.expectEqual(@as(i64, 1), try rig.ctx.count("SELECT count(*) FROM sessions"));
}

test "auth routes: entropy that fails at sign-in leaves an email code usable" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const sink = EmailCapture.install();
    defer sink.restore();
    _ = try rig.ctx.user("a@example.com", false);
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"a@example.com\"}", null);
    const verify = try rig.fmt("{{\"email\":\"a@example.com\",\"code\":\"{s}\"}}", .{EmailCapture.last()});
    codes.entropy_down_for_test = true;
    try testing.expectEqual(@as(u16, 500), (try rig.send(.{ .pattern = "/api/auth/email/verify", .body = verify })).status);
    codes.entropy_down_for_test = false;
    try testing.expectEqual(@as(u16, 200), (try rig.send(.{ .pattern = "/api/auth/email/verify", .body = verify })).status);
}

test "auth routes: an allocation failure while regenerating recovery codes keeps the old set" {
    var index: usize = 0;
    var failures: usize = 0;
    while (index < 60) : (index += 1) {
        const rig = try Rig.create(null);
        defer rig.destroy();
        const enrolled = try rig.enrollOwner();
        const old = (try enrolled.json(rig.alloc())).object.get("recoveryCodes").?.array.items[0].string;
        const answer = try rig.send(.{ .pattern = "/api/auth/recovery/regenerate", .body = "{}", .cookie = enrolled.cookie(), .fail_index = index });
        const old_body = try rig.fmt("{{\"email\":\"owner@example.com\",\"code\":\"{s}\"}}", .{old});
        const old_works = (try rig.send(.{ .pattern = "/api/auth/recovery", .body = old_body })).status == 200;
        if (answer.status == 200) {
            try testing.expect(!old_works);
        } else {
            failures += 1;
            try testing.expect(old_works);
        }
        if (!rig.induced) break;
    }
    try testing.expect(failures > 0);
}

const Probe = struct { status: u16, body: []const u8, allocations: usize };

fn probe(rig: *Rig, pattern: []const u8, email: []const u8, code: []const u8) !Probe {
    const body = try rig.fmt("{{\"email\":\"{s}\",\"code\":\"{s}\"}}", .{ email, code });
    const answer = try rig.send(.{ .pattern = pattern, .body = body, .fail_index = std.math.maxInt(usize) });
    return .{ .status = answer.status, .body = answer.body, .allocations = rig.allocations };
}

test "auth routes: a wrong code costs the same and answers the same for a known and an unknown address" {
    const rig = try Rig.create(null);
    defer rig.destroy();
    const sink = EmailCapture.install();
    defer sink.restore();
    const ada = try rig.ctx.user("known@example.com", false);
    _ = try codes.newRecoveryCodes(&rig.ctx.fx.app, ada);
    // Both addresses have a stored email code; only the known one has an account.
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"known@example.com\"}", null);
    _ = try rig.post("/api/auth/email/request", "{\"email\":\"ghost@example.com\"}", null);
    for ([_][]const u8{ "/api/auth/email/verify", "/api/auth/recovery" }) |pattern| {
        const known = try probe(rig, pattern, "known@example.com", "111111");
        const unknown = try probe(rig, pattern, "ghost@example.com", "111111");
        try testing.expectEqual(@as(u16, 401), known.status);
        try testing.expectEqual(known.status, unknown.status);
        try testing.expectEqualStrings(known.body, unknown.body);
        try testing.expectEqual(known.allocations, unknown.allocations);
        // A failing entropy source is the same 500 for both.
        codes.entropy_down_for_test = true;
        defer codes.entropy_down_for_test = false;
        const known_down = try probe(rig, pattern, "known@example.com", "111111");
        const unknown_down = try probe(rig, pattern, "ghost@example.com", "111111");
        try testing.expectEqual(@as(u16, 500), known_down.status);
        try testing.expectEqual(known_down.status, unknown_down.status);
        try testing.expectEqualStrings(known_down.body, unknown_down.body);
    }
}
