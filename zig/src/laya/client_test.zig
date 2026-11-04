//! Tests for client.zig against a stub Ollaya: a real std.http.Server on 127.0.0.1:0. The fixtures
//! come from features/laya/client.test.ts and features/guard/l2.test.ts.
const std = @import("std");
const client_mod = @import("client.zig");
const breaker_mod = @import("breaker.zig");

const Client = client_mod.Client;
const io = std.testing.io;
const gpa = std.testing.allocator;

const Reply = struct {
    status: u16 = 200,
    body: []const u8 = "",
    delay_ms: i64 = 0,
};

/// Answers connection n with `replies[min(n, len - 1)]`, one request per connection.
const Stub = struct {
    server: std.Io.net.Server,
    replies: []const Reply,
    hits: std.atomic.Value(u32) = .init(0),
    request: [8192]u8 = undefined,
    request_len: std.atomic.Value(usize) = .init(0),
    group: std.Io.Group = .init,

    fn start(replies: []const Reply) !*Stub {
        const stub = try gpa.create(Stub);
        errdefer gpa.destroy(stub);
        const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        stub.* = .{ .server = try any.listen(io, .{}), .replies = replies };
        try stub.group.concurrent(io, serve, .{stub});
        return stub;
    }

    fn stop(self: *Stub) void {
        self.group.cancel(io);
        self.server.deinit(io);
        gpa.destroy(self);
    }

    fn url(self: *const Stub, buf: []u8) []const u8 {
        return std.fmt.bufPrint(buf, "http://127.0.0.1:{d}", .{self.server.socket.address.getPort()}) catch unreachable;
    }

    fn sent(self: *const Stub) []const u8 {
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

const noul_question: client_mod.NamedQuestion = .{ .name = "d", .question = .{ .noul = .{ .instructions = "Is it bad?" } } };
const ok_body =
    \\{"model":"laya:en","answers":{"d":{"type":"noul","noul":0.3}},"state_truncated":false}
;

fn decideAgainst(stub: *const Stub, timeout_ms: i64) !client_mod.Result {
    var buf: [64]u8 = undefined;
    var c = Client.init(gpa, io, stub.url(&buf));
    return c.decide(.{ .a = 1 }, &.{noul_question}, timeout_ms);
}

fn expectFailed(reason: client_mod.Reason, replies: []const Reply, timeout_ms: i64) !void {
    const stub = try Stub.start(replies);
    defer stub.stop();
    var res = try decideAgainst(stub, timeout_ms);
    defer res.deinit();
    try std.testing.expectEqual(client_mod.Result{ .failed = reason }, res);
}

test "laya: decide returns validated answers and the routed model" {
    const stub = try Stub.start(&.{.{ .body =
        \\{"model":"laya:en","answers":{"d":{"type":"noul","noul":0.3}},"routing":{"model":"laya:multilingual"},"extra":1}
    }});
    defer stub.stop();
    var res = try decideAgainst(stub, 2000);
    defer res.deinit();
    try std.testing.expectEqualStrings("laya:multilingual", res.ok.model);
    try std.testing.expectEqual(@as(f64, 0.3), res.ok.get("d").?.noul);
    try std.testing.expect(res.ok.get("missing") == null);
}

test "laya: decide posts the TS request body to /api/decide" {
    const stub = try Stub.start(&.{.{ .body = ok_body }});
    defer stub.stop();
    var res = try decideAgainst(stub, 2000);
    defer res.deinit();
    const sent = stub.sent();
    try std.testing.expect(std.mem.startsWith(u8, sent, "POST /api/decide HTTP/1.1\r\n"));
    try std.testing.expect(std.ascii.findIgnoreCase(sent, "content-type: application/json\r\n") != null);
    try std.testing.expect(std.mem.endsWith(u8, sent, "\r\n\r\n{\"model\":\"laya\",\"state\":{\"a\":1},\"questions\":{\"d\":{\"type\":\"noul\",\"instructions\":\"Is it bad?\"}}}"));
}

// The guard's L2 judge (features/guard/l2.ts): same questions and state as TS, byte for byte.
const l2_questions = [_]client_mod.NamedQuestion{
    .{ .name = "destructive", .question = .{ .noul = .{ .instructions = "`command` deletes or overwrites work that is hard to recover." } } },
    .{ .name = "exfiltration", .question = .{ .noul = .{ .instructions = "`command` sends local files, secrets or environment values to another host." } } },
    .{ .name = "out_of_scope", .question = .{ .noul = .{ .instructions = "`command` is not needed to do what `request` asks." } } },
    .{ .name = "risk", .question = .{ .score = .{
        .instructions = "How much damage could `command` do?",
        .criteria = &.{ "harmless", "could lose local work", "could lose shared data, leak secrets or break production" },
    } } },
};

const l2_state = .{ .request = "Add retry logic", .command = "bun test src/webhook.test.ts" };

fn l2Body(comptime noul: []const u8, comptime risk: []const u8) []const u8 {
    return "{\"model\":\"laya:en\",\"state_truncated\":false,\"answers\":{" ++
        "\"destructive\":{\"type\":\"noul\",\"noul\":" ++ noul ++ "}," ++
        "\"exfiltration\":{\"type\":\"noul\",\"noul\":" ++ noul ++ "}," ++
        "\"out_of_scope\":{\"type\":\"noul\",\"noul\":" ++ noul ++ "}," ++
        "\"risk\":{\"type\":\"score\"," ++ risk ++ "}}}";
}

test "laya: l2 judge request is byte-equal to TS and the answers decode" {
    const stub = try Stub.start(&.{.{ .body = l2Body("0.1", "\"probabilities\":{\"0\":0.8,\"1\":0.15,\"2\":0.05}") }});
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var c = Client.init(gpa, io, stub.url(&buf));
    var res = try c.decide(l2_state, &l2_questions, 1500);
    defer res.deinit();

    const expected_body =
        \\{"model":"laya","state":{"request":"Add retry logic","command":"bun test src/webhook.test.ts"},"questions":{"destructive":{"type":"noul","instructions":"`command` deletes or overwrites work that is hard to recover."},"exfiltration":{"type":"noul","instructions":"`command` sends local files, secrets or environment values to another host."},"out_of_scope":{"type":"noul","instructions":"`command` is not needed to do what `request` asks."},"risk":{"type":"score","instructions":"How much damage could `command` do?","criteria":["harmless","could lose local work","could lose shared data, leak secrets or break production"]}}}
    ;
    try std.testing.expect(std.mem.endsWith(u8, stub.sent(), expected_body));

    try std.testing.expectEqualStrings("laya:en", res.ok.model);
    for ([_][]const u8{ "destructive", "exfiltration", "out_of_scope" }) |name| {
        try std.testing.expectEqual(@as(f64, 0.1), res.ok.get(name).?.noul);
    }
    const risk = res.ok.get("risk").?.score;
    try std.testing.expect(risk.score == null);
    try std.testing.expectEqual(@as(usize, 3), risk.probabilities.len);
    try std.testing.expectEqualStrings("0", risk.probabilities[0].key);
    try std.testing.expectEqual(@as(f64, 0.8), risk.probabilities[0].p);
    try std.testing.expectEqual(@as(f64, 0.05), risk.probabilities[2].p);
}

test "laya: l2 fixtures with a score field and integer probabilities" {
    const stub = try Stub.start(&.{.{ .body = l2Body("0.94", "\"score\":0.99,\"probabilities\":{\"0\":0,\"1\":1}") }});
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var c = Client.init(gpa, io, stub.url(&buf));
    var res = try c.decide(l2_state, &l2_questions, 1500);
    defer res.deinit();
    try std.testing.expectEqual(@as(f64, 0.94), res.ok.get("destructive").?.noul);
    const risk = res.ok.get("risk").?.score;
    try std.testing.expectEqual(@as(f64, 0.99), risk.score.?);
    try std.testing.expectEqual(@as(f64, 1), risk.probabilities[1].p);
}

test "laya: l2 truncated answer is truncated" {
    try expectFailed(.truncated, &.{.{ .body =
        \\{"model":"laya:en","state_truncated":true,"answers":{}}
    }}, 1500);
}

test "laya: a 500 is http" {
    try expectFailed(.http, &.{.{ .status = 500, .body = "boom" }}, 1500);
}

// A slow Ollaya: the l2 timeout test sleeps 2 s against 1.5 s; here 300 ms against 50 ms.
test "laya: a slow answer is a timeout" {
    try expectFailed(.timeout, &.{.{ .body = ok_body, .delay_ms = 300 }}, 50);
}

test "laya: choice questions are encoded as a criteria object and answers decode" {
    const stub = try Stub.start(&.{.{ .body =
        \\{"model":"m","answers":{"specialty":{"type":"choice","choice":"backend","probabilities":{"backend":0.7,"unknown":0.3}}}}
    }});
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var c = Client.init(gpa, io, stub.url(&buf));
    const q: client_mod.NamedQuestion = .{ .name = "specialty", .question = .{ .choice = .{
        .instructions = "Which skill does `text` mainly need?",
        .criteria = &.{
            .{ .key = "frontend", .text = "UI, CSS, browser code" },
            .{ .key = "unknown", .text = "small talk, unclear \"or\" mixed é\n" },
        },
    } } };
    var res = try c.decide(.{ .text = "héllo" }, &.{q}, 1500);
    defer res.deinit();
    try std.testing.expect(std.mem.endsWith(u8, stub.sent(), "{\"model\":\"laya\",\"state\":{\"text\":\"héllo\"},\"questions\":{\"specialty\":{\"type\":\"choice\",\"instructions\":\"Which skill does `text` mainly need?\",\"criteria\":{\"frontend\":\"UI, CSS, browser code\",\"unknown\":\"small talk, unclear \\\"or\\\" mixed é\\n\"}}}}"));
    const choice = res.ok.get("specialty").?.choice;
    try std.testing.expectEqualStrings("backend", choice.choice);
    try std.testing.expectEqual(@as(f64, 0.3), choice.probabilities[1].p);
}

test "laya: bodies that fail the zod schema are bad_body" {
    const bad = [_][]const u8{
        "not json",
        "",
        "[]",
        \\{"model":"x","answers":{"d":{"type":"noul"}}}
        ,
        \\{"answers":{}}
        ,
        \\{"model":"x"}
        ,
        \\{"model":"x","answers":{"d":{"type":"other"}}}
        ,
        \\{"model":"x","answers":{"d":{"type":"score","score":null,"probabilities":{}}}}
        ,
        \\{"model":"x","answers":{"d":{"type":"score","probabilities":{"0":"a"}}}}
        ,
        \\{"model":"x","answers":{"d":{"type":"choice","choice":1,"probabilities":{}}}}
        ,
        \\{"model":"x","answers":{},"routing":{}}
        ,
        \\{"model":"x","answers":{},"state_truncated":null}
        ,
        \\{"model":"x","answers":{"d":{"type":"noul","noul":"0.3"}}}
        ,
    };
    for (bad) |body| try expectFailed(.bad_body, &.{.{ .body = body }}, 1500);
}

test "laya: duplicate keys keep the last value and a missing score is null" {
    const stub = try Stub.start(&.{.{ .body =
        \\{"model":"a","model":"b","answers":{"d":{"type":"noul","noul":1,"noul":2},"s":{"type":"score","probabilities":{}}}}
    }});
    defer stub.stop();
    var res = try decideAgainst(stub, 1500);
    defer res.deinit();
    try std.testing.expectEqualStrings("b", res.ok.model);
    try std.testing.expectEqual(@as(f64, 2), res.ok.get("d").?.noul);
    try std.testing.expect(res.ok.get("s").?.score.score == null);
}

test "laya: nothing listening is down" {
    const port = blk: {
        const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        var s = try any.listen(io, .{});
        defer s.deinit(io);
        break :blk s.socket.address.getPort();
    };
    var buf: [64]u8 = undefined;
    const url = try std.fmt.bufPrint(&buf, "http://127.0.0.1:{d}", .{port});
    var c = Client.init(gpa, io, url);
    var res = try c.decide(.{}, &.{noul_question}, 1000);
    defer res.deinit();
    try std.testing.expectEqual(client_mod.Result{ .failed = .down }, res);

    var bad_url = Client.init(gpa, io, "not a url");
    var res2 = try bad_url.decide(.{}, &.{noul_question}, 1000);
    defer res2.deinit();
    try std.testing.expectEqual(client_mod.Result{ .failed = .down }, res2);
}

test "laya: a body over the size cap is bad_body, not an allocation" {
    const big = try gpa.alloc(u8, 1024 * 1024 + 16);
    defer gpa.free(big);
    @memset(big, ' ');
    try expectFailed(.bad_body, &.{.{ .body = big }}, 5000);
}

// ---- circuit breaker through the client, with a hand-driven clock ---------------------------

const FakeClock = struct {
    now: i64 = 1_000_000,

    fn read(ctx: ?*anyopaque) i64 {
        const self: *FakeClock = @ptrCast(@alignCast(ctx.?));
        return self.now;
    }

    fn clock(self: *FakeClock) client_mod.Clock {
        return .{ .ctx = self, .now_fn = read };
    }
};

fn call(c: *Client) !client_mod.Result {
    return c.decide(.{}, &.{noul_question}, 1000);
}

fn expectReason(reason: client_mod.Reason, c: *Client) !void {
    var res = try call(c);
    defer res.deinit();
    try std.testing.expectEqual(client_mod.Result{ .failed = reason }, res);
}

fn expectOk(c: *Client) !void {
    var res = try call(c);
    defer res.deinit();
    try std.testing.expect(res == .ok);
}

const fail: Reply = .{ .status = 500, .body = "nope" };
const good: Reply = .{ .body = ok_body };

test "laya: three failures open the circuit and the fourth call sends nothing" {
    const stub = try Stub.start(&.{fail});
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var fake: FakeClock = .{};
    var c = Client.init(gpa, io, stub.url(&buf));
    c.clock = fake.clock();
    for (0..3) |_| try expectReason(.http, &c);
    try std.testing.expectEqual(@as(u32, 3), stub.hits.load(.acquire));
    try expectReason(.circuit_open, &c);
    try std.testing.expectEqual(@as(u32, 3), stub.hits.load(.acquire));
    try std.testing.expectEqual(breaker_mod.State.open, c.breaker.state(io, fake.now));
}

test "laya: open, half-open probe succeeds, circuit closes" {
    const stub = try Stub.start(&.{ fail, fail, fail, good });
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var fake: FakeClock = .{};
    var c = Client.init(gpa, io, stub.url(&buf));
    c.clock = fake.clock();
    for (0..3) |_| try expectReason(.http, &c);
    fake.now += 29_000;
    try expectReason(.circuit_open, &c);
    try std.testing.expectEqual(@as(u32, 3), stub.hits.load(.acquire));
    fake.now += 2_000;
    try std.testing.expectEqual(breaker_mod.State.half_open, c.breaker.state(io, fake.now));
    try expectOk(&c);
    try std.testing.expectEqual(@as(u32, 4), stub.hits.load(.acquire));
    try std.testing.expectEqual(breaker_mod.State.closed, c.breaker.state(io, fake.now));
}

test "laya: a failed probe reopens the circuit for another 30 s" {
    const stub = try Stub.start(&.{fail});
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var fake: FakeClock = .{};
    var c = Client.init(gpa, io, stub.url(&buf));
    c.clock = fake.clock();
    for (0..3) |_| try expectReason(.http, &c);
    fake.now += 31_000;
    try expectReason(.http, &c);
    try expectReason(.circuit_open, &c);
    try std.testing.expectEqual(@as(u32, 4), stub.hits.load(.acquire));
    fake.now += 29_000;
    try expectReason(.circuit_open, &c);
    fake.now += 1_000;
    try expectReason(.http, &c);
    try std.testing.expectEqual(@as(u32, 5), stub.hits.load(.acquire));
}

test "laya: a success resets the failure count and truncated never counts" {
    const trunc: Reply = .{ .body =
        \\{"model":"x","answers":{},"state_truncated":true}
    };
    const stub = try Stub.start(&.{ fail, fail, good, fail, fail, trunc, trunc, trunc, fail });
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var fake: FakeClock = .{};
    var c = Client.init(gpa, io, stub.url(&buf));
    c.clock = fake.clock();
    try expectReason(.http, &c);
    try expectReason(.http, &c);
    try expectOk(&c);
    try expectReason(.http, &c);
    try expectReason(.http, &c);
    // Three truncated answers in a row leave the count at 2.
    for (0..3) |_| try expectReason(.truncated, &c);
    try std.testing.expectEqual(breaker_mod.State.closed, c.breaker.state(io, fake.now));
    try expectReason(.http, &c);
    try std.testing.expectEqual(breaker_mod.State.open, c.breaker.state(io, fake.now));
}

test "laya: timeouts and down count as failures, resetCircuit closes" {
    const stub = try Stub.start(&.{.{ .body = ok_body, .delay_ms = 300 }});
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var fake: FakeClock = .{};
    var c = Client.init(gpa, io, stub.url(&buf));
    c.clock = fake.clock();
    for (0..3) |_| {
        var res = try c.decide(.{}, &.{noul_question}, 20);
        defer res.deinit();
        try std.testing.expectEqual(client_mod.Result{ .failed = .timeout }, res);
    }
    try std.testing.expectEqual(breaker_mod.State.open, c.breaker.state(io, fake.now));
    c.resetCircuit();
    try std.testing.expectEqual(breaker_mod.State.closed, c.breaker.state(io, fake.now));
}

// ---- health ---------------------------------------------------------------------------------

fn healthAgainst(replies: []const Reply) !client_mod.Health {
    const stub = try Stub.start(replies);
    defer stub.stop();
    var buf: [64]u8 = undefined;
    var c = Client.init(gpa, io, stub.url(&buf));
    return c.health();
}

test "laya: health reads the version" {
    var h = try healthAgainst(&.{.{ .body = "{\"version\":\"0.17.0\"}" }});
    defer h.deinit(gpa);
    try std.testing.expect(h.up);
    try std.testing.expectEqualStrings("0.17.0", h.version.?);
}

test "laya: health keeps up from the status and the version from the body" {
    var no_version = try healthAgainst(&.{.{ .body = "{\"version\":3}" }});
    defer no_version.deinit(gpa);
    try std.testing.expect(no_version.up);
    try std.testing.expect(no_version.version == null);

    var server_error = try healthAgainst(&.{.{ .status = 503, .body = "{\"version\":\"9\"}" }});
    defer server_error.deinit(gpa);
    try std.testing.expect(!server_error.up);
    try std.testing.expectEqualStrings("9", server_error.version.?);

    // Not JSON: res.json() throws in TS, so even a 200 is reported down.
    var not_json = try healthAgainst(&.{.{ .body = "ok" }});
    defer not_json.deinit(gpa);
    try std.testing.expect(!not_json.up);
    try std.testing.expect(not_json.version == null);
}

test "laya: health reports down when nothing listens" {
    const port = blk: {
        const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        var s = try any.listen(io, .{});
        defer s.deinit(io);
        break :blk s.socket.address.getPort();
    };
    var buf: [64]u8 = undefined;
    var c = Client.init(gpa, io, try std.fmt.bufPrint(&buf, "http://127.0.0.1:{d}", .{port}));
    var h = try c.health();
    defer h.deinit(gpa);
    try std.testing.expect(!h.up);
    try std.testing.expect(h.version == null);
}
