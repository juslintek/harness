//! Test support: a stub Ollaya, a real std.http.Server on 127.0.0.1:0 that answers connection n
//! with `replies[min(n, len - 1)]`. Same shape as the one in laya/client_test.zig, which keeps
//! its own copy private.
const std = @import("std");

const io = std.testing.io;
const gpa = std.testing.allocator;

pub const Reply = struct {
    status: u16 = 200,
    body: []const u8 = "",
    delay_ms: i64 = 0,
};

/// Answers connection n with `replies[min(n, len - 1)]`, one request per connection.
pub const Stub = struct {
    server: std.Io.net.Server,
    replies: []const Reply,
    hits: std.atomic.Value(u32) = .init(0),
    request: [8192]u8 = undefined,
    request_len: std.atomic.Value(usize) = .init(0),
    group: std.Io.Group = .init,

    pub fn start(replies: []const Reply) !*Stub {
        const stub = try gpa.create(Stub);
        errdefer gpa.destroy(stub);
        const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        stub.* = .{ .server = try any.listen(io, .{}), .replies = replies };
        try stub.group.concurrent(io, serve, .{stub});
        return stub;
    }

    pub fn stop(self: *Stub) void {
        self.group.cancel(io);
        self.server.deinit(io);
        gpa.destroy(self);
    }

    pub fn url(self: *const Stub, buf: []u8) []const u8 {
        return std.fmt.bufPrint(buf, "http://127.0.0.1:{d}", .{self.server.socket.address.getPort()}) catch unreachable;
    }

    pub fn sent(self: *const Stub) []const u8 {
        return self.request[0..self.request_len.load(.acquire)];
    }

    fn serve(self: *Stub) void {
        while (true) {
            var stream = self.server.accept(io) catch return;
            defer stream.close(io);
            // A swallowed cancelation would leave the next accept uncancellable.
            self.handle(&stream) catch |err| if (err == error.Canceled) return;
        }
    }

    fn handle(self: *Stub, stream: *std.Io.net.Stream) !void {
        var read_buffer: [4096]u8 = undefined;
        var write_buffer: [1024]u8 = undefined;
        var reader = stream.reader(io, &read_buffer);
        var writer = stream.writer(io, &write_buffer);
        var http_server = std.http.Server.init(&reader.interface, &writer.interface);
        var req = try http_server.receiveHead();
        var body_buffer: [1024]u8 = undefined;
        const body_reader = req.readerExpectNone(&body_buffer);
        var len: usize = 0;
        const head = req.head_buffer;
        @memcpy(self.request[0..head.len], head);
        len = head.len;
        while (body_reader.takeByte()) |b| {
            if (len < self.request.len) {
                self.request[len] = b;
                len += 1;
            }
        } else |_| {}
        const n = self.hits.fetchAdd(1, .monotonic);
        self.request_len.store(len, .release);
        const reply = self.replies[@min(n, self.replies.len - 1)];
        if (reply.delay_ms > 0) try io.sleep(.fromMilliseconds(reply.delay_ms), .awake);
        try req.respond(reply.body, .{
            .status = @fromBackingInt(@intCast(reply.status)),
            .keep_alive = false,
            .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }},
        });
    }
};
