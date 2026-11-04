//! `GET /api/agents/ollaya`: `layaHealth` of laya/client.ts. A GET of `<OLLAYA_URL>/api/version`
//! with a 1.5 s limit; any failure, a body that is not JSON included, is "down".
const std = @import("std");

const Io = std.Io;

pub const default_url = "http://127.0.0.1:11435";
pub const health_timeout_ms: i64 = 1500;

pub const Status = struct { up: bool, version: ?[]const u8 };

const down: Status = .{ .up = false, .version = null };

const Fetched = struct { ok: bool, body: []u8 };

const Event = union(enum) {
    fetched: anyerror!Fetched,
    timeout: Io.Cancelable!void,
};

fn fetch(gpa: std.mem.Allocator, io: Io, url: []const u8) anyerror!Fetched {
    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();
    var response: Io.Writer.Allocating = .init(gpa);
    errdefer response.deinit();
    const result = try client.fetch(.{ .location = .{ .url = url }, .response_writer = &response.writer });
    const code = @backingInt(result.status);
    return .{ .ok = code >= 200 and code < 300, .body = try response.toOwnedSlice() };
}

fn sleepMs(io: Io, ms: i64) Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

/// `gpa` must be thread safe; the answer is allocated in `arena`.
pub fn status(gpa: std.mem.Allocator, arena: std.mem.Allocator, io: Io, base_url: []const u8, timeout_ms: i64) std.mem.Allocator.Error!Status {
    const url = try std.fmt.allocPrint(arena, "{s}/api/version", .{base_url});
    var buffer: [2]Event = undefined;
    var select: Io.Select(Event) = .init(io, &buffer);
    defer select.cancelDiscard();
    select.concurrent(.fetched, fetch, .{ gpa, io, url }) catch return down;
    select.concurrent(.timeout, sleepMs, .{ io, timeout_ms }) catch return down;
    const answer = select.await() catch return down;
    const fetched = switch (answer) {
        .fetched => |result| result catch return down,
        .timeout => return down,
    };
    defer gpa.free(fetched.body);
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, fetched.body, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return down,
    };
    const version: ?[]const u8 = switch (parsed) {
        .object => |object| if (object.get("version")) |value| switch (value) {
            .string => |text| text,
            else => null,
        } else null,
        else => null,
    };
    return .{ .up = fetched.ok, .version = version };
}

const testing = std.testing;
const httpz = @import("httpz");

const Fake = struct {
    code: u16,
    body: []const u8,
    delay_ms: i64 = 0,

    pub fn version(self: *Fake, _: *httpz.Request, res: *httpz.Response) !void {
        if (self.delay_ms > 0) try testing.io.sleep(.fromMilliseconds(self.delay_ms), .awake);
        res.status = self.code;
        res.body = self.body;
    }
};

fn probeFake(fake: *Fake, timeout_ms: i64) !struct { Status, std.heap.ArenaAllocator } {
    const io = testing.io;
    const any: Io.net.IpAddress = .{ .ip4 = .loopback(0) };
    var listener = try any.listen(io, .{});
    const port = listener.socket.address.getPort();
    listener.deinit(io);
    var server = try httpz.Server(*Fake).init(io, testing.allocator, .{ .address = .localhost(port), .thread_pool = .{ .count = 2 } }, fake);
    defer server.deinit();
    var router = try server.router(.{});
    router.get("/api/version", Fake.version, .{});
    const thread = try server.listenInNewThread();
    defer {
        server.stop();
        thread.join();
    }
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    errdefer arena.deinit();
    const url = try std.fmt.allocPrint(arena.allocator(), "http://127.0.0.1:{d}", .{port});
    return .{ try status(testing.allocator, arena.allocator(), io, url, timeout_ms), arena };
}

test "agents: ollaya is up with its version" {
    var fake: Fake = .{ .code = 200, .body = "{\"version\":\"0.4.2\",\"x\":1}" };
    const answer, var arena = try probeFake(&fake, 3000);
    defer arena.deinit();
    try testing.expect(answer.up);
    try testing.expectEqualStrings("0.4.2", answer.version.?);
}

test "agents: a non-2xx answer with a version is down but still names it" {
    var fake: Fake = .{ .code = 503, .body = "{\"version\":\"0.4.2\"}" };
    const answer, var arena = try probeFake(&fake, 3000);
    defer arena.deinit();
    try testing.expect(!answer.up);
    try testing.expectEqualStrings("0.4.2", answer.version.?);
}

test "agents: a body that is not JSON, or has no version, is handled like TS" {
    var garbage: Fake = .{ .code = 200, .body = "not json" };
    const first, var first_arena = try probeFake(&garbage, 3000);
    defer first_arena.deinit();
    try testing.expect(!first.up and first.version == null);
    var no_version: Fake = .{ .code = 200, .body = "{\"version\":3}" };
    const second, var second_arena = try probeFake(&no_version, 3000);
    defer second_arena.deinit();
    try testing.expect(second.up and second.version == null);
    var array: Fake = .{ .code = 200, .body = "[]" };
    const third, var third_arena = try probeFake(&array, 3000);
    defer third_arena.deinit();
    try testing.expect(third.up and third.version == null);
}

test "agents: a slow or absent ollaya is down" {
    var slow: Fake = .{ .code = 200, .body = "{\"version\":\"1\"}", .delay_ms = 800 };
    const late, var arena = try probeFake(&slow, 150);
    defer arena.deinit();
    try testing.expect(!late.up and late.version == null);

    var scratch: std.heap.ArenaAllocator = .init(testing.allocator);
    defer scratch.deinit();
    // Nothing listens on port 1.
    const absent = try status(testing.allocator, scratch.allocator(), testing.io, "http://127.0.0.1:1", 1000);
    try testing.expect(!absent.up and absent.version == null);
}
