//! Real-socket tests of the hub: an httpz server with the hub as its WebSocket handler, a stub
//! session layer in place of the auth slice, and raw TCP clients so the bytes on the wire are what
//! the assertions see.
const std = @import("std");
const httpz = @import("httpz");
const hub_mod = @import("hub.zig");
const topics = @import("topics.zig");
const ids = @import("../ids.zig");

const testing = std.testing;
const Hub = hub_mod.Hub;

const uuid_a = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const uuid_b = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
/// `"x" ** n` is gone in 0.17.
fn repeat(comptime byte: u8, comptime n: usize) *const [n]u8 {
    const filled: [n]u8 = @splat(byte);
    return &filled;
}

const far_future: i64 = std.math.maxInt(i64);
const revoked: i64 = -1;

const Account = struct {
    session: []const u8,
    user: []const u8,
    admin: bool,
    /// Epoch ms, or `revoked`.
    expires: std.atomic.Value(i64) = .init(far_future),
};

/// The auth and orgs slices as far as the hub sees them. Sessions come from the X-Stub-Session
/// header; only `u-member` and `u-admin` belong to the org `uuid_a`.
const Stub = struct {
    accounts: [3]Account = .{
        .{ .session = "s-admin", .user = "u-admin", .admin = true },
        .{ .session = "s-member", .user = "u-member", .admin = false },
        .{ .session = "s-nobody", .user = "u-nobody", .admin = false },
    },

    fn find(stub: *Stub, session: []const u8) ?*Account {
        for (&stub.accounts) |*account| if (std.mem.eql(u8, account.session, session)) return account;
        return null;
    }

    fn identify(ctx: *anyopaque, req: *httpz.Request, _: std.mem.Allocator) ?hub_mod.Identity {
        const stub: *Stub = @ptrCast(@alignCast(ctx));
        const account = stub.find(req.header("x-stub-session") orelse return null) orelse return null;
        return .{ .session_id = account.session, .user_id = account.user, .instance_admin = account.admin };
    }

    fn orgAccess(_: *anyopaque, user_id: []const u8, org_id: []const u8) bool {
        if (!std.mem.eql(u8, org_id, uuid_a)) return false;
        return std.mem.eql(u8, user_id, "u-member") or std.mem.eql(u8, user_id, "u-admin");
    }

    fn expiresAt(ctx: *anyopaque, session_id: []const u8) ?i64 {
        const stub: *Stub = @ptrCast(@alignCast(ctx));
        const account = stub.find(session_id) orelse return null;
        const expires = account.expires.load(.acquire);
        return if (expires == revoked) null else expires;
    }

    fn access(stub: *Stub) hub_mod.Access {
        return .{ .ctx = stub, .identify = identify, .org_access = orgAccess, .session_expires_at = expiresAt };
    }
};

const App = struct {
    hub: *Hub,

    pub const WebsocketHandler = hub_mod.Client;

    fn ws(app: *App, req: *httpz.Request, res: *httpz.Response) !void {
        try app.hub.handleUpgrade(req, res);
    }
};

fn freePort(io: std.Io) !u16 {
    const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
    var listener = try any.listen(io, .{});
    defer listener.deinit(io);
    return listener.socket.address.getPort();
}

const Fixture = struct {
    stub: Stub = .{},
    hub: Hub,
    app: App,
    server: httpz.Server(*App),
    thread: std.Thread,
    port: u16,

    fn start(config: hub_mod.Config) !*Fixture {
        const gpa = testing.allocator;
        const fixture = try gpa.create(Fixture);
        errdefer gpa.destroy(fixture);
        fixture.stub = .{};
        fixture.hub = Hub.init(gpa, testing.io, fixture.stub.access(), config);
        errdefer fixture.hub.deinit();
        fixture.app = .{ .hub = &fixture.hub };
        fixture.port = try freePort(testing.io);
        fixture.server = try httpz.Server(*App).init(testing.io, gpa, .{
            .address = .localhost(fixture.port),
            .thread_pool = .{ .count = 4 },
            .websocket = hub_mod.websocket_config,
        }, &fixture.app);
        errdefer fixture.server.deinit();
        var router = try fixture.server.router(.{});
        router.get("/ws", App.ws, .{});
        fixture.thread = try fixture.server.listenInNewThread();
        try fixture.hub.start();
        return fixture;
    }

    fn stop(fixture: *Fixture) void {
        fixture.hub.stop();
        fixture.server.stop();
        fixture.thread.join();
        fixture.server.deinit();
        fixture.hub.deinit();
        testing.allocator.destroy(fixture);
    }

    /// Polls until the registry holds `count` connections; a socket's cleanup runs on the reader
    /// thread a moment after the peer closes.
    fn waitForConnections(fixture: *Fixture, count: usize) !void {
        for (0..400) |_| {
            if (fixture.hub.registry.stats().connections == count) return;
            try testing.io.sleep(.fromMilliseconds(10), .awake);
        }
        return error.ConnectionCountNotReached;
    }
};

const Frame = struct {
    opcode: u8,
    len: usize,
    payload: [2048]u8,

    fn text(frame: *const Frame) []const u8 {
        return frame.payload[0..frame.len];
    }
};

const Reply = struct { status: u16, body: []const u8 };

/// A raw WebSocket client over a blocking socket; every read has a deadline.
const Peer = struct {
    fd: std.posix.fd_t,
    head: [1024]u8 = undefined,
    body: [256]u8 = undefined,

    /// Plain socket calls: `std.Io.net` treats the EISCONN that follows an interrupted connect as
    /// a bug and aborts, which a test that opens many sockets while other threads run can hit.
    fn connect(port: u16) !Peer {
        const fd = std.c.socket(std.c.AF.INET, std.c.SOCK.STREAM, 0);
        if (fd < 0) return error.SocketFailed;
        errdefer _ = std.c.close(fd);
        var address: std.c.sockaddr.in = std.mem.zeroes(std.c.sockaddr.in);
        address.family = std.c.AF.INET;
        address.port = std.mem.nativeToBig(u16, port);
        address.addr = std.mem.nativeToBig(u32, 0x7f000001);
        const rc = std.c.connect(fd, @ptrCast(&address), @sizeOf(std.c.sockaddr.in));
        if (rc != 0) {
            // An interrupted connect carries on in the kernel; wait until the socket is writable.
            if (std.posix.errno(rc) != .INTR) return error.ConnectFailed;
            var fds = [1]std.c.pollfd{.{ .fd = fd, .events = std.c.POLL.OUT, .revents = 0 }};
            if (std.c.poll(&fds, 1, 2000) != 1) return error.ConnectFailed;
        }
        return .{ .fd = fd };
    }

    fn close(peer: *Peer) void {
        _ = std.c.close(peer.fd);
    }

    fn writeAll(peer: *const Peer, bytes: []const u8) !void {
        var done: usize = 0;
        while (done < bytes.len) {
            const rc = std.c.write(peer.fd, bytes.ptr + done, bytes.len - done);
            if (rc <= 0) return error.WriteFailed;
            done += @intCast(rc);
        }
    }

    fn readExact(peer: *const Peer, out: []u8, timeout_ms: i32) !void {
        var done: usize = 0;
        while (done < out.len) {
            var fds = [1]std.c.pollfd{.{ .fd = peer.fd, .events = std.c.POLL.IN, .revents = 0 }};
            const ready = std.c.poll(&fds, 1, timeout_ms);
            if (ready == 0) return error.Timeout;
            if (ready < 0) {
                if (std.posix.errno(ready) == .INTR) continue;
                return error.PollFailed;
            }
            const rc = std.c.read(peer.fd, out.ptr + done, out.len - done);
            if (rc == 0) return error.EndOfStream;
            if (rc < 0) {
                if (std.posix.errno(rc) == .INTR) continue;
                return error.ReadFailed;
            }
            done += @intCast(rc);
        }
    }

    /// GET /ws with the upgrade headers. A 101 leaves the socket ready for frames.
    fn handshake(peer: *Peer, query: []const u8, session: ?[]const u8, upgrade: bool) !Reply {
        var request: [512]u8 = undefined;
        var w: std.Io.Writer = .fixed(&request);
        try w.print("GET /ws{s} HTTP/1.1\r\nHost: localhost\r\n", .{query});
        if (upgrade) try w.writeAll("Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n");
        if (session) |s| try w.print("X-Stub-Session: {s}\r\n", .{s});
        try w.writeAll("\r\n");
        try peer.writeAll(w.buffered());

        var len: usize = 0;
        while (!std.mem.endsWith(u8, peer.head[0..len], "\r\n\r\n")) {
            try peer.readExact(peer.head[len..][0..1], 2000);
            len += 1;
        }
        const head = peer.head[0..len];
        const status = try std.fmt.parseInt(u16, head[9..12], 10);
        var body_len: usize = 0;
        if (std.ascii.findIgnoreCase(head, "content-length: ")) |at| {
            const rest = head[at + "content-length: ".len ..];
            const end = std.mem.findScalar(u8, rest, '\r').?;
            body_len = try std.fmt.parseInt(usize, rest[0..end], 10);
        }
        try peer.readExact(peer.body[0..body_len], 2000);
        return .{ .status = status, .body = peer.body[0..body_len] };
    }

    fn subscribe(peer: *Peer, query: []const u8, session: []const u8) !void {
        const reply = try peer.handshake(query, session, true);
        try testing.expectEqual(@as(u16, 101), reply.status);
    }

    fn readFrame(peer: *const Peer, timeout_ms: i32) !Frame {
        var frame: Frame = undefined;
        var head: [2]u8 = undefined;
        try peer.readExact(&head, timeout_ms);
        frame.opcode = head[0] & 0x0f;
        if (head[0] & 0x80 == 0 or head[1] & 0x80 != 0) return error.UnexpectedFrameShape;
        frame.len = head[1] & 0x7f;
        if (frame.len == 126) {
            var ext: [2]u8 = undefined;
            try peer.readExact(&ext, timeout_ms);
            frame.len = std.mem.readInt(u16, &ext, .big);
        }
        if (frame.len > frame.payload.len) return error.FrameTooLarge;
        try peer.readExact(frame.payload[0..frame.len], timeout_ms);
        return frame;
    }

    /// The next text frame, skipping pings.
    fn readText(peer: *const Peer, timeout_ms: i32) !Frame {
        while (true) {
            const frame = try peer.readFrame(timeout_ms);
            if (frame.opcode == topics.opcode_ping) continue;
            try testing.expectEqual(topics.opcode_text, frame.opcode);
            return frame;
        }
    }

    fn sendFrame(peer: *const Peer, opcode: u8, payload: []const u8) !void {
        var out: [1100]u8 = undefined;
        const mask = [4]u8{ 0x11, 0x22, 0x33, 0x44 };
        var at: usize = 0;
        out[at] = 0x80 | opcode;
        at += 1;
        if (payload.len < 126) {
            out[at] = 0x80 | @as(u8, @intCast(payload.len));
            at += 1;
        } else {
            out[at] = 0x80 | 126;
            std.mem.writeInt(u16, out[at + 1 ..][0..2], @intCast(payload.len), .big);
            at += 3;
        }
        @memcpy(out[at..][0..4], &mask);
        at += 4;
        for (payload, 0..) |byte, i| out[at + i] = byte ^ mask[i % 4];
        try peer.writeAll(out[0 .. at + payload.len]);
    }

    /// True once the server has closed the connection: a close frame and EOF, or EOF alone.
    fn waitForEof(peer: *const Peer) !bool {
        var scratch: [64]u8 = undefined;
        for (0..200) |_| {
            peer.readExact(scratch[0..1], 50) catch |err| switch (err) {
                error.EndOfStream => return true,
                error.Timeout => continue,
                else => return err,
            };
        }
        return false;
    }
};

fn expectError(reply: Reply, status: u16, message: []const u8) !void {
    try testing.expectEqual(status, reply.status);
    var expected: [64]u8 = undefined;
    const body = try std.fmt.bufPrint(&expected, "{{\"error\":\"{s}\"}}", .{message});
    try testing.expectEqualStrings(body, reply.body);
}

test "realtime: a nudge reaches the subscribed topic and nobody else" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();
    var runs = try Peer.connect(fixture.port);
    defer runs.close();
    var run_a = try Peer.connect(fixture.port);
    defer run_a.close();
    try runs.subscribe("?topic=runs", "s-admin");
    try run_a.subscribe("?topic=run:" ++ uuid_a, "s-admin");
    try fixture.waitForConnections(2);

    const delivered = try fixture.hub.registry.publish("run:" ++ uuid_a, .{ .event = .{ .run_id = uuid_a, .kind = "text", .ts = 42 } });
    try testing.expectEqual(@as(usize, 1), delivered);
    const frame = try run_a.readText(2000);
    try testing.expectEqualStrings(
        "{\"type\":\"event\",\"runId\":\"" ++ uuid_a ++ "\",\"event\":{\"kind\":\"text\",\"ts\":42}}",
        frame.text(),
    );

    // The other subscriber's next frame is the one published after, not the earlier nudge.
    _ = try fixture.hub.registry.publish("runs", .dashboard);
    try testing.expectEqualStrings("{\"type\":\"dashboard\"}", (try runs.readText(2000)).text());
}

test "realtime: the upgrade is refused with the TS status and body" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();
    const cases = [_]struct { query: []const u8, session: ?[]const u8, upgrade: bool, status: u16, message: []const u8 }{
        .{ .query = "", .session = "s-admin", .upgrade = true, .status = 400, .message = "invalid topic" },
        .{ .query = "?topic=", .session = "s-admin", .upgrade = true, .status = 400, .message = "invalid topic" },
        .{ .query = "?topic=jobs", .session = "s-admin", .upgrade = true, .status = 400, .message = "invalid topic" },
        .{ .query = "?topic=run:nope", .session = "s-admin", .upgrade = true, .status = 400, .message = "invalid topic" },
        .{ .query = "?topic=runs", .session = null, .upgrade = true, .status = 401, .message = "unauthorized" },
        .{ .query = "?topic=runs", .session = "s-member", .upgrade = true, .status = 403, .message = "forbidden" },
        .{ .query = "?topic=approvals", .session = "s-member", .upgrade = true, .status = 403, .message = "forbidden" },
        .{ .query = "?topic=run:" ++ uuid_a, .session = "s-member", .upgrade = true, .status = 403, .message = "forbidden" },
        .{ .query = "?topic=org:" ++ uuid_a, .session = "s-nobody", .upgrade = true, .status = 403, .message = "forbidden" },
        .{ .query = "?topic=org:" ++ uuid_b, .session = "s-admin", .upgrade = true, .status = 403, .message = "forbidden" },
        .{ .query = "?topic=runs", .session = "s-admin", .upgrade = false, .status = 426, .message = "upgrade failed" },
    };
    for (cases) |case| {
        var peer = try Peer.connect(fixture.port);
        defer peer.close();
        const reply = try peer.handshake(case.query, case.session, case.upgrade);
        try expectError(reply, case.status, case.message);
    }

    // The percent-encoded form of a valid topic is the same topic, as in Hono.
    var encoded = try Peer.connect(fixture.port);
    defer encoded.close();
    try encoded.subscribe("?topic=org%3A" ++ uuid_a, "s-member");

    fixture.stub.accounts[0].expires.store(revoked, .release);
    var lapsed = try Peer.connect(fixture.port);
    defer lapsed.close();
    try expectError(try lapsed.handshake("?topic=runs", "s-admin", true), 401, "session expired");
    try fixture.waitForConnections(1);
}

test "realtime: members reach their org topic whatever their role" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();
    var member = try Peer.connect(fixture.port);
    defer member.close();
    try member.subscribe("?topic=org:" ++ uuid_a, "s-member");
    try fixture.waitForConnections(1);
    _ = try fixture.hub.registry.publish("org:" ++ uuid_a, .{ .task = .{ .project_id = "p", .task_id = "t", .kind = "moved" } });
    try testing.expectEqualStrings(
        "{\"type\":\"task\",\"projectId\":\"p\",\"taskId\":\"t\",\"kind\":\"moved\"}",
        (try member.readText(2000)).text(),
    );
}

test "realtime: client frames are ignored and an oversized one ends the connection" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();
    var peer = try Peer.connect(fixture.port);
    defer peer.close();
    try peer.subscribe("?topic=runs", "s-admin");
    try fixture.waitForConnections(1);

    try peer.sendFrame(topics.opcode_text, "{\"type\":\"dashboard\"}");
    try peer.sendFrame(topics.opcode_text, repeat('x', hub_mod.max_payload_bytes));
    _ = try fixture.hub.registry.publish("runs", .dashboard);
    // Nothing was echoed or answered: the first frame back is the publish.
    try testing.expectEqualStrings("{\"type\":\"dashboard\"}", (try peer.readText(2000)).text());

    try peer.sendFrame(topics.opcode_text, repeat('x', hub_mod.max_payload_bytes + 1));
    try testing.expect(try peer.waitForEof());
    try fixture.waitForConnections(0);
}

test "realtime: revoking a session closes its socket with 4401" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();
    var revoked_peer = try Peer.connect(fixture.port);
    defer revoked_peer.close();
    var other = try Peer.connect(fixture.port);
    defer other.close();
    try revoked_peer.subscribe("?topic=runs", "s-admin");
    try other.subscribe("?topic=org:" ++ uuid_a, "s-member");
    try fixture.waitForConnections(2);

    try testing.expectEqual(@as(usize, 1), fixture.hub.registry.closeSession("s-admin"));
    const frame = try revoked_peer.readFrame(2000);
    try testing.expectEqual(topics.opcode_close, frame.opcode);
    try testing.expectEqual(@as(u16, 4401), std.mem.readInt(u16, frame.payload[0..2], .big));
    try testing.expectEqualStrings("access ended", frame.payload[2..frame.len]);
    try testing.expect(try revoked_peer.waitForEof());
    try fixture.waitForConnections(1);

    // The other session is untouched and a removed member loses only their org socket.
    try testing.expectEqual(@as(usize, 1), fixture.hub.registry.closeUserOnTopic("u-member", "org:" ++ uuid_a));
    const gone = try other.readFrame(2000);
    try testing.expectEqual(@as(u16, 4401), std.mem.readInt(u16, gone.payload[0..2], .big));
    try fixture.waitForConnections(0);
}

test "realtime: the sweep closes a lapsed session with 4401 and keeps one that slid forward" {
    const fixture = try Fixture.start(.{ .tick_ms = 10, .sweep_interval_ms = 30 });
    defer fixture.stop();
    const soon = ids.nowMs(testing.io) + 150;
    fixture.stub.accounts[0].expires.store(soon, .release);
    fixture.stub.accounts[1].expires.store(soon, .release);
    var lapsing = try Peer.connect(fixture.port);
    defer lapsing.close();
    var sliding = try Peer.connect(fixture.port);
    defer sliding.close();
    try lapsing.subscribe("?topic=runs", "s-admin");
    try sliding.subscribe("?topic=org:" ++ uuid_a, "s-member");
    try fixture.waitForConnections(2);

    // The database moved one session's expiry on and revoked the other.
    fixture.stub.accounts[1].expires.store(far_future, .release);
    fixture.stub.accounts[0].expires.store(revoked, .release);

    const frame = try lapsing.readFrame(3000);
    try testing.expectEqual(topics.opcode_close, frame.opcode);
    try testing.expectEqual(@as(u16, 4401), std.mem.readInt(u16, frame.payload[0..2], .big));
    try testing.expectEqualStrings("session expired", frame.payload[2..frame.len]);
    try fixture.waitForConnections(1);

    try testing.expectEqual(@as(usize, 1), try fixture.hub.registry.publish("org:" ++ uuid_a, .dashboard));
    try testing.expectEqualStrings("{\"type\":\"dashboard\"}", (try sliding.readText(2000)).text());
}

test "realtime: the server pings, answers pings, and closes a socket that goes silent" {
    const fixture = try Fixture.start(.{ .tick_ms = 10, .ping_interval_ms = 40, .idle_timeout_ms = 400 });
    defer fixture.stop();
    var silent = try Peer.connect(fixture.port);
    defer silent.close();
    var lively = try Peer.connect(fixture.port);
    defer lively.close();
    try silent.subscribe("?topic=runs", "s-admin");
    try lively.subscribe("?topic=approvals", "s-admin");
    try fixture.waitForConnections(2);

    const ping = try silent.readFrame(2000);
    try testing.expectEqual(topics.opcode_ping, ping.opcode);
    try testing.expectEqual(@as(usize, 0), ping.len);

    // The silent peer never answers: pings keep coming until the idle close. The lively one
    // answers each ping and a ping of its own is answered with the same payload.
    try lively.sendFrame(topics.opcode_ping, "hi");
    var pongs: usize = 0;
    var answered_ping = false;
    for (0..60) |_| {
        const frame = lively.readFrame(100) catch |err| switch (err) {
            error.Timeout => continue,
            else => return err,
        };
        switch (frame.opcode) {
            topics.opcode_ping => try lively.sendFrame(0xa, ""),
            0xa => {
                try testing.expectEqualStrings("hi", frame.text());
                answered_ping = true;
            },
            else => return error.UnexpectedOpcode,
        }
        pongs += 1;
        if (pongs >= 15) break;
    }
    try testing.expect(answered_ping);
    try testing.expect(pongs >= 15);

    var saw_close = false;
    while (true) {
        const frame = silent.readFrame(2000) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return err,
        };
        if (frame.opcode == topics.opcode_close) {
            saw_close = true;
            try testing.expectEqual(@as(u16, 1001), std.mem.readInt(u16, frame.payload[0..2], .big));
        }
    }
    try testing.expect(saw_close);
    try fixture.waitForConnections(1);

    // The lively peer outlived the silent one's whole idle window and still gets nudges.
    _ = try fixture.hub.registry.publish("approvals", .dashboard);
    try testing.expectEqualStrings("{\"type\":\"dashboard\"}", (try lively.readText(2000)).text());
}

test "realtime: a client that never reads cannot stall publishers or other clients" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();
    var stalled = try Peer.connect(fixture.port);
    defer stalled.close();
    try stalled.subscribe("?topic=runs", "s-admin");
    try fixture.waitForConnections(1);

    const body = "{\"type\":\"run\",\"run\":{\"pad\":\"" ++ repeat('p', 900) ++ "\"}}";
    var rounds: usize = 0;
    while (rounds < 20_000) : (rounds += 1) {
        _ = try fixture.hub.registry.publishText("runs", body);
        const stats = fixture.hub.registry.stats();
        if (stats.dropped > 0 or stats.failed > 0) break;
    }
    try testing.expect(rounds < 20_000);

    // The slow socket is either still there with dropped messages or already ended; a new
    // client gets its nudge at once either way.
    var healthy = try Peer.connect(fixture.port);
    defer healthy.close();
    try healthy.subscribe("?topic=approvals", "s-admin");
    for (0..400) |_| {
        if (fixture.hub.registry.publish("approvals", .dashboard) catch 0 > 0) break;
        try testing.io.sleep(.fromMilliseconds(5), .awake);
    }
    try testing.expectEqualStrings("{\"type\":\"dashboard\"}", (try healthy.readText(2000)).text());
}

test "realtime: sockets that disconnect while others publish leave nothing behind" {
    const fixture = try Fixture.start(.{ .tick_ms = 20 });
    defer fixture.stop();

    const Publisher = struct {
        fn run(hub: *Hub, stop: *std.atomic.Value(bool)) void {
            while (!stop.load(.acquire)) {
                _ = hub.registry.publish("runs", .dashboard) catch return;
                _ = hub.registry.publishText("runs", "{\"type\":\"dashboard\"}") catch return;
            }
        }
    };
    var stop: std.atomic.Value(bool) = .init(false);
    var threads: [3]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Publisher.run, .{ &fixture.hub, &stop });
    defer {
        stop.store(true, .release);
        for (threads) |thread| thread.join();
    }

    for (0..25) |round| {
        var peer = try Peer.connect(fixture.port);
        defer peer.close();
        try peer.subscribe("?topic=runs", "s-admin");
        if (round % 2 == 0) _ = try peer.readText(2000);
    }
    try fixture.waitForConnections(0);
}

fn noopSend(_: *anyopaque, _: []const u8) topics.SendResult {
    return .sent;
}

fn noopClose(_: *anyopaque, _: u16, _: []const u8) void {}

test "realtime: the session sweep survives every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn run(gpa: std.mem.Allocator) !void {
            var stub: Stub = .{};
            stub.accounts[0].expires.store(revoked, .release);
            var hub = Hub.init(gpa, testing.io, stub.access(), .{});
            defer hub.deinit();
            var token: u8 = 0;
            _ = try hub.registry.add(.{
                .topic = topics.Topic.parse("runs").?,
                .session_id = "s-admin",
                .user_id = "u-admin",
                .expires_at_ms = 0,
                .now_ms = 0,
                .sink = .{ .ctx = &token, .send = noopSend, .close = noopClose },
            });
            try hub.sweepSessions();
        }
    }.run, .{});
}
