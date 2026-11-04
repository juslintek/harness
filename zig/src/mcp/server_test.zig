//! Tests for the endpoint. Expected bodies are what the TS server answered on the wire
//! (SDK 1.32.2, captured with code/src/server/features/mcp/api.ts in process), not what the code
//! under test produces.
const std = @import("std");
const httpz = @import("httpz");
const Fixture = @import("../auth/fixture.zig").Fixture;
const sessions = @import("../auth/sessions.zig");
const middleware = @import("../auth/middleware.zig");
const routes = @import("../http/routes.zig");
const http_server = @import("../http/server.zig");
const server = @import("server.zig");
const tokens = @import("tokens.zig");
const tools = @import("tools.zig");

const testing = std.testing;
const t0: i64 = 1_700_000_000_000;

const ok_headers: server.Headers = .{
    .accept = "application/json, text/event-stream",
    .content_type = "application/json",
    .protocol_version = null,
};

const Rig = struct {
    fx: *Fixture,
    arena: std.heap.ArenaAllocator,
    deps: tools.Deps = .{},
    identity: tokens.Identity,

    fn init(scopes: []const tokens.Scope) !Rig {
        const fx = try Fixture.create(testing.allocator, testing.io);
        errdefer fx.destroy();
        var arena: std.heap.ArenaAllocator = .init(testing.allocator);
        errdefer arena.deinit();
        const token = try tokens.mint(&fx.app, "run-7", scopes, .none, t0);
        const identity = (try tokens.verify(&fx.app, arena.allocator(), &token)).?;
        return .{ .fx = fx, .arena = arena, .identity = identity };
    }

    fn deinit(rig: *Rig) void {
        rig.arena.deinit();
        rig.fx.destroy();
    }

    fn env(rig: *Rig) server.Env {
        return .{ .arena = rig.arena.allocator(), .app = &rig.fx.app, .deps = &rig.deps, .identity = rig.identity };
    }

    fn send(rig: *Rig, headers: server.Headers, request: []const u8) !server.Reply {
        return server.post(rig.env(), headers, request);
    }

    fn body(rig: *Rig, request: []const u8) ![]const u8 {
        const reply = try rig.send(ok_headers, request);
        try testing.expectEqual(@as(u16, 200), reply.status);
        return reply.body;
    }

    fn expectBody(rig: *Rig, request: []const u8, expected: []const u8) !void {
        try testing.expectEqualStrings(expected, try rig.body(request));
    }

    fn expectRefused(rig: *Rig, headers: server.Headers, request: []const u8, status: u16, expected: []const u8) !void {
        const reply = try rig.send(headers, request);
        try testing.expectEqual(status, reply.status);
        try testing.expectEqualStrings(expected, reply.body);
    }
};

fn eventCount(fx: *Fixture) !i64 {
    const stmt = try fx.db.prepare("SELECT count(*) FROM events WHERE source = 'mcp' AND kind = 'message'");
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

test "mcp: initialize echoes a supported version and otherwise offers the latest" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const tail = "\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"harness\",\"version\":\"1.0.0\"}},\"jsonrpc\":\"2.0\",\"id\":1}";
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}}",
        "{\"result\":{\"protocolVersion\":\"2025-06-18\"," ++ tail,
    );
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"1999\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}}",
        "{\"result\":{\"protocolVersion\":\"2025-11-25\"," ++ tail,
    );
}

test "mcp: a malformed initialize is an internal error carrying the zod issues" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32603,\"message\":\"[\\n  {\\n    \\\"expected\\\": \\\"object\\\",\\n    \\\"code\\\": \\\"invalid_type\\\",\\n" ++
            "    \\\"path\\\": [\\n      \\\"params\\\"\\n    ],\\n    \\\"message\\\": \\\"Invalid input: expected object, received undefined\\\"\\n  }\\n]\"}}",
    );
    const reply = try rig.send(ok_headers, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}");
    try testing.expect(std.mem.find(u8, reply.body, "Invalid input: expected string, received number") != null);
    try testing.expect(std.mem.find(u8, reply.body, "expected object, received undefined") != null);
}

test "mcp: ping, unknown methods and server/discover" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    try rig.expectBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}", "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
    try rig.expectBody("{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"method\":\"ping\",\"params\":{\"a\":1}}", "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":\"abc\"}");
    try rig.expectBody("{\"jsonrpc\":\"2.0\",\"id\":1.0,\"method\":\"ping\"}", "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
    const not_found = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}";
    inline for (.{ "server/discover", "foo/bar", "resources/list", "prompts/list", "logging/setLevel" }) |method| {
        try rig.expectBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"" ++ method ++ "\"}", not_found);
    }
}

test "mcp: tools/list serves the whole dump without scopes" {
    var rig = try Rig.init(&.{});
    defer rig.deinit();
    const body = try rig.body("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"cursor\":\"x\"}}");
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, rig.arena.allocator(), body, .{});
    const listed = parsed.object.get("result").?.object.get("tools").?.array.items;
    try testing.expectEqual(tools.table.len, listed.len);
    for (listed, tools.table) |entry, tool| {
        try testing.expectEqualStrings(tool.name, entry.object.get("name").?.string);
        try testing.expect(entry.object.get("scope") == null);
    }
    const bad = try rig.send(ok_headers, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"cursor\":5}}");
    try testing.expect(std.mem.find(u8, bad.body, "\"code\":-32603") != null);
}

test "mcp: whoami without a member, and with a member and positions" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const call = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\",\"arguments\":{\"ignored\":1}}}";
    try rig.expectBody(call, "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"runId\\\":\\\"run-7\\\",\\\"scopes\\\":[\\\"report\\\"]}\"}]},\"jsonrpc\":\"2.0\",\"id\":1}");
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\"}}",
        "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"runId\\\":\\\"run-7\\\",\\\"scopes\\\":[\\\"report\\\"]}\"}]},\"jsonrpc\":\"2.0\",\"id\":1}",
    );

    try rig.fx.run("INSERT INTO orgs (id, name, slug, created_at) VALUES ('o1', 'Acme', 'acme', 1)");
    try rig.fx.run("INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('m1', 'o1', 'agent', 'a', 'ada', 'Ada', 'member', 1)");
    try rig.fx.run("INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('m2', 'o1', 'agent', 'b', 'bob', 'Bob', 'member', 1)");
    try rig.fx.run("INSERT INTO positions (id, org_id, title, member_id, is_manager, created_at) VALUES ('p2', 'o1', 'Lead', 'm1', 1, 5)");
    try rig.fx.run("INSERT INTO positions (id, org_id, title, member_id, is_manager, created_at) VALUES ('p1', 'o1', 'Dev', 'm1', 0, 5)");
    try rig.fx.run("INSERT INTO positions (id, org_id, title, member_id, is_manager, created_at) VALUES ('p3', 'o1', 'Other', 'm2', 0, 1)");
    const token = try tokens.mint(&rig.fx.app, "run-9", &.{ .report, .board }, .{ .member = .{ .member_id = "m1", .org_id = "o1" } }, t0);
    rig.identity = (try tokens.verify(&rig.fx.app, rig.arena.allocator(), &token)).?;
    const reply = try rig.body(call);
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, rig.arena.allocator(), reply, .{});
    const text = parsed.object.get("result").?.object.get("content").?.array.items[0].object.get("text").?.string;
    try testing.expectEqualStrings(
        "{\"runId\":\"run-9\",\"scopes\":[\"report\",\"board\"],\"member\":{\"id\":\"m1\",\"handle\":\"ada\",\"orgId\":\"o1\",\"role\":\"member\",\"positions\":[{\"title\":\"Dev\",\"isManager\":false},{\"title\":\"Lead\",\"isManager\":true}]}}",
        text,
    );
}

fn reportCall(arena: std.mem.Allocator, text: []const u8) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(arena);
    try out.writer.writeAll("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{\"text\":");
    try std.json.Stringify.encodeJsonString(text, .{}, &out.writer);
    try out.writer.writeAll("}}}");
    return out.written();
}

const report_ok = "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]},\"jsonrpc\":\"2.0\",\"id\":1}";

fn validation(comptime message: []const u8) []const u8 {
    return "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"MCP error -32602: Input validation error: Invalid arguments for tool report: " ++ message ++ " at text\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}";
}

test "mcp: report stores an event, and its argument checks answer as the SDK does" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    try rig.expectBody(try reportCall(rig.arena.allocator(), "halfway"), report_ok);
    try testing.expectEqual(@as(i64, 1), try eventCount(rig.fx));
    const stmt = try rig.fx.db.prepare("SELECT run_id FROM events WHERE source = 'mcp'");
    defer stmt.finalize();
    _ = try stmt.step();
    try testing.expectEqualStrings("run-7", (try stmt.text(0)).?);

    const big = try rig.arena.allocator().alloc(u8, 4001);
    @memset(big, 'x');
    try rig.expectBody(try reportCall(rig.arena.allocator(), big), validation("Too big: expected string to have <=4000 characters"));
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{}}}",
        validation("Invalid input: expected string, received undefined"),
    );
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\"}}",
        validation("Invalid input: expected string, received undefined"),
    );
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{\"text\":5}}}",
        validation("Invalid input: expected string, received number"),
    );
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{\"text\":null}}}",
        validation("Invalid input: expected string, received null"),
    );
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{\"text\":\"a\",\"zzz\":1}}}",
        report_ok,
    );
    // The last of two equal keys wins, as in JSON.parse.
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{\"text\":5,\"text\":\"b\"}}}",
        report_ok,
    );
    try testing.expectEqual(@as(i64, 3), try eventCount(rig.fx));
}

test "mcp: the report limit counts code points, as zod 4 does" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const arena = rig.arena.allocator();
    const emoji = "😀";
    const four_thousand = try arena.alloc(u8, emoji.len * 4000);
    for (0..4000) |i| @memcpy(four_thousand[i * emoji.len ..][0..emoji.len], emoji);
    try rig.expectBody(try reportCall(arena, four_thousand), report_ok);
    const over = try std.mem.concat(arena, u8, &.{ four_thousand, emoji });
    try rig.expectBody(try reportCall(arena, over), validation("Too big: expected string to have <=4000 characters"));
}

test "mcp: a token without the scope cannot report, and nothing is stored" {
    var rig = try Rig.init(&.{.guard_hook});
    defer rig.deinit();
    try rig.expectBody(
        try reportCall(rig.arena.allocator(), "hi"),
        "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"token lacks report scope\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}",
    );
    try testing.expectEqual(@as(i64, 0), try eventCount(rig.fx));
}

test "mcp: tools of other slices answer scope first, then not implemented" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"board_list\",\"arguments\":{}}}",
        "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"token lacks board scope\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}",
    );
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"nope\",\"arguments\":{}}}",
        "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"MCP error -32602: Tool nope not found\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}",
    );
}

test "mcp: a malformed tools/call is an internal error carrying the zod issues" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const cases = [_]struct { []const u8, []const u8 }{
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\"}", "Invalid input: expected object, received undefined" },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":5}}", "Invalid input: expected string, received number" },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":[1]}}", "Invalid input: expected record, received array" },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":null}}", "Invalid input: expected record, received null" },
    };
    for (cases) |case| {
        const body = try rig.body(case[0]);
        try testing.expect(std.mem.startsWith(u8, body, "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32603,\"message\":\"[\\n  {"));
        try testing.expect(std.mem.find(u8, body, case[1]) != null);
    }
}

test "mcp: notifications get 202, batches answer in order, and a lone request in a batch is unwrapped" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    for ([_][]const u8{
        "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",
        "[]",
        "[{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}]",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}",
    }) |body| {
        const reply = try rig.send(ok_headers, body);
        try testing.expectEqual(@as(u16, 202), reply.status);
        try testing.expectEqualStrings("", reply.body);
    }
    try rig.expectBody(
        "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"},{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}]",
        "[{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1},{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":2}]",
    );
    try rig.expectBody("[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]", "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
    try rig.expectRefused(
        ok_headers,
        "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}},{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}]",
        400,
        "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: Only one initialization request is allowed\"},\"id\":null}",
    );
}

test "mcp: a batch over 100 messages is refused" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    var out: std.Io.Writer.Allocating = .init(rig.arena.allocator());
    try out.writer.writeByte('[');
    for (0..101) |i| {
        if (i > 0) try out.writer.writeByte(',');
        try out.writer.writeAll("{\"jsonrpc\":\"2.0\",\"method\":\"x\"}");
    }
    try out.writer.writeByte(']');
    try rig.expectRefused(ok_headers, out.written(), 400, "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"Invalid Request: Batch must not exceed 100 messages\"},\"id\":null}");
}

test "mcp: transport refusals carry the SDK's status, code and message" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const ping = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
    const e = struct {
        fn body(comptime code: []const u8, comptime message: []const u8) []const u8 {
            return "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":" ++ code ++ ",\"message\":\"" ++ message ++ "\"},\"id\":null}";
        }
    };
    try rig.expectRefused(.{ .accept = "application/json", .content_type = "application/json", .protocol_version = null }, ping, 406, e.body("-32000", "Not Acceptable: Client must accept both application/json and text/event-stream"));
    try rig.expectRefused(.{ .accept = null, .content_type = "application/json", .protocol_version = null }, ping, 406, e.body("-32000", "Not Acceptable: Client must accept both application/json and text/event-stream"));
    try rig.expectRefused(.{ .accept = ok_headers.accept, .content_type = "text/plain", .protocol_version = null }, ping, 415, e.body("-32000", "Unsupported Media Type: Content-Type must be application/json"));
    try rig.expectRefused(.{ .accept = ok_headers.accept, .content_type = null, .protocol_version = null }, ping, 415, e.body("-32000", "Unsupported Media Type: Content-Type must be application/json"));
    try rig.expectRefused(.{ .accept = ok_headers.accept, .content_type = "application/json, text/plain", .protocol_version = null }, ping, 415, e.body("-32000", "Unsupported Media Type: Content-Type must be application/json"));
    try rig.expectBody(ping, "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
    const charset: server.Headers = .{ .accept = ok_headers.accept, .content_type = "Application/JSON; charset=utf-8", .protocol_version = "2024-11-05" };
    try rig.expectRefused(charset, ping, 200, "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
    try rig.expectRefused(.{ .accept = ok_headers.accept, .content_type = "application/json", .protocol_version = "1999-01-01" }, ping, 400, e.body("-32000", "Bad Request: Unsupported protocol version: 1999-01-01 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"));
    try rig.expectRefused(ok_headers, "", 400, e.body("-32700", "Parse error: Invalid JSON"));
    try rig.expectRefused(ok_headers, "{nope", 400, e.body("-32700", "Parse error: Invalid JSON"));
    const not_rpc = e.body("-32700", "Parse error: Invalid JSON-RPC message");
    for ([_][]const u8{
        "{\"hello\":1}",
        "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":\"ping\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":12345678901234567890,\"method\":\"ping\"}",
        "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"extra\":1}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":\"x\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":null}",
        "[1]",
        "7",
    }) |body| try rig.expectRefused(ok_headers, body, 400, not_rpc);
}

test "mcp: a document nested a million deep is refused without recursing" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const deep = try rig.arena.allocator().alloc(u8, 1024 * 1024);
    @memset(deep, '[');
    try rig.expectRefused(ok_headers, deep, 400, "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32700,\"message\":\"Parse error: Invalid JSON\"},\"id\":null}");
    // Brackets inside a string do not count, and a modest nesting still parses.
    try rig.expectBody(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\",\"arguments\":{\"a\":[[[[[[\"[[[[[[[[[[[\"]]]]]]}}}",
        "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"runId\\\":\\\"run-7\\\",\\\"scopes\\\":[\\\"report\\\"]}\"}]},\"jsonrpc\":\"2.0\",\"id\":1}",
    );
}

// ---- the route behind the real chain ----

const fake_health: routes.Health = .{ .instance_id = @splat('a') };

const Wire = struct {
    fx: *Fixture,
    session_auth: middleware.SessionAuth,
    handler: http_server.Server,

    fn init(wire: *Wire) !void {
        wire.fx = try Fixture.create(testing.allocator, testing.io);
        wire.session_auth = middleware.SessionAuth.init(&wire.fx.app, null);
        wire.handler = http_server.Server.init(.{ .app = &wire.fx.app, .health = fake_health }, testing.io, .{
            .host = "127.0.0.1",
            .port = 4100,
            .authenticator = wire.session_auth.authenticator(),
        });
    }

    fn deinit(wire: *Wire) void {
        wire.fx.destroy();
    }

    fn route(path: []const u8) ?*const routes.Route {
        for (&routes.table) |*row| if (std.mem.eql(u8, row.path, path)) return row;
        return null;
    }

    fn call(wire: *Wire, method: httpz.Method, path: []const u8, pairs: []const [2][]const u8, body: ?[]const u8) !httpz.testing.Testing {
        var web = httpz.testing.init(.{});
        errdefer web.deinit();
        web.req.method = method;
        web.url(path);
        for (pairs) |pair| web.header(pair[0], pair[1]);
        if (body) |text| web.body(text);
        try wire.handler.chain(web.req, web.res, route(path));
        return web;
    }
};

fn bearerOf(arena: std.mem.Allocator, token: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "Bearer {s}", .{token});
}

const ping_body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
test "mcp: the route answers a run token and refuses everything else with the TS statuses" {
    var wire: Wire = undefined;
    try wire.init();
    defer wire.deinit();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const token = try tokens.mint(&wire.fx.app, "run-1", &.{.report}, .none, t0);
    const bearer = try bearerOf(arena.allocator(), &token);
    const base = [_][2][]const u8{ .{ "host", "127.0.0.1:4100" }, .{ "accept", "application/json, text/event-stream" }, .{ "content-type", "application/json" } };

    {
        var web = try wire.call(.POST, "/mcp", &(base ++ [_][2][]const u8{.{ "authorization", bearer }}), ping_body);
        defer web.deinit();
        try web.expectStatus(200);
        try web.expectBody("{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
        try web.expectHeader("content-type", "application/json");
        try web.expectHeader("X-Content-Type-Options", "nosniff");
    }
    {
        var web = try wire.call(.POST, "/mcp", &(base ++ [_][2][]const u8{.{ "authorization", "Bearer nope" }}), ping_body);
        defer web.deinit();
        try web.expectStatus(401);
        try web.expectBody("unauthorized");
        try web.expectHeader("www-authenticate", "Bearer");
    }
    inline for (.{ "", "Bearer", "Bearer ", "bearer x", "Bearer a b", "Basic abc" }) |header| {
        var web = try wire.call(.POST, "/mcp", &(base ++ [_][2][]const u8{.{ "authorization", header }}), ping_body);
        defer web.deinit();
        try web.expectStatus(401);
    }
    {
        var web = try wire.call(.POST, "/mcp", &base, ping_body);
        defer web.deinit();
        try web.expectStatus(401);
    }
    for ([_][]const u8{ "evil.example:80", "127.0.0.1:4101", "127.0.0.1", "localhost:4100x", "" }) |host| {
        var web = try wire.call(.POST, "/mcp", &[_][2][]const u8{ .{ "host", host }, .{ "authorization", bearer } }, ping_body);
        defer web.deinit();
        try web.expectStatus(403);
    }
    {
        // localhost:<port> is an accepted Host here, as in createHandler.
        var web = try wire.call(.POST, "/mcp", &[_][2][]const u8{ .{ "host", "localhost:4100" }, .{ "authorization", bearer }, .{ "accept", "application/json, text/event-stream" }, .{ "content-type", "application/json" } }, ping_body);
        defer web.deinit();
        try web.expectStatus(200);
    }
    for ([_]httpz.Method{ .GET, .DELETE, .PUT, .PATCH }) |method| {
        var web = try wire.call(method, "/mcp", &(base ++ [_][2][]const u8{.{ "authorization", bearer }}), null);
        defer web.deinit();
        try web.expectStatus(405);
        try web.expectBody("method not allowed");
        try web.expectHeader("allow", "POST");
    }
    try revokeAndExpect401(&wire, "run-1", bearer, &base);
}

fn revokeAndExpect401(wire: *Wire, run_id: []const u8, bearer: []const u8, base: []const [2][]const u8) !void {
    try tokens.revoke(&wire.fx.app, run_id);
    var pairs: [4][2][]const u8 = undefined;
    @memcpy(pairs[0..3], base);
    pairs[3] = .{ "authorization", bearer };
    var web = try wire.call(.POST, "/mcp", &pairs, ping_body);
    defer web.deinit();
    try web.expectStatus(401);
}

test "mcp: a session cookie is refused on /mcp, even when it is sent as the bearer" {
    var wire: Wire = undefined;
    try wire.init();
    defer wire.deinit();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try wire.fx.addUser("admin", true);
    const created = try sessions.create(&wire.fx.app, .{ .user_id = "admin", .method = .passkey, .user_agent = null }, ids_now());
    const cookie = try std.fmt.allocPrint(arena.allocator(), "harness_session={s}", .{created.token});
    const base = [_][2][]const u8{ .{ "host", "127.0.0.1:4100" }, .{ "accept", "application/json, text/event-stream" }, .{ "content-type", "application/json" } };

    // The same session is good on /api: the cookie is what that surface accepts.
    {
        var web = try wire.call(.GET, "/api/auth/me", &[_][2][]const u8{ .{ "host", "localhost:4100" }, .{ "cookie", cookie } }, null);
        defer web.deinit();
        try web.expectStatus(200);
    }
    {
        var web = try wire.call(.POST, "/mcp", &(base ++ [_][2][]const u8{.{ "cookie", cookie }}), ping_body);
        defer web.deinit();
        try web.expectStatus(401);
        try web.expectHeader("www-authenticate", "Bearer");
    }
    {
        const as_bearer = try bearerOf(arena.allocator(), &created.token);
        var web = try wire.call(.POST, "/mcp", &(base ++ [_][2][]const u8{ .{ "cookie", cookie }, .{ "authorization", as_bearer } }), ping_body);
        defer web.deinit();
        try web.expectStatus(401);
    }
}

fn ids_now() i64 {
    return @import("../ids.zig").nowMs(testing.io);
}

test "mcp: a run token is refused on /api, as a bearer and as a cookie" {
    var wire: Wire = undefined;
    try wire.init();
    defer wire.deinit();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const token = try tokens.mint(&wire.fx.app, "run-1", &.{ .report, .guard_hook, .board }, .none, t0);
    const bearer = try bearerOf(arena.allocator(), &token);
    const cookie = try std.fmt.allocPrint(arena.allocator(), "harness_session={s}", .{token});
    for ([_][]const u8{ "/api/auth/me", "/api/runs", "/api/orgs", "/api/approvals", "/api/nonexistent" }) |path| {
        var web = try wire.call(.GET, path, &[_][2][]const u8{ .{ "host", "localhost:4100" }, .{ "authorization", bearer } }, null);
        defer web.deinit();
        try web.expectStatus(401);
        try web.expectBody("{\"error\":\"unauthorized\"}");
        var as_cookie = try wire.call(.GET, path, &[_][2][]const u8{ .{ "host", "localhost:4100" }, .{ "cookie", cookie } }, null);
        defer as_cookie.deinit();
        try as_cookie.expectStatus(401);
    }
    // Loopback Host does not open /api to a bearer either: the host guard answers first.
    var web = try wire.call(.GET, "/api/auth/me", &[_][2][]const u8{ .{ "host", "127.0.0.1:4100" }, .{ "authorization", bearer } }, null);
    defer web.deinit();
    try web.expectStatus(403);
}

test "mcp: Accept must list both media types, not merely contain their text" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    const ping = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
    const refused = "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"Not Acceptable: Client must accept both application/json and text/event-stream\"},\"id\":null}";
    for ([_][]const u8{ "application/json-patch+json, text/event-stream-x", "application/jsonx,text/event-streamx", "*/*", "" }) |accept| {
        try rig.expectRefused(.{ .accept = accept, .content_type = "application/json", .protocol_version = null }, ping, 406, refused);
    }
    for ([_][]const u8{ "text/event-stream,application/json", "Application/JSON;q=0.9 , text/event-stream; q=0.1" }) |accept| {
        try rig.expectRefused(.{ .accept = accept, .content_type = "application/json", .protocol_version = null }, ping, 200, "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":1}");
    }
}

test "mcp: a token without the scope learns nothing about the argument rules" {
    var rig = try Rig.init(&.{.guard_hook});
    defer rig.deinit();
    const refused = "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"token lacks report scope\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}";
    try rig.expectBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report\",\"arguments\":{\"text\":5}}}", refused);
    const big = try rig.arena.allocator().alloc(u8, 4001);
    @memset(big, 'x');
    try rig.expectBody(try reportCall(rig.arena.allocator(), big), refused);
}

test "mcp: report text with quotes and newlines is stored whole" {
    var rig = try Rig.init(&.{.report});
    defer rig.deinit();
    try rig.expectBody(try reportCall(rig.arena.allocator(), "say \"hi\"\nthen \\ done"), report_ok);
    const stmt = try rig.fx.db.prepare("SELECT body FROM pending_payloads");
    defer stmt.finalize();
    _ = try stmt.step();
    try testing.expectEqualStrings("say \"hi\"\nthen \\ done", (try stmt.text(0)).?);
}

test "mcp: stdio answers a line over the buffer with a null-id error and goes on" {
    const pad: [200]u8 = @splat('x');
    const input = try std.fmt.allocPrint(testing.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{{\"pad\":\"{s}\"}}}}\n{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}}\n", .{pad});
    defer testing.allocator.free(input);
    var source: std.Io.Reader = .fixed(input);
    var small: [64]u8 = undefined;
    var limited = source.limited(.unlimited, &small);
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    var client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer client.deinit();
    try server.proxyLines(testing.allocator, &client, "http://127.0.0.1:1/mcp", "tok", &limited.interface, &out.writer);
    try testing.expectEqualStrings("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"request too long\"},\"id\":null}\n", out.written());
}
