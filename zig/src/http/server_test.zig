//! Tests for the chain in server.zig: handlers called directly through httpz.testing, and the same
//! chain behind a real listener on port 0 with raw TCP so the bytes on the wire are what is checked.
const std = @import("std");
const httpz = @import("httpz");
const App = @import("../app.zig").App;
const policy = @import("policy.zig");
const routes = @import("routes.zig");
const server_mod = @import("server.zig");

const Server = server_mod.Server;
const Options = server_mod.Options;
const testing = std.testing;

const fake_health: routes.Health = .{ .instance_id = @splat('a') };
const direct_options: Options = .{ .host = "127.0.0.1", .port = 4100 };

fn routeFor(method: httpz.Method, path: []const u8) ?*const routes.Route {
    for (&routes.table) |*route| {
        if (!std.mem.eql(u8, route.path, path)) continue;
        if (route.method == .any or std.mem.eql(u8, @tagName(route.method), @tagName(method))) return route;
    }
    return null;
}

/// Runs the chain on a fake request. The caller keeps the server where it is: its services point
/// at the caller's `App`.
fn call(server: *Server, method: httpz.Method, path: []const u8, pairs: []const [2][]const u8) !httpz.testing.Testing {
    var web = httpz.testing.init(.{});
    errdefer web.deinit();
    web.req.method = method;
    web.url(path);
    for (pairs) |pair| web.header(pair[0], pair[1]);
    server.chain(web.req, web.res, routeFor(method, path)) catch |err| server.uncaughtError(web.req, web.res, err);
    return web;
}

test "http: a handler's own errors map to the contract shape" {
    var app = App.init(testing.allocator, testing.io);
    var server = Server.init(.{ .app = &app, .health = fake_health }, testing.io, direct_options);
    var web = httpz.testing.init(.{});
    defer web.deinit();
    server.uncaughtError(web.req, web.res, error.InvalidBody);
    try web.expectStatus(400);
    try web.expectBody("{\"error\":\"invalid body\"}");

    var boom = httpz.testing.init(.{});
    defer boom.deinit();
    server.uncaughtError(boom.req, boom.res, error.OutOfMemory);
    try boom.expectStatus(500);
    try boom.expectBody("{\"error\":\"internal\"}");
}

test "http: health answers with the instance facts on the browser host and on loopback" {
    var app = App.init(testing.allocator, testing.io);
    var server = Server.init(.{ .app = &app, .health = fake_health }, testing.io, direct_options);
    for ([_][]const u8{ "localhost:4100", "127.0.0.1:4100" }) |host| {
        var web = try call(&server, .GET, "/api/health", &.{.{ "host", host }});
        defer web.deinit();
        try web.expectStatus(200);
        try web.expectBody("{\"ok\":true,\"instanceId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"version\":\"0.0.0\"}");
        try web.expectHeader("content-type", "application/json");
        try web.expectHeader("X-Content-Type-Options", "nosniff");
    }
}

test "http: host guard answers 403 first, 404 only for allowed hosts" {
    var app = App.init(testing.allocator, testing.io);
    var server = Server.init(.{ .app = &app, .health = fake_health }, testing.io, direct_options);
    const cases = [_]struct { []const u8, []const u8, u16 }{
        .{ "evil.test", "/api/health", 403 },
        .{ "evil.test", "/nope", 403 },
        .{ "127.0.0.1:4100", "/api/agents", 403 },
        .{ "127.0.0.1:4100", "/nope", 403 },
        .{ "localhost:4100", "/nope", 404 },
    };
    for (cases) |case| {
        var web = try call(&server, .GET, case[1], &.{.{ "host", case[0] }});
        defer web.deinit();
        try web.expectStatus(case[2]);
        try web.expectHeader("Referrer-Policy", "no-referrer");
        if (case[2] == 403) try web.expectBody("{\"error\":\"forbidden host\"}");
    }
    var no_host = try call(&server, .GET, "/api/health", &.{});
    defer no_host.deinit();
    try no_host.expectStatus(403);
}

test "http: the loopback entry redirects to the origin and other methods do not" {
    var app = App.init(testing.allocator, testing.io);
    var server = Server.init(.{ .app = &app, .health = fake_health }, testing.io, direct_options);
    {
        var web = try call(&server, .GET, "/", &.{.{ "host", "127.0.0.1:4100" }});
        defer web.deinit();
        try web.expectStatus(302);
        try web.expectHeader("location", "http://localhost:4100");
        try web.expectHeader("X-Frame-Options", "SAMEORIGIN");
    }
    {
        var web = try call(&server, .POST, "/", &.{.{ "host", "127.0.0.1:4100" }});
        defer web.deinit();
        try web.expectStatus(403);
    }
    {
        var web = try call(&server, .GET, "/", &.{.{ "host", "localhost:4100" }});
        defer web.deinit();
        try web.expectStatus(404);
    }
    var proxied = Server.init(.{ .app = &app, .health = fake_health }, testing.io, .{
        .host = "127.0.0.1",
        .port = 4100,
        .origin = "https://harness.example.com",
    });
    var web = try call(&proxied, .GET, "/", &.{.{ "host", "127.0.0.1:4100" }});
    defer web.deinit();
    try web.expectHeader("location", "https://harness.example.com");
}

test "http: mutations under /api need the exact Origin, loopback rows do not" {
    var app = App.init(testing.allocator, testing.io);
    var server = Server.init(.{ .app = &app, .health = fake_health }, testing.io, direct_options);
    const host: [2][]const u8 = .{ "host", "localhost:4100" };
    const good: [2][]const u8 = .{ "origin", "http://localhost:4100" };
    const Case = struct { httpz.Method, []const u8, []const [2][]const u8, u16 };
    const cases = [_]Case{
        .{ .POST, "/api/auth/email/request", &.{host}, 403 },
        .{ .POST, "/api/auth/email/request", &.{ host, .{ "origin", "http://evil.test" } }, 403 },
        .{ .POST, "/api/auth/email/request", &.{ host, .{ "origin", "http://localhost:4100/" } }, 403 },
        .{ .POST, "/api/auth/email/request", &.{ host, good }, 400 },
        .{ .POST, "/api/nothing-here", &.{host}, 403 },
        .{ .PUT, "/api/tasks/1", &.{host}, 403 },
        .{ .PATCH, "/api/tasks/1", &.{host}, 403 },
        .{ .DELETE, "/api/tasks/1", &.{host}, 403 },
        .{ .POST, "/api/health", &.{host}, 403 },
        .{ .GET, "/api/health", &.{host}, 200 },
        .{ .POST, "/mcp", &.{host}, 401 },
        .{ .POST, "/api/guard/hook", &.{host}, 501 },
    };
    for (cases) |case| {
        var web = try call(&server, case[0], case[1], case[2]);
        defer web.deinit();
        try web.expectStatus(case[3]);
        if (case[3] == 403) try web.expectBody("{\"error\":\"forbidden origin\"}");
    }
}

test "http: session routes fail closed with no authenticator" {
    var app = App.init(testing.allocator, testing.io);
    var server = Server.init(.{ .app = &app, .health = fake_health }, testing.io, direct_options);
    const pairs: []const [2][]const u8 = &.{ .{ "host", "localhost:4100" }, .{ "origin", "http://localhost:4100" } };
    const cases = [_]struct { httpz.Method, []const u8 }{
        .{ .GET, "/api/agents" },
        .{ .POST, "/api/agents/x/link" },
        .{ .GET, "/api/no-such-thing" },
        .{ .GET, "/ws" },
    };
    for (cases) |case| {
        var web = try call(&server, case[0], case[1], pairs);
        defer web.deinit();
        try web.expectStatus(401);
        try web.expectBody("{\"error\":\"unauthorized\"}");
    }
}

const StubAuth = struct {
    actor: ?policy.Actor,

    fn authenticate(ctx: *anyopaque, _: *httpz.Request, _: *httpz.Response) anyerror!?policy.Actor {
        const self: *StubAuth = @ptrCast(@alignCast(ctx));
        return self.actor;
    }

    fn installed(self: *StubAuth) policy.Authenticator {
        return .{ .ctx = self, .authenticate = authenticate };
    }
};

test "http: with an authenticator, admin rows need an admin and unknown api paths are 404" {
    var app = App.init(testing.allocator, testing.io);
    var member: StubAuth = .{ .actor = .{} };
    var admin: StubAuth = .{ .actor = .{ .instance_admin = true } };
    const pairs: []const [2][]const u8 = &.{ .{ "host", "localhost:4100" }, .{ "origin", "http://localhost:4100" } };

    var as_member = Server.init(.{ .app = &app, .health = fake_health }, testing.io, .{
        .host = "127.0.0.1",
        .port = 4100,
        .authenticator = member.installed(),
    });
    var as_admin = Server.init(.{ .app = &app, .health = fake_health }, testing.io, .{
        .host = "127.0.0.1",
        .port = 4100,
        .authenticator = admin.installed(),
    });
    const Case = struct { *Server, httpz.Method, []const u8, u16 };
    const cases = [_]Case{
        .{ &as_member, .GET, "/api/agents", 403 },
        .{ &as_admin, .GET, "/api/agents", 501 },
        .{ &as_member, .GET, "/api/orgs", 501 },
        .{ &as_member, .GET, "/api/no-such-thing", 404 },
        .{ &as_member, .GET, "/ws", 501 },
    };
    for (cases) |case| {
        var web = try call(case[0], case[1], case[2], pairs);
        defer web.deinit();
        try web.expectStatus(case[3]);
    }
    var no_origin = try call(&as_member, .GET, "/ws", &.{.{ "host", "localhost:4100" }});
    defer no_origin.deinit();
    try no_origin.expectStatus(403);
    try no_origin.expectBody("{\"error\":\"forbidden origin\"}");
}

test "http: the listening line brackets IPv6 hosts and reports a short buffer" {
    var buf: [128]u8 = undefined;
    try testing.expectEqualStrings("harness listening on http://127.0.0.1:4100/\n", try server_mod.listeningLine(&buf, "127.0.0.1", 4100));
    try testing.expectEqualStrings("harness listening on http://[::1]:80/\n", try server_mod.listeningLine(&buf, "::1", 80));
    var tiny: [8]u8 = undefined;
    try testing.expectError(error.WriteFailed, server_mod.listeningLine(&tiny, "127.0.0.1", 4100));
}

test "http: the route table has no duplicate method and path, and mutations carry the origin flag" {
    for (routes.table, 0..) |a, i| {
        for (routes.table[i + 1 ..]) |b| {
            const same_path = std.mem.eql(u8, a.path, b.path);
            const overlap = a.method == b.method or a.method == .any or b.method == .any;
            try testing.expect(!(same_path and overlap));
        }
    }
    for (routes.table) |route| {
        const under_api = std.mem.startsWith(u8, route.path, "/api/");
        const mutation = route.method != .GET and route.method != .any;
        if (under_api and mutation and !route.policy.loopback) try testing.expect(route.policy.origin);
        // Every row is public, loopback or behind a session, never none of them.
        try testing.expect(route.policy.public or route.policy.loopback or route.policy.session);
    }
}

// ---- real listener ----

const Fixture = struct {
    app: App,
    handler: Server,
    running: server_mod.Running,

    fn create(options: Options) !*Fixture {
        const fixture = try testing.allocator.create(Fixture);
        errdefer testing.allocator.destroy(fixture);
        fixture.app = App.init(testing.allocator, testing.io);
        var listen_options = options;
        listen_options.port = 0;
        listen_options.threads = 2;
        fixture.handler = Server.init(.{ .app = &fixture.app, .health = fake_health }, testing.io, listen_options);
        fixture.running = try server_mod.start(testing.allocator, testing.io, &fixture.handler, listen_options);
        return fixture;
    }

    fn destroy(fixture: *Fixture) void {
        fixture.running.stop();
        fixture.running.deinit();
        testing.allocator.destroy(fixture);
    }

    /// Sends `request` as is and reads until the server closes the connection.
    fn exchange(fixture: *Fixture, request: []const u8) ![]u8 {
        const address: std.Io.net.IpAddress = .{ .ip4 = .loopback(fixture.running.port) };
        var stream = try address.connect(testing.io, .{ .mode = .stream });
        defer stream.close(testing.io);
        var read_buffer: [4096]u8 = undefined;
        var write_buffer: [4096]u8 = undefined;
        var reader = stream.reader(testing.io, &read_buffer);
        var writer = stream.writer(testing.io, &write_buffer);
        try writer.interface.writeAll(request);
        try writer.interface.flush();
        return reader.interface.allocRemaining(testing.allocator, .limited(2 * 1024 * 1024)) catch |err| switch (err) {
            error.ReadFailed => reader.err.?,
            else => |e| e,
        };
    }

    /// A request with `Connection: close`. `extra` is zero or more complete header lines.
    fn get(fixture: *Fixture, method: []const u8, path: []const u8, host: []const u8, extra: []const u8) ![]u8 {
        const request = try std.fmt.allocPrint(
            testing.allocator,
            "{s} {s} HTTP/1.1\r\nHost: {s}\r\n{s}Connection: close\r\nContent-Length: 0\r\n\r\n",
            .{ method, path, host, extra },
        );
        defer testing.allocator.free(request);
        return fixture.exchange(request);
    }

    fn hostHeader(fixture: *Fixture, buf: []u8, name: []const u8) ![]const u8 {
        return std.fmt.bufPrint(buf, "{s}:{d}", .{ name, fixture.running.port });
    }
};

fn statusOf(response: []const u8) !u16 {
    if (response.len < 12 or !std.mem.startsWith(u8, response, "HTTP/1.1 ")) return error.NotHttp;
    return std.fmt.parseInt(u16, response[9..12], 10);
}

fn headerOf(response: []const u8, name: []const u8) ?[]const u8 {
    const head_end = std.mem.find(u8, response, "\r\n\r\n") orelse response.len;
    var lines = std.mem.splitSequence(u8, response[0..head_end], "\r\n");
    _ = lines.next();
    while (lines.next()) |line| {
        const colon = std.mem.findScalar(u8, line, ':') orelse continue;
        if (std.ascii.eqlIgnoreCase(line[0..colon], name)) return std.mem.trim(u8, line[colon + 1 ..], " ");
    }
    return null;
}

fn bodyOf(response: []const u8) []const u8 {
    const head_end = std.mem.find(u8, response, "\r\n\r\n") orelse return "";
    return response[head_end + 4 ..];
}

test "http: real socket, health, secure headers and the printed port" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    try testing.expect(fixture.running.port != 0);
    try testing.expectEqual(fixture.running.port, fixture.handler.port.load(.acquire));

    var host_buf: [32]u8 = undefined;
    const response = try fixture.get("GET", "/api/health", try fixture.hostHeader(&host_buf, "localhost"), "Origin: x\r\n");
    defer testing.allocator.free(response);
    try testing.expectEqual(@as(u16, 200), try statusOf(response));
    try testing.expectEqualStrings("{\"ok\":true,\"instanceId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"version\":\"0.0.0\"}", bodyOf(response));
    try testing.expectEqualStrings("application/json", headerOf(response, "content-type").?);
    for (@import("headers.zig").secure_headers) |pair| try testing.expectEqualStrings(pair[1], headerOf(response, pair[0]).?);

    const loopback = try fixture.get("GET", "/api/health", try fixture.hostHeader(&host_buf, "127.0.0.1"), "");
    defer testing.allocator.free(loopback);
    try testing.expectEqual(@as(u16, 200), try statusOf(loopback));
}

test "http: real socket, unknown route, host guard and the loopback entry" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    var host_buf: [32]u8 = undefined;
    const browser = try fixture.hostHeader(&host_buf, "localhost");

    const unknown = try fixture.get("GET", "/no/such/route", browser, "");
    defer testing.allocator.free(unknown);
    try testing.expectEqual(@as(u16, 404), try statusOf(unknown));
    try testing.expectEqualStrings("404 Not Found", bodyOf(unknown));
    try testing.expectEqualStrings("no-referrer", headerOf(unknown, "referrer-policy").?);

    const bad_host = try fixture.get("GET", "/api/health", "evil.test", "");
    defer testing.allocator.free(bad_host);
    try testing.expectEqual(@as(u16, 403), try statusOf(bad_host));
    try testing.expectEqualStrings("{\"error\":\"forbidden host\"}", bodyOf(bad_host));

    var loop_buf: [32]u8 = undefined;
    const redirect = try fixture.get("GET", "/", try fixture.hostHeader(&loop_buf, "127.0.0.1"), "");
    defer testing.allocator.free(redirect);
    try testing.expectEqual(@as(u16, 302), try statusOf(redirect));
    var expected: [48]u8 = undefined;
    try testing.expectEqualStrings(try std.fmt.bufPrint(&expected, "http://localhost:{d}", .{fixture.running.port}), headerOf(redirect, "location").?);
    try testing.expectEqualStrings("nosniff", headerOf(redirect, "x-content-type-options").?);

    const http10 = try fixture.exchange("GET /api/health HTTP/1.0\r\n\r\n");
    defer testing.allocator.free(http10);
    try testing.expectEqual(@as(u16, 403), try statusOf(http10));
}

test "http: real socket, origin guard on mutations and the fail-closed session route" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    var host_buf: [32]u8 = undefined;
    const browser = try fixture.hostHeader(&host_buf, "localhost");
    var origin_buf: [64]u8 = undefined;
    const origin_line = try std.fmt.bufPrint(&origin_buf, "Origin: http://localhost:{d}\r\n", .{fixture.running.port});

    const no_origin = try fixture.get("POST", "/api/auth/email/request", browser, "");
    defer testing.allocator.free(no_origin);
    try testing.expectEqual(@as(u16, 403), try statusOf(no_origin));
    try testing.expectEqualStrings("{\"error\":\"forbidden origin\"}", bodyOf(no_origin));

    const with_origin = try fixture.get("POST", "/api/auth/email/request", browser, origin_line);
    defer testing.allocator.free(with_origin);
    try testing.expectEqual(@as(u16, 400), try statusOf(with_origin));
    try testing.expectEqualStrings("{\"error\":\"invalid body\"}", bodyOf(with_origin));

    const session = try fixture.get("GET", "/api/agents", browser, "");
    defer testing.allocator.free(session);
    try testing.expectEqual(@as(u16, 401), try statusOf(session));
    try testing.expectEqualStrings("{\"error\":\"unauthorized\"}", bodyOf(session));

    const mutation = try fixture.get("DELETE", "/api/agents/1", browser, origin_line);
    defer testing.allocator.free(mutation);
    try testing.expectEqual(@as(u16, 401), try statusOf(mutation));
}

test "http: real socket, the body cap is 1 MiB" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    var host_buf: [32]u8 = undefined;
    const loopback = try fixture.hostHeader(&host_buf, "127.0.0.1");

    const over_header = try std.fmt.allocPrint(
        testing.allocator,
        "POST /mcp HTTP/1.1\r\nHost: {s}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n",
        .{ loopback, server_mod.max_request_body_bytes + 1 },
    );
    defer testing.allocator.free(over_header);
    const over = try fixture.exchange(over_header);
    defer testing.allocator.free(over);
    try testing.expectEqual(@as(u16, 413), try statusOf(over));

    const exact_body = try testing.allocator.alloc(u8, server_mod.max_request_body_bytes);
    defer testing.allocator.free(exact_body);
    @memset(exact_body, 'a');
    const exact_request = try std.fmt.allocPrint(
        testing.allocator,
        "POST /mcp HTTP/1.1\r\nHost: {s}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}",
        .{ loopback, exact_body.len, exact_body },
    );
    defer testing.allocator.free(exact_request);
    const exact = try fixture.exchange(exact_request);
    defer testing.allocator.free(exact);
    // A body of exactly the cap reaches the handler; /mcp answers 401 for a request with no token.
    try testing.expectEqual(@as(u16, 401), try statusOf(exact));
}

test "http: real socket, ambiguous framing and duplicate hosts are refused" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    var host_buf: [32]u8 = undefined;
    const loopback = try fixture.hostHeader(&host_buf, "127.0.0.1");

    const smuggle = try std.fmt.allocPrint(
        testing.allocator,
        "POST /mcp HTTP/1.1\r\nHost: {s}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
        .{loopback},
    );
    defer testing.allocator.free(smuggle);
    const refused = try fixture.exchange(smuggle);
    defer testing.allocator.free(refused);
    try testing.expectEqual(@as(u16, 400), try statusOf(refused));

    const two_hosts = try std.fmt.allocPrint(
        testing.allocator,
        "GET /api/health HTTP/1.1\r\nHost: {s}\r\nHost: evil.test\r\nConnection: close\r\n\r\n",
        .{loopback},
    );
    defer testing.allocator.free(two_hosts);
    const doubled = try fixture.exchange(two_hosts);
    defer testing.allocator.free(doubled);
    try testing.expectEqual(@as(u16, 400), try statusOf(doubled));
}

test "http: real socket, dist files bypass the host guard and carry no secure headers" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "index.html", .data = "<p>shell</p>" });
    try tmp.dir.writeFile(io, .{ .sub_path = "sw.js", .data = "self" });
    try tmp.dir.writeFile(io, .{ .sub_path = "outside-marker", .data = "x" });
    const dist = try tmp.dir.realPathFileAlloc(io, ".", testing.allocator);
    defer testing.allocator.free(dist);

    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0, .ui_dist = dist });
    defer fixture.destroy();

    const entry = try fixture.get("GET", "/_app", "evil.test", "");
    defer testing.allocator.free(entry);
    try testing.expectEqual(@as(u16, 200), try statusOf(entry));
    try testing.expectEqualStrings("<p>shell</p>", bodyOf(entry));
    try testing.expect(headerOf(entry, "x-frame-options") == null);

    const root = try fixture.get("GET", "/", "evil.test", "");
    defer testing.allocator.free(root);
    try testing.expectEqualStrings("<p>shell</p>", bodyOf(root));

    const worker = try fixture.get("GET", "/sw.js", "evil.test", "");
    defer testing.allocator.free(worker);
    try testing.expectEqualStrings("no-cache", headerOf(worker, "cache-control").?);
    try testing.expectEqualStrings("/", headerOf(worker, "service-worker-allowed").?);

    const traversal = try fixture.get("GET", "/..%2f..%2fetc%2fpasswd", "evil.test", "");
    defer testing.allocator.free(traversal);
    try testing.expectEqual(@as(u16, 403), try statusOf(traversal));
}

test "http: real socket, a configured origin replaces localhost in the guards" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0, .origin = "https://harness.example.com" });
    defer fixture.destroy();

    const health = try fixture.get("GET", "/api/health", "harness.example.com", "");
    defer testing.allocator.free(health);
    try testing.expectEqual(@as(u16, 200), try statusOf(health));

    const wrong = try fixture.get("POST", "/api/auth/email/request", "harness.example.com", "Origin: http://localhost:1\r\n");
    defer testing.allocator.free(wrong);
    try testing.expectEqual(@as(u16, 403), try statusOf(wrong));

    const right = try fixture.get("POST", "/api/auth/email/request", "harness.example.com", "Origin: https://harness.example.com\r\n");
    defer testing.allocator.free(right);
    try testing.expectEqual(@as(u16, 400), try statusOf(right));
}

fn stopSoon(io: std.Io) void {
    io.sleep(.fromMilliseconds(300), .awake) catch return;
    server_mod.requestStop();
}

test "http: run twice in one process on port 0" {
    var app = App.init(testing.allocator, testing.io);
    for (0..2) |_| {
        // Not stdout: under `zig build test` it carries the test runner's protocol.
        var discard: std.Io.Writer.Discarding = .init(&.{});
        const stopper = try std.Thread.spawn(.{}, stopSoon, .{testing.io});
        defer stopper.join();
        try server_mod.run(testing.allocator, testing.io, &app, fake_health, .{ .host = "127.0.0.1", .port = 0, .threads = 2 }, &discard.writer);
    }
}

test "http: a failing stdout after the listener is up stops and joins it" {
    var app = App.init(testing.allocator, testing.io);
    var out: std.Io.Writer = .failing;
    try testing.expectError(error.WriteFailed, server_mod.run(testing.allocator, testing.io, &app, fake_health, .{ .host = "127.0.0.1", .port = 0, .threads = 2 }, &out));
}

test "http: hosts resolve as literals, as localhost, and through the resolver" {
    const literal = try server_mod.resolveAddress(testing.io, "127.0.0.1", 4100);
    try testing.expectEqual(@as(u16, 4100), literal.getPort());
    const local = try server_mod.resolveAddress(testing.io, "localhost", 0);
    try testing.expectEqual(@as(u16, 0), local.getPort());
    const looked_up = try server_mod.lookupAddress(testing.io, "localhost", 4100);
    try testing.expectEqual(@as(u16, 4100), looked_up.getPort());
    try testing.expectError(error.UnresolvableHost, server_mod.lookupAddress(testing.io, "no-such-host.invalid", 0));
    try testing.expectError(error.UnresolvableHost, server_mod.lookupAddress(testing.io, "bad host name", 0));
}

test "http: port 0 binds a real, nonzero port" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    try testing.expect(fixture.running.port > 0);
}

test "http: real socket, HEAD runs the GET handler and sends no body" {
    const fixture = try Fixture.create(.{ .host = "127.0.0.1", .port = 0 });
    defer fixture.destroy();
    var host_buf: [32]u8 = undefined;
    const browser = try fixture.hostHeader(&host_buf, "localhost");

    const head = try fixture.get("HEAD", "/api/health", browser, "");
    defer testing.allocator.free(head);
    try testing.expectEqual(@as(u16, 200), try statusOf(head));
    try testing.expectEqualStrings("", bodyOf(head));

    const missing = try fixture.get("HEAD", "/no/such/route", browser, "");
    defer testing.allocator.free(missing);
    try testing.expectEqual(@as(u16, 404), try statusOf(missing));
    try testing.expectEqualStrings("", bodyOf(missing));
}
