//! Who may call a route. The flags per route live in routes.zig; the checks here are the Zig side of
//! code/src/server/features/auth/middleware.ts. The session itself is the auth slice's job: it
//! installs an `Authenticator`, and until it does every route that needs a session answers 401.
const std = @import("std");
const httpz = @import("httpz");

pub const Method = enum { GET, POST, PUT, PATCH, DELETE, any };

/// A route is public (no session), loopback (reachable on Host 127.0.0.1:<port> and before the
/// Origin guard) or behind a session. `admin` needs an instance admin on top. `step_up` is
/// metadata for the handlers: TS checks a fresh step-up inside the handler, not in middleware.
/// `origin` on a safe method (only /ws) makes the Origin header mandatory there too; mutations
/// under /api are always checked, see `mutationNeedsOrigin`.
pub const Policy = struct {
    public: bool = false,
    loopback: bool = false,
    session: bool = false,
    admin: bool = false,
    step_up: bool = false,
    origin: bool = false,
};

/// What the session middleware knows about the caller, the `Session` of sessions.ts. The strings
/// live in the request arena. `instance_admin` is what `requireInstanceAdmin` reads; handlers
/// compute step-up freshness against their own clock reading (`hasFreshStepUp`).
pub const Actor = struct {
    instance_admin: bool = false,
    user_id: []const u8 = "",
    session_id: []const u8 = "",
    /// `SessionMethod` as text: passkey, email, recovery or enroll.
    method: []const u8 = "",
    step_up_at: ?i64 = null,
};

/// Installed by the auth slice. `authenticate` returns null for no or an invalid session, and may
/// set a cookie on `res` (TS re-sets it when the stored expiry slid). An error is a failed lookup
/// (database, memory) and becomes a 500, as a throwing query does in TS. It runs on a pool thread
/// and takes the state lock itself.
pub const Authenticator = struct {
    ctx: *anyopaque,
    authenticate: *const fn (ctx: *anyopaque, req: *httpz.Request, res: *httpz.Response) anyerror!?Actor,
};

/// The auth rate limiter (rate-limit.ts), asked once per request after the Origin guard. It answers
/// 429 on `res` itself and returns false to stop the chain; paths it does not cover return true.
pub const Throttle = struct {
    ctx: *anyopaque,
    check: *const fn (ctx: *anyopaque, req: *httpz.Request, res: *httpz.Response) anyerror!bool,
};

pub const Verdict = union(enum) {
    allow: Actor,
    /// 401 `{"error":"unauthorized"}`
    unauthorized,
    /// 403 `{"error":"forbidden"}`
    forbidden,
};

/// sessionMiddleware, then requireInstanceAdmin when the route asks for it. With no authenticator
/// installed nobody has a session, so this fails closed.
pub fn sessionGate(auth: ?Authenticator, admin_required: bool, req: *httpz.Request, res: *httpz.Response) anyerror!Verdict {
    const installed = auth orelse return .unauthorized;
    const actor = try installed.authenticate(installed.ctx, req, res) orelse return .unauthorized;
    if (admin_required and !actor.instance_admin) return .forbidden;
    return .{ .allow = actor };
}

/// Paths an agent or a local probe may reach by Host 127.0.0.1:<port>.
/// `LOOPBACK_PATHS` in middleware.ts:25.
pub const loopback_paths = [_][]const u8{ "/mcp", "/api/guard/hook", "/api/health" };

pub fn isLoopbackPath(path: []const u8) bool {
    for (loopback_paths) |allowed| if (std.mem.eql(u8, path, allowed)) return true;
    return false;
}

/// hostGuard, middleware.ts:35-39: the Host must be the origin's host, or 127.0.0.1:<port> on a
/// loopback path. A missing Host is the empty string, which matches nothing.
pub fn hostAllowed(host: ?[]const u8, browser_host: []const u8, port: u16, path: []const u8) bool {
    const value = host orelse "";
    if (std.mem.eql(u8, value, browser_host)) return true;
    var buf: [32]u8 = undefined;
    const loopback_host = std.fmt.bufPrint(&buf, "127.0.0.1:{d}", .{port}) catch return false;
    return std.mem.eql(u8, value, loopback_host) and isLoopbackPath(path);
}

/// `host === "127.0.0.1:<port>"` of the `GET /` redirect, http.ts:109.
pub fn isLoopbackHost(host: ?[]const u8, port: u16) bool {
    var buf: [32]u8 = undefined;
    const loopback_host = std.fmt.bufPrint(&buf, "127.0.0.1:{d}", .{port}) catch return false;
    return std.mem.eql(u8, host orelse return false, loopback_host);
}

/// `SAFE_METHODS`, middleware.ts:22. The method comes off the wire as a token, so compare text.
pub fn isSafeMethod(method: []const u8) bool {
    return std.mem.eql(u8, method, "GET") or std.mem.eql(u8, method, "HEAD") or std.mem.eql(u8, method, "OPTIONS");
}

/// Hono's `/api/*` also matches `/api` itself.
pub fn isApiPath(path: []const u8) bool {
    return std.mem.eql(u8, path, "/api") or std.mem.startsWith(u8, path, "/api/");
}

/// mutationOriginGuard, middleware.ts:45-49, mounted on `/api/*` in http.ts:187: any method that is
/// not GET, HEAD or OPTIONS must carry exactly the configured Origin.
pub fn mutationNeedsOrigin(method: []const u8, path: []const u8) bool {
    return isApiPath(path) and !isSafeMethod(method);
}

/// The exact comparison of both origin guards: `c.req.header("origin") !== origin`.
pub fn originMatches(header: ?[]const u8, origin: []const u8) bool {
    return std.mem.eql(u8, header orelse return false, origin);
}

test "policy: host guard accepts the origin host and, on loopback paths only, 127.0.0.1:port" {
    const t = std.testing;
    try t.expect(hostAllowed("localhost:4100", "localhost:4100", 4100, "/api/agents"));
    try t.expect(hostAllowed("127.0.0.1:4100", "localhost:4100", 4100, "/api/health"));
    try t.expect(hostAllowed("127.0.0.1:4100", "localhost:4100", 4100, "/mcp"));
    try t.expect(hostAllowed("127.0.0.1:4100", "localhost:4100", 4100, "/api/guard/hook"));
    try t.expect(!hostAllowed("127.0.0.1:4100", "localhost:4100", 4100, "/api/agents"));
    try t.expect(!hostAllowed("127.0.0.1:4100", "localhost:4100", 4100, "/api/health/"));
    try t.expect(!hostAllowed("127.0.0.1:4101", "localhost:4100", 4100, "/api/health"));
    try t.expect(!hostAllowed("127.0.0.1", "localhost:4100", 4100, "/api/health"));
    try t.expect(!hostAllowed("evil.test", "localhost:4100", 4100, "/api/health"));
    try t.expect(!hostAllowed("localhost", "localhost:4100", 4100, "/api/health"));
    try t.expect(!hostAllowed("LOCALHOST:4100", "localhost:4100", 4100, "/api/health"));
    try t.expect(!hostAllowed(null, "localhost:4100", 4100, "/api/health"));
    try t.expect(!hostAllowed("", "localhost:4100", 4100, "/api/health"));
    try t.expect(hostAllowed("harness.example.com", "harness.example.com", 4100, "/"));
}

test "policy: loopback host is exactly 127.0.0.1:port" {
    try std.testing.expect(isLoopbackHost("127.0.0.1:4100", 4100));
    try std.testing.expect(!isLoopbackHost("127.0.0.1:4101", 4100));
    try std.testing.expect(!isLoopbackHost("localhost:4100", 4100));
    try std.testing.expect(!isLoopbackHost(null, 4100));
}

test "policy: origin guard covers mutations under /api and nothing else" {
    const t = std.testing;
    try t.expect(mutationNeedsOrigin("POST", "/api/tasks"));
    try t.expect(mutationNeedsOrigin("PUT", "/api/x"));
    try t.expect(mutationNeedsOrigin("PATCH", "/api/x"));
    try t.expect(mutationNeedsOrigin("DELETE", "/api/x"));
    try t.expect(mutationNeedsOrigin("POST", "/api"));
    try t.expect(mutationNeedsOrigin("POST", "/api/health"));
    try t.expect(mutationNeedsOrigin("PROPFIND", "/api/x"));
    try t.expect(!mutationNeedsOrigin("GET", "/api/tasks"));
    try t.expect(!mutationNeedsOrigin("HEAD", "/api/tasks"));
    try t.expect(!mutationNeedsOrigin("OPTIONS", "/api/tasks"));
    try t.expect(!mutationNeedsOrigin("POST", "/mcp"));
    try t.expect(!mutationNeedsOrigin("POST", "/apix"));
    try t.expect(!mutationNeedsOrigin("POST", "/"));
}

test "policy: origin must match exactly" {
    const t = std.testing;
    try t.expect(originMatches("http://localhost:4100", "http://localhost:4100"));
    try t.expect(!originMatches("http://localhost:4100/", "http://localhost:4100"));
    try t.expect(!originMatches("http://LOCALHOST:4100", "http://localhost:4100"));
    try t.expect(!originMatches("null", "http://localhost:4100"));
    try t.expect(!originMatches("", "http://localhost:4100"));
    try t.expect(!originMatches(null, "http://localhost:4100"));
}

test "policy: a session route fails closed when no authenticator is installed" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    const verdict = try sessionGate(null, false, web.req, web.res);
    try std.testing.expectEqual(Verdict.unauthorized, verdict);
}

const FakeAuth = struct {
    actor: ?Actor,

    fn authenticate(ctx: *anyopaque, _: *httpz.Request, _: *httpz.Response) anyerror!?Actor {
        const self: *FakeAuth = @ptrCast(@alignCast(ctx));
        return self.actor;
    }

    fn installed(self: *FakeAuth) Authenticator {
        return .{ .ctx = self, .authenticate = authenticate };
    }
};

test "policy: session gate maps the authenticator's answer" {
    var web = httpz.testing.init(.{});
    defer web.deinit();

    var nobody: FakeAuth = .{ .actor = null };
    try std.testing.expectEqual(Verdict.unauthorized, try sessionGate(nobody.installed(), false, web.req, web.res));

    var member: FakeAuth = .{ .actor = .{} };
    try std.testing.expectEqual(Verdict{ .allow = .{} }, try sessionGate(member.installed(), false, web.req, web.res));
    try std.testing.expectEqual(Verdict.forbidden, try sessionGate(member.installed(), true, web.req, web.res));

    var admin: FakeAuth = .{ .actor = .{ .instance_admin = true } };
    try std.testing.expectEqual(Verdict{ .allow = .{ .instance_admin = true } }, try sessionGate(admin.installed(), true, web.req, web.res));
}
