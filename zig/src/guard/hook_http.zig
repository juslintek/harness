//! The hook's telemetry POST: a plain HTTP/1.1 request to the harness server on loopback. It is
//! best effort like the `report` function of guard-hook.ts: no failure here changes the decision,
//! and the whole exchange is cut off after a second.
const std = @import("std");

pub const timeout_ms: i64 = 1000;

pub const Target = struct {
    address: std.Io.net.IpAddress,
    /// `host[:port]` exactly as the URL spelled it.
    authority: []const u8,
    path: []const u8,
};

/// `http://127.0.0.1:4100/api/guard/hook`, `http://localhost:4100/...` and `http://[::1]:4100/...`;
/// anything else is not a target.
pub fn parseUrl(url: []const u8) ?Target {
    const scheme = "http://";
    if (!std.mem.startsWith(u8, url, scheme)) return null;
    const rest = url[scheme.len..];
    const slash = std.mem.findScalar(u8, rest, '/') orelse rest.len;
    const authority = rest[0..slash];
    const path = if (slash < rest.len) rest[slash..] else "/";
    if (std.mem.findAny(u8, url, "\r\n ") != null or authority.len == 0) return null;
    // The run token goes in the request, so only loopback is a target: 127.0.0.0/8, ::1, localhost.
    // TS fetches whatever HARNESS_HOOK_URL says; the server only ever hands out its loopback URL.
    var host: []const u8 = authority;
    var port_text: ?[]const u8 = null;
    var v6 = false;
    if (std.mem.startsWith(u8, authority, "[")) {
        const close = std.mem.findScalar(u8, authority, ']') orelse return null;
        host = authority[1..close];
        const after = authority[close + 1 ..];
        if (after.len > 0) {
            if (after[0] != ':') return null;
            port_text = after[1..];
        }
        v6 = true;
    } else if (std.mem.findScalarLast(u8, authority, ':')) |c| {
        host = authority[0..c];
        port_text = authority[c + 1 ..];
    }
    const port: u16 = if (port_text) |t| std.fmt.parseInt(u16, t, 10) catch return null else 80;
    const address: std.Io.net.IpAddress = if (v6)
        (if (std.mem.eql(u8, host, "::1")) .{ .ip6 = .loopback(port) } else return null)
    else if (std.mem.eql(u8, host, "localhost"))
        .{ .ip4 = .loopback(port) }
    else blk: {
        const ip = std.Io.net.IpAddress.parseIp4(host, port) catch return null;
        if (ip.ip4.bytes[0] != 127) return null;
        break :blk ip;
    };
    return .{ .address = address, .authority = authority, .path = path };
}

const Event = union(enum) {
    work: void,
    timer: std.Io.Cancelable!void,
};

fn exchange(io: std.Io, target: Target, token: []const u8, body: []const u8) void {
    var stream = target.address.connect(io, .{ .mode = .stream }) catch return;
    defer stream.close(io);
    var read_buffer: [512]u8 = undefined;
    var write_buffer: [1024]u8 = undefined;
    var writer = stream.writer(io, &write_buffer);
    var reader = stream.reader(io, &read_buffer);
    const w = &writer.interface;
    w.print(
        "POST {s} HTTP/1.1\r\nHost: {s}\r\ncontent-type: application/json\r\nauthorization: Bearer {s}\r\n" ++
            "content-length: {d}\r\nconnection: close\r\n\r\n",
        .{ target.path, target.authority, token, body.len },
    ) catch return;
    w.writeAll(body) catch return;
    w.flush() catch return;
    // Wait for the status line so the server has the request before the process exits.
    _ = reader.interface.takeDelimiter('\n') catch return;
}

fn wait(io: std.Io) std.Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(timeout_ms), .awake);
}

/// Sends the report; returns when the server answered, the connection failed or the time is up.
pub fn post(io: std.Io, target: Target, token: []const u8, body: []const u8) void {
    if (std.mem.findAny(u8, token, "\r\n") != null) return;
    var buffer: [2]Event = undefined;
    var select: std.Io.Select(Event) = .init(io, &buffer);
    defer select.cancelDiscard();
    select.concurrent(.work, exchange, .{ io, target, token, body }) catch return;
    select.concurrent(.timer, wait, .{io}) catch return;
    _ = select.await() catch return;
}

pub fn run(io: std.Io, url: []const u8, token: []const u8, body: []const u8) void {
    const target = parseUrl(url) orelse return;
    post(io, target, token, body);
}
