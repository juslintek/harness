//! HTTP slice (Z2): the httpz server and the middleware chain of code/src/main.ts and
//! code/src/server/http.ts, in the same order:
//!
//!   1. main.ts fetch: dist files and PWA paths, then the `/` entry. Before everything else, so
//!      these answer on any Host and carry no secure headers (the TS app serves them outside Hono).
//!   2. secureHeaders on every other response.
//!   3. `GET /` on Host 127.0.0.1:<port> redirects to the origin.
//!   4. hostGuard.
//!   5. routes mounted before the Origin guard (health, /mcp, the guard hook): the loopback rows.
//!   6. mutationOriginGuard on every non-safe method under `/api`.
//!   7. public routes, then the session gate for everything else under `/api` (also for paths that
//!      match no route, so an unknown `/api/x` is 401 without a session and 404 with one).
//!   8. `/ws`: session, then Origin.
const std = @import("std");
const builtin = @import("builtin");
const httpz = @import("httpz");
const App = @import("../app.zig").App;
const config_mod = @import("../config.zig");
const headers = @import("headers.zig");
const hub_mod = @import("../realtime/hub.zig");
const policy = @import("policy.zig");
const routes = @import("routes.zig");
const static = @import("static.zig");

/// `MAX_REQUEST_BODY_BYTES` of http.ts, applied before any handler runs, as Bun does.
pub const max_request_body_bytes: usize = 1024 * 1024;

/// Seconds to receive a request, and to wait for the next one on an idle connection. Bun's
/// default idle timeout is 10 s; a slow upload of a full 1 MiB body gets more room.
const request_timeout_s: u32 = 30;
const keepalive_timeout_s: u32 = 15;

/// Request line plus headers. httpz answers 431 above it; the default 4 KiB is tight for cookies.
const header_buffer_bytes: usize = 16 * 1024;

const origin_buf_len = 64;

pub const Options = struct {
    host: []const u8,
    /// 0 binds a free port.
    port: u16,
    /// HARNESS_ORIGIN as normalised by `config.load`; null means http://localhost:<bound port>.
    origin: ?[]const u8 = null,
    /// HARNESS_UI_DIST.
    ui_dist: ?[]const u8 = null,
    /// Installed by the auth slice. Null makes every session route answer 401.
    authenticator: ?policy.Authenticator = null,
    /// Installed by the auth slice; null means no rate limit.
    throttle: ?policy.Throttle = null,
    /// HARNESS_TRUST_PROXY: the auth rate limit keys on X-Forwarded-For instead of the socket.
    trust_proxy: bool = false,
    /// The realtime hub behind `/ws`. It must outlive the listener; null leaves `/ws` at 501.
    hub: ?*hub_mod.Hub = null,
    threads: ?u16 = null,
};

/// The httpz handler. `dispatch`, `notFound` and `uncaughtError` are the hooks httpz looks for.
pub const Server = struct {
    /// httpz closes an upgraded socket unless the handler names who serves it.
    pub const WebsocketHandler = hub_mod.Client;

    services: routes.Services,
    io: std.Io,
    configured_origin: ?[]const u8,
    ui_dist: ?[]const u8,
    authenticator: ?policy.Authenticator,
    throttle: ?policy.Throttle,
    /// The bound port, stored once the listener is up. Requests that race it see 0 and fail the
    /// host guard, which is the safe answer.
    port: std.atomic.Value(u16),

    pub fn init(services: routes.Services, io: std.Io, options: Options) Server {
        return .{
            .services = services,
            .io = io,
            .configured_origin = options.origin,
            .ui_dist = options.ui_dist,
            .authenticator = options.authenticator,
            .throttle = options.throttle,
            .port = .init(options.port),
        };
    }

    /// `deps.rp.origin`: HARNESS_ORIGIN, or `http://localhost:<port>` (config.ts:35).
    fn originFor(self: *const Server, buf: *[origin_buf_len]u8) []const u8 {
        if (self.configured_origin) |configured| return configured;
        return std.fmt.bufPrint(buf, "http://localhost:{d}", .{self.port.load(.acquire)}) catch "http://localhost";
    }

    pub fn dispatch(self: *Server, _: httpz.Action(*Server), req: *httpz.Request, res: *httpz.Response) !void {
        const route: *const routes.Route = @ptrCast(@alignCast(req.route_data orelse return error.RouteDataMissing));
        try self.chain(req, res, route);
        dropHeadBody(req, res);
    }

    pub fn notFound(self: *Server, req: *httpz.Request, res: *httpz.Response) !void {
        try self.chain(req, res, null);
        dropHeadBody(req, res);
    }

    pub fn uncaughtError(_: *Server, req: *httpz.Request, res: *httpz.Response, err: anyerror) void {
        const mapped = headers.mapError(err);
        if (mapped.status >= 500 and !builtin.is_test) std.log.err("request failed: {s} {s}: {t}", .{ methodName(req), req.url.path, err });
        res.clearWriter();
        headers.sendError(res, mapped.status, mapped.message) catch {
            res.status = mapped.status;
            res.body = mapped.message;
        };
        dropHeadBody(req, res);
    }

    /// httpz writes a body on HEAD too, which would desynchronise a kept-alive connection. Hono
    /// runs a GET handler for HEAD and sends no body; the length header is the only thing lost.
    fn dropHeadBody(req: *const httpz.Request, res: *httpz.Response) void {
        if (req.method != .HEAD) return;
        res.clearWriter();
        res.body = "";
    }

    pub fn chain(self: *Server, req: *httpz.Request, res: *httpz.Response, route: ?*const routes.Route) !void {
        const path = req.url.path;
        const method = methodName(req);
        const host = req.header("host");
        const port = self.port.load(.acquire);

        if (try static.serve(self.io, res, self.ui_dist, method, path)) return;
        if (std.mem.eql(u8, path, "/") and !policy.isLoopbackHost(host, port)) {
            if (try static.serveEntry(self.io, res, self.ui_dist)) return;
        }

        headers.applySecure(res);

        var origin_buf: [origin_buf_len]u8 = undefined;
        const origin = self.originFor(&origin_buf);

        if (std.mem.eql(u8, method, "GET") and std.mem.eql(u8, path, "/") and policy.isLoopbackHost(host, port)) {
            // The loopback entry cannot sign in (WebAuthn refuses IP RP IDs), so send it on.
            res.status = 302;
            res.header("location", try res.arena.dupe(u8, origin));
            return;
        }

        if (!policy.hostAllowed(host, hostOf(origin), port, path)) return headers.sendError(res, 403, "forbidden host");

        if (route) |matched| if (matched.policy.loopback) return self.run(matched, req, res, null);

        if (policy.mutationNeedsOrigin(method, path) and !policy.originMatches(req.header("origin"), origin))
            return headers.sendError(res, 403, "forbidden origin");

        // publicAuthRoutes mounts its limiter right after the Origin guard, ahead of routing.
        if (self.throttle) |throttle| if (!try throttle.check(throttle.ctx, req, res)) return;

        const matched = route orelse {
            if (policy.isApiPath(path)) switch (try policy.sessionGate(self.authenticator, false, req, res)) {
                .allow => {},
                .unauthorized => return headers.sendError(res, 401, "unauthorized"),
                .forbidden => return headers.sendError(res, 403, "forbidden"),
            };
            return headers.sendHonoNotFound(res);
        };

        if (matched.policy.public) return self.run(matched, req, res, null);

        // Everything else under /api needs a session whatever its flags say: sessionMiddleware is
        // mounted on `/api/*`, so a row that forgot the flag fails closed instead of open.
        const actor = switch (try policy.sessionGate(self.authenticator, matched.policy.admin, req, res)) {
            .allow => |actor| actor,
            .unauthorized => return headers.sendError(res, 401, "unauthorized"),
            .forbidden => return headers.sendError(res, 403, "forbidden"),
        };
        if (matched.policy.origin and !policy.originMatches(req.header("origin"), origin))
            return headers.sendError(res, 403, "forbidden origin");
        return self.run(matched, req, res, actor);
    }

    fn run(self: *Server, route: *const routes.Route, req: *httpz.Request, res: *httpz.Response, actor: ?policy.Actor) !void {
        var call: routes.Call = .{ .services = &self.services, .req = req, .res = res, .actor = actor };
        try route.handler(&call);
    }
};

/// A request method as text. httpz only keeps the string for methods outside its enum.
fn methodName(req: *const httpz.Request) []const u8 {
    return if (req.method == .OTHER) req.method_string else @tagName(req.method);
}

/// `new URL(origin).host`: everything after the scheme.
fn hostOf(origin: []const u8) []const u8 {
    const scheme_end = std.mem.find(u8, origin, "://") orelse return origin;
    return origin[scheme_end + 3 ..];
}

fn unusedAction(_: *Server, _: *httpz.Request, _: *httpz.Response) !void {}

/// Registers every row of the table. The row travels as route data; `Server.dispatch` reads it.
pub fn registerRoutes(server: *httpz.Server(*Server), table: []const routes.Route) !void {
    const router = try server.router(.{});
    for (table) |*route| {
        const config = router.routeConfig(.{ .data = route });
        switch (route.method) {
            .GET => {
                try router.tryGet(route.path, unusedAction, config);
                try router.tryHead(route.path, unusedAction, config);
            },
            .POST => try router.tryPost(route.path, unusedAction, config),
            .PUT => try router.tryPut(route.path, unusedAction, config),
            .PATCH => try router.tryPatch(route.path, unusedAction, config),
            .DELETE => try router.tryDelete(route.path, unusedAction, config),
            .any => try router.tryAll(route.path, unusedAction, config),
        }
    }
}

/// `harness listening on <url>`, main.ts:66. Bun prints the URL with a trailing slash.
pub fn listeningLine(buf: []u8, host: []const u8, port: u16) std.Io.Writer.Error![]const u8 {
    const bracket = std.mem.findScalar(u8, host, ':') != null;
    return std.fmt.bufPrint(buf, "harness listening on http://{s}{s}{s}:{d}/\n", .{
        if (bracket) "[" else "",
        host,
        if (bracket) "]" else "",
        port,
    }) catch error.WriteFailed;
}

/// Bun resolves `hostname`, so a machine name works there. An IP literal is parsed, `localhost` is
/// a shortcut for 127.0.0.1, any other name goes through the resolver and the first address wins.
pub fn resolveAddress(io: std.Io, host: []const u8, port: u16) !std.Io.net.IpAddress {
    const literal = if (std.mem.eql(u8, host, "localhost")) config_mod.default_host else host;
    if (std.Io.net.IpAddress.parse(literal, port)) |address| return address else |_| {}
    return lookupAddress(io, host, port);
}

pub fn lookupAddress(io: std.Io, host: []const u8, port: u16) error{UnresolvableHost}!std.Io.net.IpAddress {
    const name = std.Io.net.HostName.init(host) catch return error.UnresolvableHost;
    var storage: [16]std.Io.net.HostName.LookupResult = undefined;
    var queue: std.Io.Queue(std.Io.net.HostName.LookupResult) = .init(&storage);
    name.lookup(io, &queue, .{ .port = port }) catch return error.UnresolvableHost;
    while (queue.getOneUncancelable(io)) |result| switch (result) {
        .address => |address| return address,
        .canonical_name => {},
    } else |_| {}
    return error.UnresolvableHost;
}

/// The port the listener really got. httpz (pinned at 1bb71ff) has no public accessor for the
/// bound address, so this reads its `_listener` fd. An httpz bump that renames or retypes the
/// field fails the build here instead of surfacing as a host guard that never matches.
fn boundPort(server: *httpz.Server(*Server)) !u16 {
    comptime {
        const Impl = @typeInfo(@TypeOf(server)).pointer.child;
        if (!@hasField(Impl, "_listener") or @FieldType(Impl, "_listener") != ?std.posix.fd_t)
            @compileError("httpz changed: Server._listener (?fd_t) is gone; re-check how to learn the bound port (pinned httpz 1bb71ff)");
    }
    const fd = server._listener orelse return error.NotListening;
    var address: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(@TypeOf(address));
    const rc = std.posix.system.getsockname(fd, @ptrCast(&address), &len);
    if (std.posix.errno(rc) != .SUCCESS) return error.Unexpected;
    const any: *const std.posix.sockaddr = @ptrCast(&address);
    return switch (any.family) {
        std.posix.AF.INET => std.mem.bigToNative(u16, @as(*const std.posix.sockaddr.in, @ptrCast(@alignCast(any))).port),
        std.posix.AF.INET6 => std.mem.bigToNative(u16, @as(*const std.posix.sockaddr.in6, @ptrCast(@alignCast(any))).port),
        else => error.Unexpected,
    };
}

fn threadCount(options: Options) u16 {
    if (options.threads) |count| return count;
    const cpus = std.Thread.getCpuCount() catch 4;
    return @intCast(std.math.clamp(cpus * 2, 4, 16));
}

/// A running listener. Call `stop` once, then `deinit`.
pub const Running = struct {
    gpa: std.mem.Allocator,
    /// On the heap: the accept thread holds a pointer to it, so it must never move.
    server: *httpz.Server(*Server),
    thread: std.Thread,
    port: u16,

    pub fn stop(self: *Running) void {
        self.server.stop();
        self.thread.join();
    }

    pub fn deinit(self: *Running) void {
        self.server.deinit();
        self.gpa.destroy(self.server);
    }
};

/// Binds and starts serving on its own thread. `handler` must outlive the result and not move.
pub fn start(gpa: std.mem.Allocator, io: std.Io, handler: *Server, options: Options) !Running {
    const server = try gpa.create(httpz.Server(*Server));
    errdefer gpa.destroy(server);
    server.* = try httpz.Server(*Server).init(io, gpa, .{
        .address = .{ .ip = try resolveAddress(io, options.host, options.port) },
        .thread_pool = .{ .count = threadCount(options) },
        .request = .{
            .max_body_size = max_request_body_bytes,
            .buffer_size = header_buffer_bytes,
        },
        .response = .{ .max_header_count = 32 },
        .timeout = .{ .request = request_timeout_s, .keepalive = keepalive_timeout_s },
        .websocket = hub_mod.websocket_config,
    }, handler);
    errdefer server.deinit();
    try registerRoutes(server, &routes.table);
    const thread = try server.listenInNewThread();
    errdefer {
        server.stop();
        thread.join();
    }
    const port = try boundPort(server);
    handler.port.store(port, .release);
    return .{ .gpa = gpa, .server = server, .thread = thread, .port = port };
}

var stop_requested: std.atomic.Value(bool) = .init(false);

fn onSignal(_: std.posix.SIG) callconv(.c) void {
    stop_requested.store(true, .release);
}

/// What the signal handler does; also how a test stops `run`.
pub fn requestStop() void {
    stop_requested.store(true, .release);
}

fn installSignalHandlers() void {
    const action: std.posix.Sigaction = .{
        .handler = .{ .handler = onSignal },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    std.posix.sigaction(.INT, &action, null);
    std.posix.sigaction(.TERM, &action, null);
}

/// `harness serve` for the HTTP layer: listens, prints the listening line, and returns after
/// SIGINT or SIGTERM once the listener has stopped and its threads are joined.
pub fn run(gpa: std.mem.Allocator, io: std.Io, app: *App, health: routes.Health, options: Options, out: *std.Io.Writer) !void {
    stop_requested.store(false, .release);
    var handler = Server.init(.{ .app = app, .health = health, .hub = options.hub }, io, options);
    var running = try start(gpa, io, &handler, options);
    // Whatever fails after the listener is up, the accept thread must be joined before the server
    // is freed, so stop and deinit live in one defer.
    var stopped = false;
    defer {
        if (!stopped) running.stop();
        running.deinit();
    }

    var line_buf: [128]u8 = undefined;
    try out.writeAll(try listeningLine(&line_buf, options.host, running.port));
    try out.flush();

    installSignalHandlers();
    while (!stop_requested.load(.acquire)) io.sleep(.fromMilliseconds(50), .awake) catch break;
    stopped = true;
    running.stop();
}

test {
    _ = @import("headers.zig");
    _ = @import("policy.zig");
    _ = @import("routes.zig");
    _ = @import("static.zig");
    _ = @import("ws.zig");
    _ = @import("server_test.zig");
}
