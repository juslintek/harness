//! HTTP client for Ollaya's `/api/decide` and `/api/version`. TS: features/laya/client.ts.
//!
//! `decide` never throws for a Laya problem: it returns a `Reason` and feeds the circuit breaker
//! the same way TS does (everything except `truncated` counts as a failure). A call is a plain
//! HTTP/1.1 request on a fresh connection, raced against a timer that covers connect, request and
//! body like `AbortSignal.timeout`. No lock is held here; the breaker has its own mutex.
const std = @import("std");
const breaker_mod = @import("breaker.zig");
const json = @import("../json.zig");

pub const Breaker = breaker_mod.Breaker;

pub const default_url = "http://127.0.0.1:11435";
pub const health_timeout_ms: i64 = 1500;
/// Ollaya answers are a few hundred bytes; anything bigger is not a decide response.
const max_body_bytes = 1024 * 1024;

pub const Reason = enum { timeout, down, http, truncated, bad_body, circuit_open };

pub const Criterion = struct { key: []const u8, text: []const u8 };

pub const Question = union(enum) {
    noul: struct { instructions: []const u8 },
    score: struct { instructions: []const u8, criteria: []const []const u8 },
    choice: struct { instructions: []const u8, criteria: []const Criterion },
};

/// Questions go out in slice order, like the insertion order of the TS record.
pub const NamedQuestion = struct { name: []const u8, question: Question };

pub const Prob = struct { key: []const u8, p: f64 };

pub const Answer = union(enum) {
    noul: f64,
    score: struct { score: ?f64, probabilities: []const Prob },
    choice: struct { choice: []const u8, probabilities: []const Prob },
};

const NamedAnswer = struct { name: []const u8, answer: Answer };

/// Validated answers. Everything lives in `arena`; keys and probabilities keep wire order.
pub const Answers = struct {
    arena: std.heap.ArenaAllocator,
    entries: []const NamedAnswer,
    /// `routing.model` when Laya sent one, else `model`.
    model: []const u8,

    pub fn get(self: *const Answers, name: []const u8) ?Answer {
        for (self.entries) |e| if (std.mem.eql(u8, e.name, name)) return e.answer;
        return null;
    }

    pub fn deinit(self: *Answers) void {
        self.arena.deinit();
    }
};

pub const Result = union(enum) {
    ok: Answers,
    failed: Reason,

    pub fn deinit(self: *Result) void {
        if (self.* == .ok) self.ok.deinit();
    }
};

pub const Health = struct {
    up: bool,
    /// Owned by the caller's allocator.
    version: ?[]u8,

    pub fn deinit(self: *Health, gpa: std.mem.Allocator) void {
        if (self.version) |v| gpa.free(v);
    }
};

/// Epoch milliseconds. Tests install their own to step through the breaker windows.
pub const Clock = struct {
    ctx: ?*anyopaque = null,
    now_fn: ?*const fn (?*anyopaque) i64 = null,

    fn now(self: Clock, io: std.Io) i64 {
        if (self.now_fn) |f| return f(self.ctx);
        return std.Io.Clock.real.now(io).toMilliseconds();
    }
};

pub const Client = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    /// `OLLAYA_URL` or `default_url`; not owned.
    base_url: []const u8,
    breaker: Breaker = .{},
    clock: Clock = .{},

    pub fn init(gpa: std.mem.Allocator, io: std.Io, ollaya_url: ?[]const u8) Client {
        return .{ .gpa = gpa, .io = io, .base_url = ollaya_url orelse default_url };
    }

    /// TS resetLayaCircuit.
    pub fn resetCircuit(self: *Client) void {
        self.breaker.reset(self.io);
    }

    fn failure(self: *Client, reason: Reason) Result {
        if (reason != .truncated) self.breaker.recordFailure(self.io, self.clock.now(self.io));
        return .{ .failed = reason };
    }

    /// `state` is any value std.json can stringify; it is sent as `state`.
    pub fn decide(self: *Client, state: anytype, questions: []const NamedQuestion, timeout_ms: i64) error{OutOfMemory}!Result {
        if (!self.breaker.allow(self.io, self.clock.now(self.io))) return .{ .failed = .circuit_open };

        const payload = try encodeRequest(self.gpa, state, questions);
        defer self.gpa.free(payload);
        const url = try std.fmt.allocPrint(self.gpa, "{s}/api/decide", .{self.base_url});
        defer self.gpa.free(url);

        var ex = try exchange(self.gpa, self.io, .{ .method = .POST, .url = url, .payload = payload, .timeout_ms = timeout_ms });
        defer ex.deinit(self.gpa);
        switch (ex.outcome) {
            .oom => return error.OutOfMemory,
            .timeout => return self.failure(.timeout),
            .down => return self.failure(.down),
            .bad_body => return self.failure(.bad_body),
            .done => {},
        }
        if (ex.status < 200 or ex.status > 299) return self.failure(.http);

        var parsed = parseResponse(self.gpa, ex.body orelse "") catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.BadBody => return self.failure(.bad_body),
        };
        if (parsed.truncated) {
            parsed.answers.deinit();
            return self.failure(.truncated);
        }
        self.breaker.recordSuccess(self.io);
        return .{ .ok = parsed.answers };
    }

    /// TS layaHealth. Does not touch the breaker.
    pub fn health(self: *Client) error{OutOfMemory}!Health {
        const url = try std.fmt.allocPrint(self.gpa, "{s}/api/version", .{self.base_url});
        defer self.gpa.free(url);
        var ex = try exchange(self.gpa, self.io, .{ .method = .GET, .url = url, .timeout_ms = health_timeout_ms, .read_any_status = true });
        defer ex.deinit(self.gpa);
        const down: Health = .{ .up = false, .version = null };
        switch (ex.outcome) {
            .oom => return error.OutOfMemory,
            .timeout, .down, .bad_body => return down,
            .done => {},
        }
        // res.json() throws on a body that is not JSON, which TS reports as down even for a 200.
        var arena: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena.deinit();
        const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), ex.body orelse "", value_options) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return down,
        };
        const up = ex.status >= 200 and ex.status <= 299;
        const version: ?[]u8 = blk: {
            if (root != .object) break :blk null;
            const v = root.object.get("version") orelse break :blk null;
            if (v != .string) break :blk null;
            break :blk try self.gpa.dupe(u8, v.string);
        };
        return .{ .up = up, .version = version };
    }
};

// ---- request body ---------------------------------------------------------------------------

/// `{"model":"laya","state":...,"questions":{...}}`, the field order of the TS JSON.stringify.
fn encodeRequest(gpa: std.mem.Allocator, state: anytype, questions: []const NamedQuestion) error{OutOfMemory}![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    writeRequest(&out.writer, state, questions) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

fn writeRequest(w: *std.Io.Writer, state: anytype, questions: []const NamedQuestion) std.Io.Writer.Error!void {
    var s: std.json.Stringify = .{ .writer = w };
    try s.beginObject();
    try s.objectField("model");
    try s.write("laya");
    try s.objectField("state");
    try s.write(state);
    try s.objectField("questions");
    try s.beginObject();
    for (questions) |q| {
        try s.objectField(q.name);
        try s.beginObject();
        switch (q.question) {
            .noul => |n| {
                try s.objectField("type");
                try s.write("noul");
                try s.objectField("instructions");
                try s.write(n.instructions);
            },
            .score => |n| {
                try s.objectField("type");
                try s.write("score");
                try s.objectField("instructions");
                try s.write(n.instructions);
                try s.objectField("criteria");
                try s.write(n.criteria);
            },
            .choice => |n| {
                try s.objectField("type");
                try s.write("choice");
                try s.objectField("instructions");
                try s.write(n.instructions);
                try s.objectField("criteria");
                try s.beginObject();
                for (n.criteria) |c| {
                    try s.objectField(c.key);
                    try s.write(c.text);
                }
                try s.endObject();
            },
        }
        try s.endObject();
    }
    try s.endObject();
    try s.endObject();
}

// ---- response body --------------------------------------------------------------------------

const value_options: std.json.ParseOptions = .{
    .duplicate_field_behavior = json.parse_options.duplicate_field_behavior,
    .ignore_unknown_fields = true,
    .allocate = .alloc_always,
};

const Parsed = struct { answers: Answers, truncated: bool };

/// Mirrors the zod `bodySchema`: any shape error is `BadBody`, as is invalid JSON.
fn parseResponse(gpa: std.mem.Allocator, bytes: []const u8) error{ OutOfMemory, BadBody }!Parsed {
    var answers: Answers = .{ .arena = .init(gpa), .entries = &.{}, .model = "" };
    errdefer answers.arena.deinit();
    const a = answers.arena.allocator();
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, value_options) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.BadBody,
    };
    if (root != .object) return error.BadBody;
    const model = try stringField(root.object, "model");
    const answer_map = (root.object.get("answers") orelse return error.BadBody);
    if (answer_map != .object) return error.BadBody;

    var entries: std.ArrayList(NamedAnswer) = .empty;
    var it = answer_map.object.iterator();
    while (it.next()) |kv| {
        try entries.append(a, .{ .name = kv.key_ptr.*, .answer = try parseAnswer(a, kv.value_ptr.*) });
    }

    var routed: ?[]const u8 = null;
    if (root.object.get("routing")) |routing| {
        if (routing != .object) return error.BadBody;
        routed = try stringField(routing.object, "model");
    }
    var truncated = false;
    if (root.object.get("state_truncated")) |t| {
        if (t != .bool) return error.BadBody;
        truncated = t.bool;
    }
    answers.entries = entries.items;
    answers.model = routed orelse model;
    return .{ .answers = answers, .truncated = truncated };
}

fn stringField(obj: std.json.ObjectMap, name: []const u8) error{BadBody}![]const u8 {
    const v = obj.get(name) orelse return error.BadBody;
    if (v != .string) return error.BadBody;
    return v.string;
}

fn numberOf(v: std.json.Value) error{BadBody}!f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |s| std.fmt.parseFloat(f64, s) catch error.BadBody,
        else => error.BadBody,
    };
}

fn probabilities(a: std.mem.Allocator, obj: std.json.ObjectMap) error{ OutOfMemory, BadBody }![]const Prob {
    const v = obj.get("probabilities") orelse return error.BadBody;
    if (v != .object) return error.BadBody;
    const list = try a.alloc(Prob, v.object.count());
    var it = v.object.iterator();
    var i: usize = 0;
    while (it.next()) |kv| : (i += 1) list[i] = .{ .key = kv.key_ptr.*, .p = try numberOf(kv.value_ptr.*) };
    return list;
}

fn parseAnswer(a: std.mem.Allocator, v: std.json.Value) error{ OutOfMemory, BadBody }!Answer {
    if (v != .object) return error.BadBody;
    const kind = try stringField(v.object, "type");
    if (std.mem.eql(u8, kind, "noul")) {
        return .{ .noul = try numberOf(v.object.get("noul") orelse return error.BadBody) };
    }
    if (std.mem.eql(u8, kind, "score")) {
        const score: ?f64 = if (v.object.get("score")) |s| try numberOf(s) else null;
        return .{ .score = .{ .score = score, .probabilities = try probabilities(a, v.object) } };
    }
    if (std.mem.eql(u8, kind, "choice")) {
        const choice = try stringField(v.object, "choice");
        return .{ .choice = .{ .choice = choice, .probabilities = try probabilities(a, v.object) } };
    }
    return error.BadBody;
}

// ---- transport ------------------------------------------------------------------------------

const Exchange = struct {
    const Outcome = enum { done, timeout, down, bad_body, oom };

    outcome: Outcome = .down,
    status: u16 = 0,
    body: ?[]u8 = null,

    fn deinit(self: *Exchange, gpa: std.mem.Allocator) void {
        if (self.body) |b| gpa.free(b);
    }
};

const Request = struct {
    method: std.http.Method,
    url: []const u8,
    payload: ?[]const u8 = null,
    timeout_ms: i64,
    /// Read the body of a non-2xx answer too (the health check does, the decide call does not).
    read_any_status: bool = false,
};

const Event = union(enum) {
    work: void,
    timer: std.Io.Cancelable!void,
};

fn sleepTask(io: std.Io, ms: i64) std.Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

/// Runs one request against a timer. The tasks are joined before this returns, so `ex` is never
/// written after it and a body that arrived too late is freed here.
fn exchange(gpa: std.mem.Allocator, io: std.Io, req: Request) error{OutOfMemory}!Exchange {
    var ex: Exchange = .{};
    var buffer: [2]Event = undefined;
    var select: std.Io.Select(Event) = .init(io, &buffer);
    defer select.cancelDiscard();
    select.concurrent(.work, exchangeTask, .{ gpa, io, req, &ex }) catch return .{ .outcome = .down };
    select.concurrent(.timer, sleepTask, .{ io, req.timeout_ms }) catch {
        select.cancelDiscard();
        ex.deinit(gpa);
        return .{ .outcome = .down };
    };
    const first = select.await() catch {
        select.cancelDiscard();
        ex.deinit(gpa);
        return .{ .outcome = .down };
    };
    select.cancelDiscard();
    switch (first) {
        .work => {},
        .timer => {
            ex.deinit(gpa);
            return .{ .outcome = .timeout };
        },
    }
    if (ex.outcome == .oom) return error.OutOfMemory;
    return ex;
}

fn exchangeTask(gpa: std.mem.Allocator, io: std.Io, req: Request, ex: *Exchange) void {
    ex.outcome = if (roundTrip(gpa, io, req, ex)) .done else |err| switch (err) {
        error.OutOfMemory => .oom,
        error.BadBody => .bad_body,
        else => .down,
    };
}

fn roundTrip(gpa: std.mem.Allocator, io: std.Io, spec: Request, ex: *Exchange) !void {
    const payload = spec.payload;
    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();
    const uri = try std.Uri.parse(spec.url);
    // keepalive:false in TS: a pooled socket to a restarted Ollaya must not fail a call.
    var req = try client.request(spec.method, uri, .{
        .keep_alive = false,
        .redirect_behavior = if (payload == null) .init(3) else .unhandled,
        .headers = .{
            .accept_encoding = .omit,
            .content_type = if (payload != null) .{ .override = "application/json" } else .default,
        },
    });
    defer req.deinit();
    if (payload) |p| {
        req.transfer_encoding = .{ .content_length = p.len };
        var body = try req.sendBodyUnflushed(&.{});
        try body.writer.writeAll(p);
        try body.end();
        try req.connection.?.flush();
    } else {
        try req.sendBodiless();
    }
    var redirect_buffer: [8 * 1024]u8 = undefined;
    var response = try req.receiveHead(if (payload == null) &redirect_buffer else &.{});
    ex.status = @backingInt(response.head.status);
    if (!spec.read_any_status and (ex.status < 200 or ex.status > 299)) return;
    if (response.head.content_encoding != .identity) return error.BadBody;
    var transfer_buffer: [256]u8 = undefined;
    const reader = response.reader(&transfer_buffer);
    ex.body = reader.allocRemaining(gpa, .limited(max_body_bytes)) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.StreamTooLong => return error.BadBody,
        error.ReadFailed => return response.bodyErr() orelse error.ReadFailed,
    };
}

test {
    _ = @import("breaker.zig");
    _ = @import("client_test.zig");
}
