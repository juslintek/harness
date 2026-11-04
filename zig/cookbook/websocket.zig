//! TS: Bun's `server.upgrade(req)` plus `ws.send(...)` from anywhere. httpz upgrades a normal route
//! with httpz.upgradeWebsocket; the Conn pointer is kept so a plain HTTP route (another worker
//! thread) can push to it. Concurrent `conn.write` and `conn.close` are allowed by websocket.zig.
//! The pointer itself is shared state, so it sits behind a mutex and `close` clears it.
const std = @import("std");
const httpz = @import("httpz");
const http_route = @import("http_route.zig");

const websocket = httpz.websocket;

pub const Hub = struct {
    pub const WebsocketHandler = Client;

    mutex: std.Io.Mutex = .init,
    live: ?*websocket.Conn = null,
    io: std.Io,

    /// Runs on whichever httpz worker thread handles the push route.
    fn push(hub: *Hub, text: []const u8) !bool {
        hub.mutex.lockUncancelable(hub.io);
        defer hub.mutex.unlock(hub.io);
        const conn = hub.live orelse return false;
        try conn.writeText(text);
        return true;
    }

    fn upgrade(hub: *Hub, req: *httpz.Request, res: *httpz.Response) !void {
        if (!try httpz.upgradeWebsocket(Client, req, res, hub)) {
            res.status = 400;
            res.body = "websocket upgrade required";
        }
    }

    fn pushRoute(hub: *Hub, req: *httpz.Request, res: *httpz.Response) !void {
        const text = req.body() orelse "";
        if (try hub.push(text)) {
            res.body = "sent";
        } else {
            res.status = 404;
            res.body = "no socket";
        }
    }
};

const Client = struct {
    conn: *websocket.Conn,
    hub: *Hub,

    /// Called during the upgrade; `ctx` is whatever was passed to upgradeWebsocket.
    pub fn init(conn: *websocket.Conn, hub: *Hub) !Client {
        hub.mutex.lockUncancelable(hub.io);
        defer hub.mutex.unlock(hub.io);
        hub.live = conn;
        return .{ .conn = conn, .hub = hub };
    }

    pub fn clientMessage(client: *Client, data: []const u8) !void {
        try client.conn.writeText(data);
    }

    pub fn close(client: *Client) void {
        client.hub.mutex.lockUncancelable(client.hub.io);
        defer client.hub.mutex.unlock(client.hub.io);
        client.hub.live = null;
    }
};

/// A minimal client frame writer: FIN + text opcode, masked as RFC 6455 requires of clients.
fn writeMaskedText(w: *std.Io.Writer, text: []const u8) !void {
    std.debug.assert(text.len < 126);
    const mask = [4]u8{ 0x11, 0x22, 0x33, 0x44 };
    try w.writeAll(&.{ 0x81, 0x80 | @as(u8, @intCast(text.len)) });
    try w.writeAll(&mask);
    for (text, 0..) |byte, i| try w.writeByte(byte ^ mask[i % 4]);
    try w.flush();
}

/// Server frames are unmasked. Returns the text payload of a short frame in `out`.
fn readTextFrame(r: *std.Io.Reader, out: []u8) ![]u8 {
    const header = try r.takeArray(2);
    try std.testing.expectEqual(@as(u8, 0x81), header[0]);
    const len: usize = header[1] & 0x7f;
    try r.readSliceAll(out[0..len]);
    return out[0..len];
}

test "websocket: upgrade, echo, and a push from another worker thread" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const port = try http_route.freePort(io);

    var hub: Hub = .{ .io = io };
    var server = try httpz.Server(*Hub).init(io, gpa, .{
        .address = .localhost(port),
        .thread_pool = .{ .count = 2 },
    }, &hub);
    defer server.deinit();
    var router = try server.router(.{});
    router.get("/ws", Hub.upgrade, .{});
    router.post("/push", Hub.pushRoute, .{});
    const thread = try server.listenInNewThread();
    defer {
        server.stop();
        thread.join();
    }

    const address: std.Io.net.IpAddress = .{ .ip4 = .loopback(port) };
    var stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var read_buffer: [512]u8 = undefined;
    var write_buffer: [512]u8 = undefined;
    var stream_reader = stream.reader(io, &read_buffer);
    var stream_writer = stream.writer(io, &write_buffer);
    const r = &stream_reader.interface;
    const w = &stream_writer.interface;

    try w.writeAll("GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" ++
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    try w.flush();
    const status_line = (try r.takeDelimiter('\n')).?;
    try std.testing.expect(std.mem.startsWith(u8, status_line, "HTTP/1.1 101"));
    var accepted = false;
    while (try r.takeDelimiter('\n')) |line| {
        if (std.mem.eql(u8, line, "\r")) break;
        if (std.ascii.startsWithIgnoreCase(line, "sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")) accepted = true;
    }
    try std.testing.expect(accepted);

    var frame: [64]u8 = undefined;
    try writeMaskedText(w, "ping from client");
    try std.testing.expectEqualStrings("ping from client", try readTextFrame(r, &frame));

    var http_client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer http_client.deinit();
    const url = try std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}/push", .{port});
    defer gpa.free(url);
    const result = try http_client.fetch(.{ .location = .{ .url = url }, .method = .POST, .payload = "pushed" });
    try std.testing.expectEqual(std.http.Status.ok, result.status);
    try std.testing.expectEqualStrings("pushed", try readTextFrame(r, &frame));
}

test "websocket: a push with no connection is a 404 and does not crash" {
    var hub: Hub = .{ .io = std.testing.io };
    try std.testing.expect(!try hub.push("nobody home"));
}
