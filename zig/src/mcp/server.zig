//! The legacy-era MCP endpoint, a port of code/src/server/features/mcp/server.ts together with what
//! SDK 1.32.2 does behind it (WebStandardStreamableHTTPServerTransport in stateless JSON mode and
//! the McpServer request handlers). Every reply here was checked against the TS server on the wire.
//! `initialize` echoes a supported client version and `server/discover` is an unknown method.
//!
//! The endpoint trusts nothing but the run token: the session cookie is never read here, and the
//! session gate never reads the Authorization header, so neither credential works on the other's
//! surface.
const std = @import("std");
const httpz = @import("httpz");
const config = @import("../config.zig");
const hook_http = @import("../guard/hook_http.zig");
const routes = @import("../http/routes.zig");
const tokens = @import("tokens.zig");
const tools = @import("tools.zig");

pub const Deps = tools.Deps;

/// `SUPPORTED_PROTOCOL_VERSIONS` of the SDK (types.js:4); the first is the latest.
const supported_versions = [_][]const u8{ "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07" };
/// `MAX_BATCH_SIZE`.
const max_batch = 100;
/// std.json builds a `Value` recursively, so a megabyte of `[` would overflow the stack of a pool
/// thread. No message of ours nests deeper than a tool schema (about ten levels).
const max_json_depth = 128;
/// The longest stdin line `mcp-stdio` forwards: the HTTP body cap and a newline.
const max_line_bytes = 1024 * 1024 + 1;

pub const Reply = struct {
    status: u16,
    /// application/json; empty for 202.
    body: []const u8 = "",
};

pub const Env = struct {
    arena: std.mem.Allocator,
    app: *@import("../app.zig").App,
    deps: *const Deps,
    identity: tokens.Identity,
};

// ---- JSON-RPC shapes ----

const Id = union(enum) {
    int: i64,
    string: []const u8,

    fn write(id: Id, jw: *std.json.Stringify) !void {
        switch (id) {
            .int => |n| try jw.write(n),
            .string => |s| try jw.write(s),
        }
    }
};

const Request = struct { id: Id, method: []const u8, params: ?std.json.Value };

const Message = union(enum) {
    request: Request,
    /// A notification or a response: accepted and ignored.
    other,
};

fn hasOnly(object: std.json.ObjectMap, comptime allowed: []const []const u8) bool {
    var it = object.iterator();
    next: while (it.next()) |entry| {
        inline for (allowed) |key| if (std.mem.eql(u8, entry.key_ptr.*, key)) continue :next;
        return false;
    }
    return true;
}

/// `z.union([string, number().int()])`, the number a safe JS integer: `Number.isSafeInteger`.
fn idOf(value: ?std.json.Value) ?Id {
    const v = value orelse return null;
    const limit = 9007199254740991;
    switch (v) {
        .string => |s| return .{ .string = s },
        .integer => |n| return if (n >= -limit and n <= limit) .{ .int = n } else null,
        .float => |f| return if (@floor(f) == f and @abs(f) <= limit) .{ .int = @intFromFloat(f) } else null,
        else => return null,
    }
}

fn isObject(value: ?std.json.Value) bool {
    return if (value) |v| v == .object else false;
}

/// `JSONRPCMessageSchema`: four strict objects. Null is the "Invalid JSON-RPC message" case.
fn classify(value: std.json.Value) ?Message {
    if (value != .object) return null;
    const object = value.object;
    const version = object.get("jsonrpc") orelse return null;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return null;
    if (object.get("method")) |method| {
        if (method != .string) return null;
        const params = object.get("params");
        if (params != null and !isObject(params)) return null;
        if (object.contains("id")) {
            if (!hasOnly(object, &.{ "jsonrpc", "id", "method", "params" })) return null;
            const id = idOf(object.get("id")) orelse return null;
            return .{ .request = .{ .id = id, .method = method.string, .params = params } };
        }
        return if (hasOnly(object, &.{ "jsonrpc", "method", "params" })) .other else null;
    }
    if (!hasOnly(object, &.{ "jsonrpc", "id", "result", "error" })) return null;
    if (idOf(object.get("id")) == null) return null;
    if (object.get("result")) |result| return if (result == .object and !object.contains("error")) .other else null;
    const err = object.get("error") orelse return null;
    if (err != .object or !hasOnly(err.object, &.{ "code", "message", "data" })) return null;
    const code = idOf(err.object.get("code")) orelse return null;
    if (code != .int) return null;
    const message = err.object.get("message") orelse return null;
    return if (message == .string) .other else null;
}

// ---- zod issues, as the SDK prints them ----

const Issue = struct { expected: []const u8, path: []const []const u8, received: []const u8 };

const Issues = struct {
    arena: std.mem.Allocator,
    list: std.ArrayList(Issue) = .empty,

    fn add(self: *Issues, expected: []const u8, path: []const []const u8, got: ?std.json.Value) !void {
        try self.list.append(self.arena, .{ .expected = expected, .path = path, .received = tools.jsKind(got) });
    }

    /// `expected` for a field: null when `got` is right, else one issue.
    fn field(self: *Issues, comptime expected: []const u8, path: []const []const u8, got: ?std.json.Value) !void {
        const ok = if (got) |v| switch (v) {
            .string => std.mem.eql(u8, expected, "string"),
            .object => std.mem.eql(u8, expected, "object") or std.mem.eql(u8, expected, "record"),
            else => false,
        } else false;
        if (!ok) try self.add(expected, path, got);
    }

    /// `JSON.stringify(error.issues, null, 2)`, the message of a ZodError.
    fn message(self: *Issues) ![]const u8 {
        var out: std.Io.Writer.Allocating = .init(self.arena);
        var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
        try jw.beginArray();
        for (self.list.items) |issue| {
            try jw.beginObject();
            try jw.objectField("expected");
            try jw.write(issue.expected);
            try jw.objectField("code");
            try jw.write("invalid_type");
            try jw.objectField("path");
            try jw.write(issue.path);
            try jw.objectField("message");
            try jw.write(try std.fmt.allocPrint(self.arena, "Invalid input: expected {s}, received {s}", .{ issue.expected, issue.received }));
            try jw.endObject();
        }
        try jw.endArray();
        return out.written();
    }
};

fn member(params: ?std.json.Value, key: []const u8) ?std.json.Value {
    const p = params orelse return null;
    return if (p == .object) p.object.get(key) else null;
}

/// `InitializeRequestSchema`: protocolVersion and clientInfo.name and version are strings,
/// capabilities and clientInfo objects. The inner shape of the capabilities is not checked.
fn initializeIssues(issues: *Issues, params: ?std.json.Value) !void {
    if (!isObject(params)) return issues.field("object", &.{"params"}, params);
    try issues.field("string", &.{ "params", "protocolVersion" }, member(params, "protocolVersion"));
    try issues.field("object", &.{ "params", "capabilities" }, member(params, "capabilities"));
    const info = member(params, "clientInfo");
    try issues.field("object", &.{ "params", "clientInfo" }, info);
    if (isObject(info)) {
        try issues.field("string", &.{ "params", "clientInfo", "name" }, member(info, "name"));
        try issues.field("string", &.{ "params", "clientInfo", "version" }, member(info, "version"));
    }
}

fn isInitialize(arena: std.mem.Allocator, request: Request) !bool {
    if (!std.mem.eql(u8, request.method, "initialize")) return false;
    var issues: Issues = .{ .arena = arena };
    try initializeIssues(&issues, request.params);
    return issues.list.items.len == 0;
}

// ---- one request ----

fn rpcError(jw: *std.json.Stringify, id: Id, code: i64, message: []const u8) !void {
    try jw.beginObject();
    try jw.objectField("jsonrpc");
    try jw.write("2.0");
    try jw.objectField("id");
    try id.write(jw);
    try jw.objectField("error");
    try jw.beginObject();
    try jw.objectField("code");
    try jw.write(code);
    try jw.objectField("message");
    try jw.write(message);
    try jw.endObject();
    try jw.endObject();
}

fn beginResult(jw: *std.json.Stringify) !void {
    try jw.beginObject();
    try jw.objectField("result");
}

fn endResult(jw: *std.json.Stringify, id: Id) !void {
    try jw.objectField("jsonrpc");
    try jw.write("2.0");
    try jw.objectField("id");
    try id.write(jw);
    try jw.endObject();
}

fn toolResult(jw: *std.json.Stringify, result: tools.Result) !void {
    try jw.beginObject();
    try jw.objectField("content");
    try jw.beginArray();
    try jw.beginObject();
    try jw.objectField("type");
    try jw.write("text");
    try jw.objectField("text");
    try jw.write(result.text);
    try jw.endObject();
    try jw.endArray();
    if (result.is_error) {
        try jw.objectField("isError");
        try jw.write(true);
    }
    try jw.endObject();
}

fn runTool(env: Env, name: []const u8, args: ?std.json.Value) tools.Result {
    const tool = tools.find(name) orelse return .{
        .is_error = true,
        .text = std.fmt.allocPrint(env.arena, "MCP error -32602: Tool {s} not found", .{name}) catch "MCP error -32602: Tool not found",
    };
    var ctx: tools.Ctx = .{ .arena = env.arena, .app = env.app, .deps = env.deps, .identity = env.identity, .tool = tool, .args = args };
    return tool.handler(&ctx) catch |err| {
        // The SDK turns a throwing handler into an error result with the exception message. The
        // message of a Zig error names internals, so the client gets a fixed text.
        if (!@import("builtin").is_test) std.log.err("mcp tool {s} failed: {t}", .{ name, err });
        return .{ .is_error = true, .text = "internal error" };
    };
}

fn respond(env: Env, request: Request, jw: *std.json.Stringify) !void {
    const id = request.id;
    const method = request.method;
    if (std.mem.eql(u8, method, "initialize")) {
        var issues: Issues = .{ .arena = env.arena };
        try initializeIssues(&issues, request.params);
        if (issues.list.items.len > 0) return rpcError(jw, id, -32603, try issues.message());
        const asked = member(request.params, "protocolVersion").?.string;
        var version = supported_versions[0];
        for (supported_versions) |known| if (std.mem.eql(u8, known, asked)) {
            version = known;
        };
        try beginResult(jw);
        try jw.beginObject();
        try jw.objectField("protocolVersion");
        try jw.write(version);
        try jw.objectField("capabilities");
        try jw.beginObject();
        try jw.objectField("tools");
        try jw.beginObject();
        try jw.objectField("listChanged");
        try jw.write(true);
        try jw.endObject();
        try jw.endObject();
        try jw.objectField("serverInfo");
        try jw.beginObject();
        try jw.objectField("name");
        try jw.write("harness");
        try jw.objectField("version");
        try jw.write("1.0.0");
        try jw.endObject();
        try jw.endObject();
        return endResult(jw, id);
    }
    if (std.mem.eql(u8, method, "ping")) {
        try beginResult(jw);
        try jw.beginObject();
        try jw.endObject();
        return endResult(jw, id);
    }
    if (std.mem.eql(u8, method, "tools/list")) {
        const cursor = member(request.params, "cursor");
        if (cursor != null and cursor.? != .string) {
            var issues: Issues = .{ .arena = env.arena };
            try issues.add("string", &.{ "params", "cursor" }, cursor);
            return rpcError(jw, id, -32603, try issues.message());
        }
        try beginResult(jw);
        try tools.writeToolsList(env.arena, jw);
        return endResult(jw, id);
    }
    if (std.mem.eql(u8, method, "tools/call")) {
        var issues: Issues = .{ .arena = env.arena };
        if (!isObject(request.params)) {
            try issues.field("object", &.{"params"}, request.params);
        } else {
            try issues.field("string", &.{ "params", "name" }, member(request.params, "name"));
            if (member(request.params, "arguments")) |args| try issues.field("record", &.{ "params", "arguments" }, args);
        }
        if (issues.list.items.len > 0) return rpcError(jw, id, -32603, try issues.message());
        const name = member(request.params, "name").?.string;
        const result = runTool(env, name, member(request.params, "arguments"));
        try beginResult(jw);
        try toolResult(jw, result);
        return endResult(jw, id);
    }
    return rpcError(jw, id, -32601, "Method not found");
}

// ---- the POST body ----

fn jsonError(arena: std.mem.Allocator, status: u16, code: i64, message: []const u8) !Reply {
    var out: std.Io.Writer.Allocating = .init(arena);
    var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    // Key order of the SDK's createJsonErrorResponse: jsonrpc, error, id.
    try jw.beginObject();
    try jw.objectField("jsonrpc");
    try jw.write("2.0");
    try jw.objectField("error");
    try jw.beginObject();
    try jw.objectField("code");
    try jw.write(code);
    try jw.objectField("message");
    try jw.write(message);
    try jw.endObject();
    try jw.objectField("id");
    try jw.write(null);
    try jw.endObject();
    return .{ .status = status, .body = out.written() };
}

/// The nesting of `[` and `{` outside strings, counted without recursion.
fn nestingDepth(body: []const u8) usize {
    var depth: usize = 0;
    var deepest: usize = 0;
    var in_string = false;
    var i: usize = 0;
    while (i < body.len) : (i += 1) {
        const ch = body[i];
        if (in_string) {
            if (ch == '\\') i += 1 else if (ch == '"') in_string = false;
            continue;
        }
        switch (ch) {
            '"' => in_string = true,
            '[', '{' => {
                depth += 1;
                deepest = @max(deepest, depth);
            },
            ']', '}' => depth -|= 1,
            else => {},
        }
    }
    return deepest;
}

/// `isJsonContentType`: the media type before any parameter, compared case-insensitively.
fn isJsonContentType(header: ?[]const u8) bool {
    const value = header orelse return false;
    const end = std.mem.findScalar(u8, value, ';') orelse value.len;
    const essence = std.mem.trim(u8, value[0..end], " \t");
    return std.ascii.eqlIgnoreCase(essence, "application/json") and std.mem.findScalar(u8, value[end..], ',') == null;
}

/// One media range of an Accept list, parameters ignored. The SDK only searches the header for the
/// text, so `application/json-patch+json` would pass there; every real client sends the exact
/// types, and matching them exactly is the stricter reading.
fn acceptsMedia(accept: []const u8, comptime media: []const u8) bool {
    var ranges = std.mem.splitScalar(u8, accept, ',');
    while (ranges.next()) |range| {
        const end = std.mem.findScalar(u8, range, ';') orelse range.len;
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, range[0..end], " \t"), media)) return true;
    }
    return false;
}

pub const Headers = struct {
    accept: ?[]const u8,
    content_type: ?[]const u8,
    protocol_version: ?[]const u8,
};

/// The POST path of the transport and the McpServer behind it, in the order the SDK checks.
pub fn post(env: Env, headers: Headers, body: []const u8) !Reply {
    const arena = env.arena;
    const accept = headers.accept orelse "";
    if (!acceptsMedia(accept, "application/json") or !acceptsMedia(accept, "text/event-stream")) {
        return jsonError(arena, 406, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    }
    if (!isJsonContentType(headers.content_type)) {
        return jsonError(arena, 415, -32000, "Unsupported Media Type: Content-Type must be application/json");
    }
    if (nestingDepth(body) > max_json_depth) return jsonError(arena, 400, -32700, "Parse error: Invalid JSON");
    const raw = std.json.parseFromSliceLeaky(std.json.Value, arena, body, .{ .duplicate_field_behavior = .use_last }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return jsonError(arena, 400, -32700, "Parse error: Invalid JSON"),
    };
    const is_batch = raw == .array;
    const items: []const std.json.Value = if (is_batch) raw.array.items else try arena.dupe(std.json.Value, &.{raw});
    if (is_batch and items.len > max_batch) {
        return jsonError(arena, 400, -32600, "Invalid Request: Batch must not exceed 100 messages");
    }
    const requests = try arena.alloc(Request, items.len);
    var request_count: usize = 0;
    var initializes: usize = 0;
    for (items) |item| {
        const message = classify(item) orelse return jsonError(arena, 400, -32700, "Parse error: Invalid JSON-RPC message");
        switch (message) {
            .request => |request| {
                if (try isInitialize(arena, request)) initializes += 1;
                requests[request_count] = request;
                request_count += 1;
            },
            .other => {},
        }
    }
    if (initializes > 0 and items.len > 1) {
        return jsonError(arena, 400, -32600, "Invalid Request: Only one initialization request is allowed");
    }
    if (initializes == 0) if (headers.protocol_version) |asked| {
        var known = false;
        for (supported_versions) |version| known = known or std.mem.eql(u8, version, asked);
        if (!known) {
            const message = try std.fmt.allocPrint(arena, "Bad Request: Unsupported protocol version: {s} (supported versions: {s})", .{
                asked,
                try std.mem.join(arena, ", ", &supported_versions),
            });
            return jsonError(arena, 400, -32000, message);
        }
    };
    if (request_count == 0) return .{ .status = 202 };

    var out: std.Io.Writer.Allocating = .init(arena);
    var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    if (request_count > 1) try jw.beginArray();
    for (requests[0..request_count]) |request| try respond(env, request, &jw);
    if (request_count > 1) try jw.endArray();
    return .{ .status = 200, .body = out.written() };
}

// ---- the HTTP route ----

/// `^Bearer (\S+)$`.
fn bearer(header: ?[]const u8) ?[]const u8 {
    const value = header orelse return null;
    const prefix = "Bearer ";
    if (!std.mem.startsWith(u8, value, prefix)) return null;
    const token = value[prefix.len..];
    if (token.len == 0) return null;
    for (token) |ch| if (std.ascii.isWhitespace(ch)) return null;
    return token;
}

fn plain(res: *httpz.Response, status: u16, text: []const u8) void {
    res.status = status;
    res.header("content-type", "text/plain;charset=utf-8");
    res.body = text;
}

fn hostAllowed(host: ?[]const u8, port: u16) bool {
    var buf: [32]u8 = undefined;
    const value = host orelse return false;
    inline for (.{ "127.0.0.1", "localhost" }) |name| {
        const allowed = std.fmt.bufPrint(&buf, name ++ ":{d}", .{port}) catch return false;
        if (std.mem.eql(u8, value, allowed)) return true;
    }
    return false;
}

/// `app.all("/mcp", ...)`: Host allowlist, POST only, Bearer run token, then the transport.
pub fn handle(call: *routes.Call) anyerror!void {
    const req = call.req;
    const res = call.res;
    if (!hostAllowed(req.header("host"), call.port)) return plain(res, 403, "forbidden host");
    if (req.method != .POST) {
        res.header("allow", "POST");
        return plain(res, 405, "method not allowed");
    }
    const unauthorized = struct {
        fn send(r: *httpz.Response) void {
            r.header("www-authenticate", "Bearer");
            plain(r, 401, "unauthorized");
        }
    }.send;
    const token = bearer(req.header("authorization")) orelse return unauthorized(res);
    const identity = (try tokens.verify(call.services.app, res.arena, token)) orelse return unauthorized(res);
    const reply = try post(
        .{ .arena = res.arena, .app = call.services.app, .deps = &call.services.mcp, .identity = identity },
        .{ .accept = req.header("accept"), .content_type = req.header("content-type"), .protocol_version = req.header("mcp-protocol-version") },
        req.body() orelse "",
    );
    res.status = reply.status;
    if (reply.body.len > 0) {
        res.header("content-type", "application/json");
        res.body = reply.body;
    }
}

// ---- `harness mcp-stdio` ----

/// The proxy behind `harness mcp-stdio`: newline-delimited JSON-RPC on stdin is POSTed to a running
/// server's `/mcp` with the token from HARNESS_MCP_TOKEN, and each reply goes to stdout. It does
/// not open the database, which the server holds under the home lock. The variable is not
/// HARNESS_RUN_TOKEN because `main` refuses to run at all when that one is set. Only a loopback
/// URL is a target, so the token cannot be sent elsewhere by a stray variable.
pub fn runStdio(init: std.process.Init) u8 {
    const gpa = init.gpa;
    const token = init.environ_map.get("HARNESS_MCP_TOKEN") orelse {
        std.debug.print("harness mcp-stdio: HARNESS_MCP_TOKEN is not set\n", .{});
        return 2;
    };
    if (std.mem.findAny(u8, token, " \t\r\n") != null or token.len == 0) {
        std.debug.print("harness mcp-stdio: HARNESS_MCP_TOKEN is not a token\n", .{});
        return 2;
    }
    var url_buf: [64]u8 = undefined;
    const url = init.environ_map.get("HARNESS_MCP_URL") orelse std.fmt.bufPrint(&url_buf, "http://127.0.0.1:{s}/mcp", .{
        init.environ_map.get("HARNESS_PORT") orelse std.fmt.comptimePrint("{d}", .{config.default_port}),
    }) catch return 2;
    if (hook_http.parseUrl(url) == null) {
        std.debug.print("harness mcp-stdio: only a loopback http URL is allowed\n", .{});
        return 2;
    }
    // One line is one message, so the buffer is the HTTP endpoint's body cap plus the newline.
    const in_buffer = gpa.alloc(u8, max_line_bytes) catch return 1;
    defer gpa.free(in_buffer);
    var out_buffer: [4096]u8 = undefined;
    var stdin = std.Io.File.stdin().reader(init.io, in_buffer);
    var stdout = std.Io.File.stdout().writer(init.io, &out_buffer);
    var client: std.http.Client = .{ .allocator = gpa, .io = init.io };
    defer client.deinit();
    proxyLines(gpa, &client, url, token, &stdin.interface, &stdout.interface) catch |err| {
        std.debug.print("harness mcp-stdio: {t}\n", .{err});
        return 1;
    };
    return 0;
}

pub fn proxyLines(gpa: std.mem.Allocator, client: *std.http.Client, url: []const u8, token: []const u8, in: *std.Io.Reader, out: *std.Io.Writer) !void {
    const authorization = try std.fmt.allocPrint(gpa, "Bearer {s}", .{token});
    defer gpa.free(authorization);
    while (true) {
        const line = in.takeDelimiter('\n') catch |err| switch (err) {
            error.StreamTooLong => {
                // The id is not known, so the client gets the error with a null id and the line
                // is dropped up to its newline.
                _ = in.discardDelimiterInclusive('\n') catch |e| switch (e) {
                    error.EndOfStream => {},
                    else => return e,
                };
                try out.writeAll("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"request too long\"},\"id\":null}\n");
                try out.flush();
                continue;
            },
            else => |e| return e,
        } orelse return;
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0) continue;
        var arena: std.heap.ArenaAllocator = .init(gpa);
        defer arena.deinit();
        const answer = try forward(arena.allocator(), client, url, authorization, trimmed);
        if (answer.len == 0) continue;
        try out.writeAll(answer);
        try out.writeByte('\n');
        try out.flush();
    }
}

/// The text to print for one input line; empty for none (a notification, status 202).
fn forward(arena: std.mem.Allocator, client: *std.http.Client, url: []const u8, authorization: []const u8, line: []const u8) ![]const u8 {
    var response: std.Io.Writer.Allocating = .init(arena);
    const result = client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = line,
        .keep_alive = true,
        .redirect_behavior = .unhandled,
        .headers = .{ .content_type = .{ .override = "application/json" }, .authorization = .{ .override = authorization } },
        .extra_headers = &.{.{ .name = "accept", .value = "application/json, text/event-stream" }},
        .response_writer = &response.writer,
    }) catch |err| return failure(arena, line, "harness server unreachable: {t}", .{err});
    if (result.status == .accepted) return "";
    const text = std.mem.trim(u8, response.written(), "\r\n");
    if (text.len > 0 and (text[0] == '{' or text[0] == '[') and std.mem.find(u8, text, "\n") == null) return text;
    return failure(arena, line, "harness server answered {d}", .{@backingInt(result.status)});
}

/// A JSON-RPC error for the request `line`, or nothing when the line carries no usable id.
fn failure(arena: std.mem.Allocator, line: []const u8, comptime fmt: []const u8, args: anytype) ![]const u8 {
    if (nestingDepth(line) > max_json_depth) return "";
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{}) catch return "";
    const message = classify(parsed) orelse return "";
    const request = switch (message) {
        .request => |r| r,
        .other => return "",
    };
    var out: std.Io.Writer.Allocating = .init(arena);
    var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try rpcError(&jw, request.id, -32603, try std.fmt.allocPrint(arena, fmt, args));
    return out.written();
}

test {
    _ = @import("tokens.zig");
    _ = @import("tools.zig");
    _ = @import("server_test.zig");
}
