//! WebSocket side of the realtime slice: the `/ws?topic=` upgrade of `wsUpgrade` and the `websocket`
//! handler of code/src/server/realtime.ts, on httpz and websocket.zig.
//!
//! Wiring contract (done by the wiring slice, not here):
//!   * the httpz handler type behind `httpz.Server(...)` declares `pub const WebsocketHandler =
//!     hub.Client;`, otherwise httpz closes every upgraded socket;
//!   * the server is created with `.websocket = hub.websocket_config`;
//!   * the `/ws` route handler calls `Hub.handleUpgrade`;
//!   * the hub outlives the httpz server (a closing socket calls back into the registry);
//!   * `Hub.start` runs once the hub sits at its final address.
//!
//! Socket facts this file relies on, all read in websocket.zig and httpz at the pinned commits:
//!   * the library sends no pings and has no idle timeout, so the ticker thread does both;
//!   * after the upgrade httpz keeps the socket non-blocking, and every write here also passes
//!     MSG_DONTWAIT, so no publisher can stall on a slow client;
//!   * `Conn.close` closes the descriptor without waking the reader, which would leak the
//!     handler, so the hub ends a connection with a close frame and `shutdown` instead: the
//!     reader sees EOF and runs the normal cleanup, which calls `Client.close`.
//!
//! Known library race: when the peer disconnects, websocket.zig closes the descriptor on its
//! reader thread without taking `Conn.lock`, and `Client.close` follows a moment later. A publisher
//! that passed the `isClosed` check in that gap writes to a closed descriptor, which fails with
//! EBADF; it would reach a stranger's socket only if the kernel reused the number for a new accept
//! in the same few microseconds. Closing it needs a change inside websocket.zig.
const std = @import("std");
const httpz = @import("httpz");
const headers = @import("../http/headers.zig");
const ids = @import("../ids.zig");
const topics = @import("topics.zig");

const websocket = httpz.websocket;

pub const Topic = topics.Topic;
pub const Nudge = topics.Nudge;
pub const Registry = topics.Registry;

/// `maxPayloadLength: 1024`, realtime.ts:51.
pub const max_payload_bytes = 1024;

/// For `httpz.Server(...).init`: the reader refuses any message above the cap.
pub const websocket_config: httpz.Config.Websocket = .{ .max_message_size = max_payload_bytes };

/// Who the session middleware says is calling. Strings must stay valid for the request.
pub const Identity = struct {
    session_id: []const u8,
    user_id: []const u8,
    instance_admin: bool,
};

/// What the hub needs from the auth and orgs slices, as plain functions so it builds and tests
/// without them. Every callback runs on a pool or ticker thread with no hub lock held; each may
/// take the App lock.
pub const Access = struct {
    ctx: *anyopaque,
    /// The session middleware's verdict for the upgrade request; null is 401. Allocations go to
    /// `arena`, which lives for the request.
    identify: *const fn (ctx: *anyopaque, req: *httpz.Request, arena: std.mem.Allocator) ?Identity,
    /// `orgAccess(db, userId, orgId) !== null`.
    org_access: *const fn (ctx: *anyopaque, user_id: []const u8, org_id: []const u8) bool,
    /// `sessionExpiresAt`: epoch ms, or null once the session is revoked or lapsed.
    session_expires_at: *const fn (ctx: *anyopaque, session_id: []const u8) ?i64,
};

pub const Config = struct {
    /// Bun pings idle sockets itself; 30 s keeps proxies and browsers from dropping a quiet one.
    ping_interval_ms: u32 = 30_000,
    /// `idleTimeout: 120`, realtime.ts:52.
    idle_timeout_ms: u32 = 120_000,
    /// `SWEEP_MS`, realtime.ts:26.
    sweep_interval_ms: u32 = 60_000,
    /// Resolution of the three timers above, and the longest `stop` can wait.
    tick_ms: u32 = 500,
};

fn awakeMs(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}

pub const Hub = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    access: Access,
    config: Config,
    registry: Registry,
    ticker: ?std.Thread = null,
    stopping: std.atomic.Value(bool) = .init(false),

    pub fn init(gpa: std.mem.Allocator, io: std.Io, access: Access, config: Config) Hub {
        return .{ .gpa = gpa, .io = io, .access = access, .config = config, .registry = Registry.init(gpa, io) };
    }

    /// Stops the ticker if it still runs. The httpz server must already be stopped.
    pub fn deinit(hub: *Hub) void {
        hub.stop();
        hub.registry.deinit();
    }

    /// Starts the ping, idle and expiry timers. The hub must not move afterwards.
    pub fn start(hub: *Hub) std.Thread.SpawnError!void {
        std.debug.assert(hub.ticker == null);
        hub.stopping.store(false, .release);
        hub.ticker = try std.Thread.spawn(.{}, tickerMain, .{hub});
    }

    pub fn stop(hub: *Hub) void {
        const thread = hub.ticker orelse return;
        hub.stopping.store(true, .release);
        thread.join();
        hub.ticker = null;
    }

    /// The `/ws` route. The session and Origin checks of http/server.zig have already run; this is
    /// `wsUpgrade` itself: topic, then access to it, then the session's expiry.
    pub fn handleUpgrade(hub: *Hub, req: *httpz.Request, res: *httpz.Response) !void {
        const topic = topicOf(req) orelse return headers.sendError(res, 400, "invalid topic");
        const identity = hub.access.identify(hub.access.ctx, req, res.arena) orelse
            return headers.sendError(res, 401, "unauthorized");
        const allowed = if (topic.orgId()) |org_id|
            hub.access.org_access(hub.access.ctx, identity.user_id, org_id)
        else
            identity.instance_admin;
        if (!allowed) return headers.sendError(res, 403, "forbidden");
        const expires_at_ms = hub.access.session_expires_at(hub.access.ctx, identity.session_id) orelse
            return headers.sendError(res, 401, "session expired");

        const upgrade: Upgrade = .{ .hub = hub, .topic = topic, .identity = identity, .expires_at_ms = expires_at_ms };
        if (!try httpz.upgradeWebsocket(Client, req, res, &upgrade)) {
            try headers.sendError(res, 426, "upgrade failed");
        }
    }

    fn tickerMain(hub: *Hub) void {
        const config = hub.config;
        var next_ping = awakeMs(hub.io) + config.ping_interval_ms;
        var next_sweep = awakeMs(hub.io) + config.sweep_interval_ms;
        while (!hub.stopping.load(.acquire)) {
            hub.io.sleep(.fromMilliseconds(config.tick_ms), .awake) catch return;
            const now = awakeMs(hub.io);
            _ = hub.registry.closeIdle(now, config.idle_timeout_ms);
            if (now >= next_ping) {
                hub.registry.pingAll();
                next_ping = now + config.ping_interval_ms;
            }
            if (now >= next_sweep) {
                hub.sweepSessions() catch |err| std.log.warn("realtime: session sweep failed: {t}", .{err});
                next_sweep = now + config.sweep_interval_ms;
            }
        }
    }

    /// `sweepExpired`: sockets past the expiry they saw are checked against the database, which may
    /// have slid the session forward. The database is asked with the registry unlocked.
    pub fn sweepSessions(hub: *Hub) error{OutOfMemory}!void {
        var arena: std.heap.ArenaAllocator = .init(hub.gpa);
        defer arena.deinit();
        const due = try hub.registry.expiredSessions(arena.allocator(), ids.nowMs(hub.io));
        for (due) |item| {
            const current = hub.access.session_expires_at(hub.access.ctx, item.session_id);
            hub.registry.applyExpiry(item.id, current);
        }
    }
};

/// `wsTopicSchema.safeParse(c.req.query("topic"))`.
fn topicOf(req: *httpz.Request) ?Topic {
    const query = req.query() catch return null;
    return Topic.parse(query.get("topic") orelse return null);
}

/// Handed to `httpz.upgradeWebsocket` and read back in `Client.init` and `afterInit`, both of
/// which run before it returns, so it can live on the handler's stack.
const Upgrade = struct {
    hub: *Hub,
    topic: Topic,
    identity: Identity,
    expires_at_ms: i64,
};

/// One upgraded connection; websocket.zig keeps it in its handler slot and calls these methods
/// from a pool thread, one at a time per connection.
pub const Client = struct {
    hub: *Hub,
    conn: *websocket.Conn,
    entry: ?*topics.Entry = null,

    pub fn init(conn: *websocket.Conn, upgrade: *const Upgrade) !Client {
        return .{ .hub = upgrade.hub, .conn = conn };
    }

    /// Runs after the 101 reply is on the wire. Registering earlier would let a publisher write a
    /// frame in front of the handshake response.
    pub fn afterInit(client: *Client, upgrade: *const Upgrade) !void {
        const hub = client.hub;
        client.entry = try hub.registry.add(.{
            .topic = upgrade.topic,
            .session_id = upgrade.identity.session_id,
            .user_id = upgrade.identity.user_id,
            .expires_at_ms = upgrade.expires_at_ms,
            .now_ms = awakeMs(hub.io),
            .sink = .{ .ctx = client.conn, .send = sinkSend, .close = sinkClose },
        });
    }

    /// Clients only listen: anything they send is ignored, but it shows the socket is alive.
    pub fn clientMessage(client: *Client, data: []const u8) !void {
        client.touch();
        if (data.len > max_payload_bytes) return error.PayloadTooLarge;
    }

    pub fn clientPong(client: *Client, _: []const u8) !void {
        client.touch();
    }

    pub fn clientPing(client: *Client, data: []const u8) !void {
        client.touch();
        try client.conn.writeFrame(.pong, data);
    }

    /// Called when the socket is gone, from the reader thread (or while the server shuts down).
    pub fn close(client: *Client) void {
        const entry = client.entry orelse return;
        client.entry = null;
        client.hub.registry.remove(entry.id);
    }

    fn touch(client: *Client) void {
        if (client.entry) |entry| entry.touch(awakeMs(client.hub.io));
    }
};

const send_flags: u32 = std.posix.MSG.DONTWAIT | if (@hasDecl(std.posix.MSG, "NOSIGNAL")) std.posix.MSG.NOSIGNAL else 0;

/// Writes one whole frame without blocking. Called with the registry lock held. A frame the
/// kernel refuses outright is dropped. One it took only partly would leave the stream cut in the
/// middle of a frame, so that connection is ended. The lock of `Conn` serialises this with the
/// library's own writes (pong replies).
fn sinkSend(ctx: *anyopaque, frame: []const u8) topics.SendResult {
    const conn: *websocket.Conn = @ptrCast(@alignCast(ctx));
    conn.lock.lockUncancelable(conn.io);
    defer conn.lock.unlock(conn.io);
    if (conn.isClosed()) return .failed;
    const fd = conn.stream.socket.handle;
    var sent: usize = 0;
    while (sent < frame.len) {
        const rc = std.c.send(fd, frame.ptr + sent, frame.len - sent, send_flags);
        switch (std.posix.errno(rc)) {
            .SUCCESS => {
                if (rc <= 0) break;
                sent += @intCast(rc);
                continue;
            },
            .INTR => continue,
            .AGAIN => if (sent == 0) return .dropped,
            else => {},
        }
        shutdownBoth(fd);
        return .failed;
    }
    if (sent < frame.len) {
        shutdownBoth(fd);
        return .failed;
    }
    return .sent;
}

/// Close frame with `code`, then shutdown. A failed shutdown means the peer is already gone, and
/// the reader's cleanup runs either way.
fn sinkClose(ctx: *anyopaque, code: u16, reason: []const u8) void {
    const conn: *websocket.Conn = @ptrCast(@alignCast(ctx));
    var frame: [2 + 2 + 123]u8 = undefined;
    const text = reason[0..@min(reason.len, 123)];
    frame[0] = 0x80 | topics.opcode_close;
    frame[1] = @intCast(2 + text.len);
    std.mem.writeInt(u16, frame[2..4], code, .big);
    @memcpy(frame[4..][0..text.len], text);

    conn.lock.lockUncancelable(conn.io);
    defer conn.lock.unlock(conn.io);
    if (conn.isClosed()) return;
    const fd = conn.stream.socket.handle;
    // Best effort: a full buffer means the client is not reading anyway, and the shutdown below
    // ends the connection.
    const rc = std.c.send(fd, &frame, 4 + text.len, send_flags);
    if (rc < 0 and std.posix.errno(rc) == .INTR) _ = std.c.send(fd, &frame, 4 + text.len, send_flags);
    shutdownBoth(fd);
}

fn shutdownBoth(fd: std.posix.fd_t) void {
    _ = std.c.shutdown(fd, std.posix.SHUT.RDWR);
}

test {
    _ = @import("topics.zig");
    _ = @import("hub_test.zig");
}
