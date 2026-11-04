//! Response helpers shared by every handler: the secure headers, the `{ "error": ... }` shapes
//! (code/src/server/route-kit.ts, contract/errors.json) and the mapping from Zig errors to them.
const std = @import("std");
const httpz = @import("httpz");
const json = @import("../json.zig");
const errors = @import("../errors.zig");

/// What Hono's `secureHeaders()` sets with its defaults, in the order of its HEADERS_MAP
/// (hono/dist/middleware/secure-headers). Cross-Origin-Embedder-Policy is off by default there.
pub const secure_headers = [_][2][]const u8{
    .{ "Cross-Origin-Resource-Policy", "same-origin" },
    .{ "Cross-Origin-Opener-Policy", "same-origin" },
    .{ "Origin-Agent-Cluster", "?1" },
    .{ "Referrer-Policy", "no-referrer" },
    .{ "Strict-Transport-Security", "max-age=15552000; includeSubDomains" },
    .{ "X-Content-Type-Options", "nosniff" },
    .{ "X-DNS-Prefetch-Control", "off" },
    .{ "X-Download-Options", "noopen" },
    .{ "X-Frame-Options", "SAMEORIGIN" },
    .{ "X-Permitted-Cross-Domain-Policies", "none" },
    .{ "X-XSS-Protection", "0" },
};

pub fn applySecure(res: *httpz.Response) void {
    for (secure_headers) |header| res.header(header[0], header[1]);
}

/// `c.json(value)`. Hono answers plain `application/json`; httpz's own `res.json` appends a charset.
pub fn sendJson(res: *httpz.Response, value: anytype) !void {
    try res.json(value, .{});
    res.content_type = null;
    res.header("content-type", "application/json");
}

/// `c.json({ error: message }, status)`.
pub fn sendError(res: *httpz.Response, status: u16, message: []const u8) !void {
    res.status = status;
    try sendJson(res, .{ .@"error" = message });
}

/// `notFound` of route-kit.ts.
pub fn sendNotFoundJson(res: *httpz.Response) !void {
    try sendError(res, 404, "not_found");
}

/// Hono's own 404 for a path no route matched: `c.text("404 Not Found", 404)`.
pub fn sendHonoNotFound(res: *httpz.Response) void {
    res.status = 404;
    res.header("content-type", "text/plain; charset=UTF-8");
    res.body = "404 Not Found";
}

/// Errors a handler may return to get a specific answer; anything else is a 500 `internal`.
pub const HttpError = error{
    InvalidBody,
    InvalidQuery,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    TooManyRequests,
};

pub const Mapped = struct { status: u16, message: []const u8 };

/// `routeError` of route-kit.ts for the cases that exist before any handler is ported: a bad body
/// or query is 400 with its fixed message, the rest use the code of `errors.Kind`.
pub fn mapError(err: anyerror) Mapped {
    return switch (err) {
        error.InvalidBody => .{ .status = 400, .message = "invalid body" },
        error.InvalidQuery => .{ .status = 400, .message = "invalid query" },
        error.Unauthorized => .{ .status = errors.Kind.unauthorized.status(), .message = "unauthorized" },
        error.Forbidden => .{ .status = errors.Kind.forbidden.status(), .message = "forbidden" },
        error.NotFound => .{ .status = errors.Kind.not_found.status(), .message = "not_found" },
        error.Conflict => .{ .status = errors.Kind.conflict.status(), .message = "conflict" },
        error.TooManyRequests => .{ .status = errors.Kind.too_many_requests.status(), .message = "too many attempts" },
        else => .{ .status = errors.Kind.internal.status(), .message = "internal" },
    };
}

/// `parseBody` of route-kit.ts: the request body as JSON, last duplicate key wins and unknown keys
/// are ignored. This is not full `JSON.parse` parity. Two known divergences, both K0 contract
/// rulings (working-docs/zig-plan.md section 11): std.json rejects an unpaired surrogate escape
/// such as `"\ud800"` that JSON.parse accepts, and raw invalid UTF-8 is an error here where the
/// Fetch body decoder in TS replaces it with U+FFFD. Any failure is `error.InvalidBody`, which
/// `mapError` turns into 400 `invalid body`; a missing body counts as `null` in TS and fails too.
/// The result lives in the request arena.
pub fn parseBody(comptime T: type, req: *httpz.Request) error{InvalidBody}!T {
    const body = req.body() orelse return error.InvalidBody;
    return std.json.parseFromSliceLeaky(T, req.arena, body, json.parse_options) catch error.InvalidBody;
}

test "headers: secure headers are the Hono defaults" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    applySecure(web.res);
    try std.testing.expectEqualStrings("nosniff", web.res.headers.get("X-Content-Type-Options").?);
    try std.testing.expectEqualStrings("SAMEORIGIN", web.res.headers.get("X-Frame-Options").?);
    try std.testing.expectEqualStrings("max-age=15552000; includeSubDomains", web.res.headers.get("Strict-Transport-Security").?);
    try std.testing.expect(web.res.headers.get("Cross-Origin-Embedder-Policy") == null);
    try std.testing.expectEqual(secure_headers.len, web.res.headers.len);
}

test "headers: error responses carry the contract shape" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    try sendError(web.res, 403, "forbidden host");
    try web.expectStatus(403);
    try web.expectBody("{\"error\":\"forbidden host\"}");
}

test "headers: hono's plain 404" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    sendHonoNotFound(web.res);
    try web.expectStatus(404);
    try web.expectBody("404 Not Found");
}

test "headers: errors map to the status of their kind and the contract message" {
    const cases = [_]struct { anyerror, u16, []const u8 }{
        .{ error.InvalidBody, 400, "invalid body" },
        .{ error.InvalidQuery, 400, "invalid query" },
        .{ error.Unauthorized, 401, "unauthorized" },
        .{ error.Forbidden, 403, "forbidden" },
        .{ error.NotFound, 404, "not_found" },
        .{ error.Conflict, 409, "conflict" },
        .{ error.TooManyRequests, 429, "too many attempts" },
        .{ error.OutOfMemory, 500, "internal" },
        .{ error.Unexpected, 500, "internal" },
    };
    for (cases) |case| {
        const mapped = mapError(case[0]);
        try std.testing.expectEqual(case[1], mapped.status);
        try std.testing.expectEqualStrings(case[2], mapped.message);
    }
}

test "headers: parseBody keeps the last duplicate key and refuses broken input" {
    const Body = struct { id: u32, name: []const u8 };
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.body("{\"id\":1,\"name\":\"a\",\"id\":2,\"extra\":true}");
    const parsed = try parseBody(Body, web.req);
    try std.testing.expectEqual(@as(u32, 2), parsed.id);

    var broken = httpz.testing.init(.{});
    defer broken.deinit();
    broken.body("{\"id\":");
    try std.testing.expectError(error.InvalidBody, parseBody(Body, broken.req));

    var empty = httpz.testing.init(.{});
    defer empty.deinit();
    try std.testing.expectError(error.InvalidBody, parseBody(Body, empty.req));
}
