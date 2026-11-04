//! TS: `app.post("/tasks", async (c) => c.json(...))`. A httpz route takes the handler struct, the
//! request and the response. Two tests: the handler called directly through httpz.testing, and the
//! same route behind a real listener on a free port, called with std.http.Client.
const std = @import("std");
const httpz = @import("httpz");

pub const Handler = struct {
    next_id: std.atomic.Value(u32) = .init(1),

    const CreateTask = struct { title: []const u8, tags: []const []const u8 = &.{} };

    /// httpz's own `req.json(T)` uses the default std.json options: a duplicate key is an error and
    /// an unknown key too. Parse `req.body()` yourself to get JSON.parse and zod behaviour.
    pub fn createTask(h: *Handler, req: *httpz.Request, res: *httpz.Response) !void {
        const body = req.body() orelse return fail(res, 400, "body required");
        const parsed = std.json.parseFromSliceLeaky(CreateTask, req.arena, body, .{
            .duplicate_field_behavior = .use_last,
            .ignore_unknown_fields = true,
        }) catch return fail(res, 400, "invalid json");
        if (parsed.title.len == 0) return fail(res, 400, "title required");
        res.status = 201;
        try res.json(.{ .id = h.next_id.fetchAdd(1, .monotonic), .title = parsed.title, .tags = parsed.tags.len }, .{});
    }

    pub fn getTask(_: *Handler, req: *httpz.Request, res: *httpz.Response) !void {
        const id = std.fmt.parseInt(u32, req.param("id").?, 10) catch return fail(res, 400, "bad id");
        try res.json(.{ .id = id }, .{});
    }

    fn fail(res: *httpz.Response, status: u16, message: []const u8) !void {
        res.status = status;
        try res.json(.{ .@"error" = message }, .{});
    }
};

pub fn register(server: *httpz.Server(*Handler)) !void {
    var router = try server.router(.{});
    router.post("/tasks", Handler.createTask, .{});
    router.get("/tasks/:id", Handler.getTask, .{});
}

/// Asks the OS for a free loopback port. There is a short window before the caller binds it again.
pub fn freePort(io: std.Io) !u16 {
    const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
    var listener = try any.listen(io, .{});
    defer listener.deinit(io);
    return listener.socket.address.getPort();
}

test "http_route: JSON in, JSON out, called without a socket" {
    var handler: Handler = .{};
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.body("{\"title\":\"a\",\"title\":\"b\",\"tags\":[\"x\",\"y\"],\"unknown\":1}");
    try handler.createTask(web.req, web.res);
    try web.expectStatus(201);
    try web.expectJson(.{ .id = 1, .title = "b", .tags = 2 });
}

test "http_route: bad input becomes a 400 JSON error" {
    var handler: Handler = .{};
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.body("{\"title\":");
    try handler.createTask(web.req, web.res);
    try web.expectStatus(400);
    try web.expectJson(.{ .@"error" = "invalid json" });
}

test "http_route: path parameters" {
    var handler: Handler = .{};
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.param("id", "42");
    try handler.getTask(web.req, web.res);
    try web.expectJson(.{ .id = 42 });
}

test "http_route: the same routes behind a real listener" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const port = try freePort(io);

    var handler: Handler = .{};
    var server = try httpz.Server(*Handler).init(io, gpa, .{
        .address = .localhost(port),
        .thread_pool = .{ .count = 2 },
    }, &handler);
    defer server.deinit();
    try register(&server);
    const thread = try server.listenInNewThread();
    defer {
        server.stop();
        thread.join();
    }

    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();
    var response: std.Io.Writer.Allocating = .init(gpa);
    defer response.deinit();
    const url = try std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}/tasks", .{port});
    defer gpa.free(url);

    const result = try client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = "{\"title\":\"over the wire\"}",
        .headers = .{ .content_type = .{ .override = "application/json" } },
        .response_writer = &response.writer,
    });
    try std.testing.expectEqual(std.http.Status.created, result.status);
    try std.testing.expectEqualStrings("{\"id\":1,\"title\":\"over the wire\",\"tags\":0}", response.written());
}
