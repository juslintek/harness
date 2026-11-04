//! Topic registry and publish API of the realtime slice (code/src/server/realtime.ts). A connection
//! is a `Sink` the registry knows nothing about beyond two calls, so this file has no sockets and
//! its tests run on fakes. Other slices call `publish(topic, nudge)`; the hub adds the WebSocket.
//!
//! Locking: one mutex guards the table. `Sink.send` and `Sink.close` run with it held, so a sink
//! must never block and must not call back into the registry. That is also what makes `remove`
//! safe: once it returns, no thread is inside the sink or can reach it again, so the owner may free
//! the connection straight away.
const std = @import("std");
const ids = @import("../ids.zig");

/// `run:` or `org:` plus a UUID; the longest topic `wsTopicSchema` accepts.
pub const topic_max_len = 4 + ids.uuid_len;

/// `wsTopicSchema`, shared/realtime.ts:5: `^(runs|approvals|(run|org):[0-9a-f-]{36})$`.
pub const Topic = struct {
    buf: [topic_max_len]u8,
    len: u8,

    pub const Kind = enum { runs, approvals, run, org };

    pub fn parse(text: []const u8) ?Topic {
        if (std.mem.eql(u8, text, "runs") or std.mem.eql(u8, text, "approvals")) return fromSlice(text);
        if (text.len != topic_max_len) return null;
        const colon = text[3];
        if (colon != ':') return null;
        if (!std.mem.eql(u8, text[0..3], "run") and !std.mem.eql(u8, text[0..3], "org")) return null;
        for (text[4..]) |byte| switch (byte) {
            '0'...'9', 'a'...'f', '-' => {},
            else => return null,
        };
        return fromSlice(text);
    }

    fn fromSlice(text: []const u8) Topic {
        var topic: Topic = .{ .buf = undefined, .len = @intCast(text.len) };
        @memcpy(topic.buf[0..text.len], text);
        return topic;
    }

    pub fn slice(topic: *const Topic) []const u8 {
        return topic.buf[0..topic.len];
    }

    pub fn kind(topic: *const Topic) Kind {
        const text = topic.slice();
        if (std.mem.eql(u8, text, "runs")) return .runs;
        if (std.mem.eql(u8, text, "approvals")) return .approvals;
        return if (text[1] == 'u') .run else .org;
    }

    /// The org id of an `org:` topic.
    pub fn orgId(topic: *const Topic) ?[]const u8 {
        return if (topic.kind() == .org) topic.buf[4..topic.len] else null;
    }
};

/// A message of `WsMessage` (shared/realtime.ts:10-16). `run` and `approval` carry the view as JSON
/// the runtimes and guard slices already built, so this file does not depend on their types.
pub const Nudge = union(enum) {
    event: struct { run_id: []const u8, kind: []const u8, ts: ?i64 },
    run: struct { view_json: []const u8 },
    approval: struct { view_json: []const u8 },
    task: struct { project_id: []const u8, task_id: []const u8, kind: []const u8 },
    chat: struct { channel_id: []const u8, message_id: []const u8, thread_root_id: ?[]const u8 },
    dashboard,

    /// Key order is the one the TS object literals use, so `JSON.stringify` and this agree byte
    /// for byte.
    pub fn writeJson(nudge: Nudge, w: *std.Io.Writer) std.Io.Writer.Error!void {
        var jw: std.json.Stringify = .{ .writer = w, .options = .{} };
        try jw.beginObject();
        try jw.objectField("type");
        try jw.write(@tagName(nudge));
        switch (nudge) {
            .event => |e| {
                try jw.objectField("runId");
                try jw.write(e.run_id);
                try jw.objectField("event");
                try jw.beginObject();
                try jw.objectField("kind");
                try jw.write(e.kind);
                try jw.objectField("ts");
                try jw.write(e.ts);
                try jw.endObject();
            },
            .run => |r| {
                try jw.objectField("run");
                try jw.beginWriteRaw();
                try w.writeAll(r.view_json);
                jw.endWriteRaw();
            },
            .approval => |a| {
                try jw.objectField("approval");
                try jw.beginWriteRaw();
                try w.writeAll(a.view_json);
                jw.endWriteRaw();
            },
            .task => |t| {
                try jw.objectField("projectId");
                try jw.write(t.project_id);
                try jw.objectField("taskId");
                try jw.write(t.task_id);
                try jw.objectField("kind");
                try jw.write(t.kind);
            },
            .chat => |c| {
                try jw.objectField("channelId");
                try jw.write(c.channel_id);
                try jw.objectField("messageId");
                try jw.write(c.message_id);
                try jw.objectField("threadRootId");
                try jw.write(c.thread_root_id);
            },
            .dashboard => {},
        }
        try jw.endObject();
    }
};

/// What a sink reports for one frame. A connection that cannot take it right now (its kernel send
/// buffer is full) is `dropped`: that message is lost and the connection stays, which is what Bun's
/// `ws.send` does above its backpressure limit. `failed` means the connection is gone or was torn
/// down by the sink, and the registry stops sending to it.
pub const SendResult = enum { sent, dropped, failed };

pub const Sink = struct {
    ctx: *anyopaque,
    /// `frame` is a complete server frame, header included. Must not block.
    send: *const fn (ctx: *anyopaque, frame: []const u8) SendResult,
    /// Best-effort close with a status code; the connection is dead afterwards. Must not block.
    close: *const fn (ctx: *anyopaque, code: u16, reason: []const u8) void,
};

pub const opcode_text: u8 = 0x1;
pub const opcode_close: u8 = 0x8;
pub const opcode_ping: u8 = 0x9;

const header_max = 10;

/// RFC 6455 section 5.2 header of an unmasked server frame, written right-aligned into `out`;
/// returns the offset of its first byte.
fn headerBefore(out: *[header_max]u8, opcode: u8, payload_len: usize) usize {
    var at: usize = header_max;
    if (payload_len < 126) {
        at -= 1;
        out[at] = @intCast(payload_len);
    } else if (payload_len <= std.math.maxInt(u16)) {
        at -= 2;
        std.mem.writeInt(u16, out[at..][0..2], @intCast(payload_len), .big);
        at -= 1;
        out[at] = 126;
    } else {
        at -= 8;
        std.mem.writeInt(u64, out[at..][0..8], payload_len, .big);
        at -= 1;
        out[at] = 127;
    }
    at -= 1;
    out[at] = 0x80 | opcode;
    return at;
}

/// A server frame under construction: the payload is written after a reserved header gap, then the
/// header is dropped in front of it, so one buffer holds the whole frame.
pub const FrameBuilder = struct {
    out: std.Io.Writer.Allocating,

    pub fn init(gpa: std.mem.Allocator) error{OutOfMemory}!FrameBuilder {
        var out = try std.Io.Writer.Allocating.initCapacity(gpa, header_max + 256);
        errdefer out.deinit();
        out.writer.splatByteAll(0, header_max) catch return error.OutOfMemory;
        return .{ .out = out };
    }

    pub fn deinit(builder: *FrameBuilder) void {
        builder.out.deinit();
    }

    pub fn writer(builder: *FrameBuilder) *std.Io.Writer {
        return &builder.out.writer;
    }

    /// The finished frame, valid until the next write or `deinit`.
    pub fn finish(builder: *FrameBuilder, opcode: u8) []const u8 {
        const all = builder.out.written();
        var head: [header_max]u8 = undefined;
        const start = headerBefore(&head, opcode, all.len - header_max);
        const head_len = header_max - start;
        const begin = header_max - head_len;
        @memcpy(all[begin..header_max], head[start..]);
        return all[begin..];
    }
};

/// `"{"type":...}"` of `nudge` as a text frame.
pub fn nudgeFrame(builder: *FrameBuilder, nudge: Nudge) error{OutOfMemory}![]const u8 {
    nudge.writeJson(builder.writer()) catch return error.OutOfMemory;
    return builder.finish(opcode_text);
}

/// Who a connection is, as predicates see it.
pub const Info = struct {
    topic: []const u8,
    user_id: []const u8,
    session_id: []const u8,
};

pub const Spec = struct {
    topic: Topic,
    session_id: []const u8,
    user_id: []const u8,
    /// Epoch ms the session was last known to expire (`WsData.expiresAt`).
    expires_at_ms: i64,
    /// Monotonic ms of registration, the start of the idle clock.
    now_ms: i64,
    sink: Sink,
};

pub const Entry = struct {
    id: u64,
    topic: Topic,
    session_id: []u8,
    user_id: []u8,
    sink: Sink,
    /// Guarded by the registry mutex.
    expires_at_ms: i64,
    closing: bool = false,
    /// Monotonic ms of the last frame from the client; written by the reader thread without the lock.
    last_seen_ms: std.atomic.Value(i64),

    /// Any frame from the client, a pong included, counts as life.
    pub fn touch(entry: *Entry, now_ms: i64) void {
        entry.last_seen_ms.store(now_ms, .monotonic);
    }
};

pub const Expired = struct { id: u64, session_id: []const u8 };

pub const Stats = struct { connections: usize, dropped: u64, failed: u64 };

pub const Registry = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    entries: std.AutoHashMapUnmanaged(u64, *Entry) = .empty,
    next_id: u64 = 1,
    dropped: u64 = 0,
    failed: u64 = 0,

    pub fn init(gpa: std.mem.Allocator, io: std.Io) Registry {
        return .{ .gpa = gpa, .io = io };
    }

    /// Frees what is left; sinks are not closed, their owner is gone by now.
    pub fn deinit(registry: *Registry) void {
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| registry.destroy(entry.*);
        registry.entries.deinit(registry.gpa);
    }

    fn destroy(registry: *Registry, entry: *Entry) void {
        registry.gpa.free(entry.session_id);
        registry.gpa.free(entry.user_id);
        registry.gpa.destroy(entry);
    }

    fn lock(registry: *Registry) void {
        registry.mutex.lockUncancelable(registry.io);
    }

    fn unlock(registry: *Registry) void {
        registry.mutex.unlock(registry.io);
    }

    /// Registers a connection. The entry stays valid until `remove` with its id.
    pub fn add(registry: *Registry, spec: Spec) error{OutOfMemory}!*Entry {
        const session_id = try registry.gpa.dupe(u8, spec.session_id);
        errdefer registry.gpa.free(session_id);
        const user_id = try registry.gpa.dupe(u8, spec.user_id);
        errdefer registry.gpa.free(user_id);
        const entry = try registry.gpa.create(Entry);
        errdefer registry.gpa.destroy(entry);

        registry.lock();
        defer registry.unlock();
        try registry.entries.ensureUnusedCapacity(registry.gpa, 1);
        entry.* = .{
            .id = registry.next_id,
            .topic = spec.topic,
            .session_id = session_id,
            .user_id = user_id,
            .sink = spec.sink,
            .expires_at_ms = spec.expires_at_ms,
            .last_seen_ms = .init(spec.now_ms),
        };
        registry.next_id += 1;
        registry.entries.putAssumeCapacityNoClobber(entry.id, entry);
        return entry;
    }

    /// Idempotent. After it returns the sink is never called again.
    pub fn remove(registry: *Registry, id: u64) void {
        registry.lock();
        defer registry.unlock();
        const removed = registry.entries.fetchRemove(id) orelse return;
        registry.destroy(removed.value);
    }

    pub fn stats(registry: *Registry) Stats {
        registry.lock();
        defer registry.unlock();
        return .{ .connections = registry.entries.count(), .dropped = registry.dropped, .failed = registry.failed };
    }

    /// Caller holds the lock.
    fn deliver(registry: *Registry, entry: *Entry, frame: []const u8) bool {
        if (entry.closing) return false;
        switch (entry.sink.send(entry.sink.ctx, frame)) {
            .sent => return true,
            .dropped => registry.dropped += 1,
            .failed => {
                entry.closing = true;
                registry.failed += 1;
            },
        }
        return false;
    }

    /// `server.publish(topic, JSON.stringify(message))`. Returns how many connections took it.
    pub fn publish(registry: *Registry, topic: []const u8, nudge: Nudge) error{OutOfMemory}!usize {
        var builder = try FrameBuilder.init(registry.gpa);
        defer builder.deinit();
        return registry.publishFrame(topic, try nudgeFrame(&builder, nudge));
    }

    /// `publish` for a body that is already JSON.
    pub fn publishText(registry: *Registry, topic: []const u8, json: []const u8) error{OutOfMemory}!usize {
        var builder = try FrameBuilder.init(registry.gpa);
        defer builder.deinit();
        builder.writer().writeAll(json) catch return error.OutOfMemory;
        return registry.publishFrame(topic, builder.finish(opcode_text));
    }

    fn publishFrame(registry: *Registry, topic: []const u8, frame: []const u8) usize {
        registry.lock();
        defer registry.unlock();
        var delivered: usize = 0;
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| {
            if (!std.mem.eql(u8, entry.*.topic.slice(), topic)) continue;
            if (registry.deliver(entry.*, frame)) delivered += 1;
        }
        return delivered;
    }

    /// Per-socket fan-out, like the group and DM chat nudge of realtime.ts:70-75. `match` runs with
    /// the registry lock held: keep it a pure lookup.
    pub fn publishWhere(
        registry: *Registry,
        ctx: anytype,
        comptime match: fn (@TypeOf(ctx), Info) bool,
        nudge: Nudge,
    ) error{OutOfMemory}!usize {
        var builder = try FrameBuilder.init(registry.gpa);
        defer builder.deinit();
        const frame = try nudgeFrame(&builder, nudge);

        registry.lock();
        defer registry.unlock();
        var delivered: usize = 0;
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| {
            const info: Info = .{ .topic = entry.*.topic.slice(), .user_id = entry.*.user_id, .session_id = entry.*.session_id };
            if (!match(ctx, info)) continue;
            if (registry.deliver(entry.*, frame)) delivered += 1;
        }
        return delivered;
    }

    /// The distinct `org:` topics with a live connection, copied into `arena`
    /// (`wireDashboardNudges`' `orgTopics`).
    pub fn orgTopics(registry: *Registry, arena: std.mem.Allocator) error{OutOfMemory}![]const []const u8 {
        registry.lock();
        defer registry.unlock();
        var seen: std.StringHashMapUnmanaged(void) = .empty;
        var list: std.ArrayList([]const u8) = .empty;
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| {
            if (entry.*.closing or entry.*.topic.kind() != .org) continue;
            const text = entry.*.topic.slice();
            if (seen.contains(text)) continue;
            const copy = try arena.dupe(u8, text);
            try seen.put(arena, copy, {});
            try list.append(arena, copy);
        }
        return list.items;
    }

    /// `closeWhere` of realtime.ts:28: 4401 for every connection `match` accepts.
    fn closeWhere(registry: *Registry, ctx: anytype, comptime match: fn (@TypeOf(ctx), *const Entry) bool, reason: []const u8) usize {
        registry.lock();
        defer registry.unlock();
        var closed: usize = 0;
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| {
            if (entry.*.closing or !match(ctx, entry.*)) continue;
            registry.closeLocked(entry.*, close_access_ended, reason);
            closed += 1;
        }
        return closed;
    }

    fn closeLocked(_: *Registry, entry: *Entry, code: u16, reason: []const u8) void {
        entry.closing = true;
        entry.sink.close(entry.sink.ctx, code, reason);
    }

    /// `onSessionRevoked`: the session's sockets end with 4401.
    pub fn closeSession(registry: *Registry, session_id: []const u8) usize {
        const Match = struct {
            fn run(wanted: []const u8, entry: *const Entry) bool {
                return std.mem.eql(u8, entry.session_id, wanted);
            }
        };
        return registry.closeWhere(session_id, Match.run, "access ended");
    }

    /// `onMemberRemoved`: the member's socket on that org topic ends with 4401.
    pub fn closeUserOnTopic(registry: *Registry, user_id: []const u8, topic: []const u8) usize {
        const Wanted = struct { user_id: []const u8, topic: []const u8 };
        const Match = struct {
            fn run(wanted: Wanted, entry: *const Entry) bool {
                return std.mem.eql(u8, entry.user_id, wanted.user_id) and std.mem.eql(u8, entry.topic.slice(), wanted.topic);
            }
        };
        return registry.closeWhere(Wanted{ .user_id = user_id, .topic = topic }, Match.run, "access ended");
    }

    /// Every live connection gets one ping frame.
    pub fn pingAll(registry: *Registry) void {
        const frame = [_]u8{ 0x80 | opcode_ping, 0 };
        registry.lock();
        defer registry.unlock();
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| _ = registry.deliver(entry.*, &frame);
    }

    /// Closes connections that sent nothing, not even a pong, for `idle_ms`. Bun's `idleTimeout`.
    pub fn closeIdle(registry: *Registry, now_ms: i64, idle_ms: i64) usize {
        registry.lock();
        defer registry.unlock();
        var closed: usize = 0;
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| {
            if (entry.*.closing) continue;
            if (now_ms - entry.*.last_seen_ms.load(.monotonic) < idle_ms) continue;
            registry.closeLocked(entry.*, close_going_away, "idle timeout");
            closed += 1;
        }
        return closed;
    }

    /// Connections past the expiry they last saw (`sweepExpired`, realtime.ts:33). The session
    /// ids are copied into `arena`; the caller asks the database without holding any lock here.
    pub fn expiredSessions(registry: *Registry, arena: std.mem.Allocator, now_wall_ms: i64) error{OutOfMemory}![]const Expired {
        registry.lock();
        defer registry.unlock();
        var list: std.ArrayList(Expired) = .empty;
        var it = registry.entries.valueIterator();
        while (it.next()) |entry| {
            if (entry.*.closing or entry.*.expires_at_ms > now_wall_ms) continue;
            try list.append(arena, .{ .id = entry.*.id, .session_id = try arena.dupe(u8, entry.*.session_id) });
        }
        return list.items;
    }

    /// The database's answer for one expired connection: no session left closes it with 4401, a
    /// later expiry (the session slid forward) is kept. The connection may be gone by now.
    pub fn applyExpiry(registry: *Registry, id: u64, current_ms: ?i64) void {
        registry.lock();
        defer registry.unlock();
        const entry = registry.entries.get(id) orelse return;
        if (entry.closing) return;
        const expires = current_ms orelse return registry.closeLocked(entry, close_access_ended, "session expired");
        entry.expires_at_ms = expires;
    }
};

pub const close_access_ended: u16 = 4401;
pub const close_going_away: u16 = 1001;

// Tests

const testing = std.testing;

/// Records what the registry does to it.
const Fake = struct {
    frames: std.ArrayList([]u8) = .empty,
    result: SendResult = .sent,
    closed_code: ?u16 = null,
    closed_reason: [32]u8 = undefined,
    closed_reason_len: usize = 0,

    fn deinit(fake: *Fake) void {
        for (fake.frames.items) |frame| testing.allocator.free(frame);
        fake.frames.deinit(testing.allocator);
    }

    fn send(ctx: *anyopaque, frame: []const u8) SendResult {
        const fake: *Fake = @ptrCast(@alignCast(ctx));
        if (fake.result != .sent) return fake.result;
        const copy = testing.allocator.dupe(u8, frame) catch return .failed;
        fake.frames.append(testing.allocator, copy) catch {
            testing.allocator.free(copy);
            return .failed;
        };
        return .sent;
    }

    fn close(ctx: *anyopaque, code: u16, reason: []const u8) void {
        const fake: *Fake = @ptrCast(@alignCast(ctx));
        fake.closed_code = code;
        fake.closed_reason_len = @min(reason.len, fake.closed_reason.len);
        @memcpy(fake.closed_reason[0..fake.closed_reason_len], reason[0..fake.closed_reason_len]);
    }

    fn sink(fake: *Fake) Sink {
        return .{ .ctx = fake, .send = send, .close = close };
    }

    fn reasonText(fake: *const Fake) []const u8 {
        return fake.closed_reason[0..fake.closed_reason_len];
    }
};

fn repeat(comptime byte: u8, comptime n: usize) *const [n]u8 {
    const filled: [n]u8 = @splat(byte);
    return &filled;
}

const uuid_a = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const uuid_b = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

fn specFor(topic: []const u8, user: []const u8, session: []const u8, fake: *Fake) Spec {
    return .{
        .topic = Topic.parse(topic).?,
        .session_id = session,
        .user_id = user,
        .expires_at_ms = 1_000,
        .now_ms = 0,
        .sink = fake.sink(),
    };
}

test "realtime: topic regex accepts exactly the four shapes" {
    try testing.expect(Topic.parse("runs") != null);
    try testing.expect(Topic.parse("approvals") != null);
    try testing.expect(Topic.parse("run:" ++ uuid_a) != null);
    try testing.expect(Topic.parse("org:" ++ uuid_a) != null);
    // `[0-9a-f-]{36}` is a character class, not a UUID check.
    try testing.expect(Topic.parse("run:" ++ repeat('-', 36)) != null);
    try testing.expect(Topic.parse("org:" ++ repeat('0', 36)) != null);

    try testing.expect(Topic.parse("") == null);
    try testing.expect(Topic.parse("run") == null);
    try testing.expect(Topic.parse("runs ") == null);
    try testing.expect(Topic.parse("runs\n") == null);
    try testing.expect(Topic.parse("Runs") == null);
    try testing.expect(Topic.parse("approval") == null);
    try testing.expect(Topic.parse("run:" ++ uuid_a ++ "0") == null);
    try testing.expect(Topic.parse("run:" ++ uuid_a[1..]) == null);
    try testing.expect(Topic.parse("run:" ++ "A" ++ uuid_a[1..]) == null);
    try testing.expect(Topic.parse("run:" ++ "g" ++ uuid_a[1..]) == null);
    try testing.expect(Topic.parse("org:" ++ uuid_a ++ "\n") == null);
    try testing.expect(Topic.parse("runs:" ++ uuid_a) == null);
    try testing.expect(Topic.parse("job:" ++ uuid_a) == null);
    try testing.expect(Topic.parse("run;" ++ uuid_a) == null);
    try testing.expect(Topic.parse("run:" ++ "\u{e9}" ++ uuid_a[2..]) == null);
}

test "realtime: topic kinds and org ids" {
    try testing.expectEqual(Topic.Kind.runs, Topic.parse("runs").?.kind());
    try testing.expectEqual(Topic.Kind.approvals, Topic.parse("approvals").?.kind());
    const run = Topic.parse("run:" ++ uuid_a).?;
    try testing.expectEqual(Topic.Kind.run, run.kind());
    try testing.expect(run.orgId() == null);
    const org = Topic.parse("org:" ++ uuid_a).?;
    try testing.expectEqual(Topic.Kind.org, org.kind());
    try testing.expectEqualStrings(uuid_a, org.orgId().?);
}

fn encodeToString(gpa: std.mem.Allocator, nudge: Nudge) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    try nudge.writeJson(&out.writer);
    return out.toOwnedSlice();
}

test "realtime: nudge json matches JSON.stringify of the TS messages" {
    const gpa = testing.allocator;
    const cases = [_]struct { nudge: Nudge, json: []const u8 }{
        .{
            .nudge = .{ .event = .{ .run_id = "r1", .kind = "text", .ts = 1700000000123 } },
            .json = "{\"type\":\"event\",\"runId\":\"r1\",\"event\":{\"kind\":\"text\",\"ts\":1700000000123}}",
        },
        .{
            .nudge = .{ .event = .{ .run_id = "r1", .kind = "approval", .ts = null } },
            .json = "{\"type\":\"event\",\"runId\":\"r1\",\"event\":{\"kind\":\"approval\",\"ts\":null}}",
        },
        .{
            .nudge = .{ .run = .{ .view_json = "{\"id\":\"r1\",\"status\":\"running\"}" } },
            .json = "{\"type\":\"run\",\"run\":{\"id\":\"r1\",\"status\":\"running\"}}",
        },
        .{
            .nudge = .{ .approval = .{ .view_json = "{\"id\":\"a1\"}" } },
            .json = "{\"type\":\"approval\",\"approval\":{\"id\":\"a1\"}}",
        },
        .{
            .nudge = .{ .task = .{ .project_id = "p", .task_id = "t", .kind = "moved" } },
            .json = "{\"type\":\"task\",\"projectId\":\"p\",\"taskId\":\"t\",\"kind\":\"moved\"}",
        },
        .{
            .nudge = .{ .chat = .{ .channel_id = "c", .message_id = "m", .thread_root_id = null } },
            .json = "{\"type\":\"chat\",\"channelId\":\"c\",\"messageId\":\"m\",\"threadRootId\":null}",
        },
        .{
            .nudge = .{ .chat = .{ .channel_id = "c", .message_id = "m", .thread_root_id = "root \"q\"" } },
            .json = "{\"type\":\"chat\",\"channelId\":\"c\",\"messageId\":\"m\",\"threadRootId\":\"root \\\"q\\\"\"}",
        },
        .{ .nudge = .dashboard, .json = "{\"type\":\"dashboard\"}" },
    };
    for (cases) |case| {
        const text = try encodeToString(gpa, case.nudge);
        defer gpa.free(text);
        try testing.expectEqualStrings(case.json, text);
    }
}

test "realtime: frame headers use the 7, 16 and 64 bit length forms" {
    const gpa = testing.allocator;
    const lengths = [_]usize{ 0, 1, 125, 126, 1024, 65535, 65536 };
    for (lengths) |len| {
        var builder = try FrameBuilder.init(gpa);
        defer builder.deinit();
        try builder.writer().splatByteAll('x', len);
        const frame = builder.finish(opcode_text);
        try testing.expectEqual(@as(u8, 0x81), frame[0]);
        const header_len: usize = if (len < 126) 2 else if (len <= 65535) 4 else 10;
        try testing.expectEqual(header_len + len, frame.len);
        switch (header_len) {
            2 => try testing.expectEqual(@as(u8, @intCast(len)), frame[1]),
            4 => {
                try testing.expectEqual(@as(u8, 126), frame[1]);
                try testing.expectEqual(@as(u16, @intCast(len)), std.mem.readInt(u16, frame[2..4], .big));
            },
            else => {
                try testing.expectEqual(@as(u8, 127), frame[1]);
                try testing.expectEqual(@as(u64, len), std.mem.readInt(u64, frame[2..10], .big));
            },
        }
    }
}

test "realtime: publish reaches the topic's connections only" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();
    var runs: Fake = .{};
    defer runs.deinit();
    var run_a: Fake = .{};
    defer run_a.deinit();
    var run_b: Fake = .{};
    defer run_b.deinit();
    _ = try registry.add(specFor("runs", "u1", "s1", &runs));
    _ = try registry.add(specFor("run:" ++ uuid_a, "u1", "s1", &run_a));
    _ = try registry.add(specFor("run:" ++ uuid_b, "u1", "s1", &run_b));

    const delivered = try registry.publish("run:" ++ uuid_a, .{ .event = .{ .run_id = uuid_a, .kind = "text", .ts = 5 } });
    try testing.expectEqual(@as(usize, 1), delivered);
    try testing.expectEqual(@as(usize, 1), run_a.frames.items.len);
    try testing.expectEqual(@as(usize, 0), run_b.frames.items.len);
    try testing.expectEqual(@as(usize, 0), runs.frames.items.len);
    const frame = run_a.frames.items[0];
    try testing.expectEqual(@as(u8, 0x81), frame[0]);
    try testing.expectEqual(@as(usize, frame[1]), frame.len - 2);
    try testing.expect(std.mem.startsWith(u8, frame[2..], "{\"type\":\"event\""));

    try testing.expectEqual(@as(usize, 0), try registry.publishText("approvals", "{}"));
    try testing.expectEqual(@as(usize, 1), try registry.publishText("runs", "{\"type\":\"dashboard\"}"));
}

test "realtime: a dropped frame keeps the connection, a failed one stops further sends" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();
    var slow: Fake = .{ .result = .dropped };
    defer slow.deinit();
    var broken: Fake = .{ .result = .failed };
    defer broken.deinit();
    var healthy: Fake = .{};
    defer healthy.deinit();
    for ([_]*Fake{ &slow, &broken, &healthy }) |fake| _ = try registry.add(specFor("runs", "u", "s", fake));

    try testing.expectEqual(@as(usize, 1), try registry.publish("runs", .dashboard));
    try testing.expectEqual(@as(usize, 1), try registry.publish("runs", .dashboard));
    try testing.expectEqual(@as(usize, 2), healthy.frames.items.len);
    const stats = registry.stats();
    try testing.expectEqual(@as(u64, 2), stats.dropped);
    try testing.expectEqual(@as(u64, 1), stats.failed);
    try testing.expectEqual(@as(usize, 3), stats.connections);
}

test "realtime: publishWhere fans out per user and ignores other topics" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();
    var alice: Fake = .{};
    defer alice.deinit();
    var bob: Fake = .{};
    defer bob.deinit();
    var run_topic: Fake = .{};
    defer run_topic.deinit();
    _ = try registry.add(specFor("org:" ++ uuid_a, "alice", "s1", &alice));
    _ = try registry.add(specFor("org:" ++ uuid_b, "bob", "s2", &bob));
    _ = try registry.add(specFor("run:" ++ uuid_a, "alice", "s3", &run_topic));

    const Members = struct {
        fn match(members: []const []const u8, info: Info) bool {
            if (!std.mem.startsWith(u8, info.topic, "org:")) return false;
            for (members) |member| if (std.mem.eql(u8, member, info.user_id)) return true;
            return false;
        }
    };
    const members = [_][]const u8{"alice"};
    const nudge: Nudge = .{ .chat = .{ .channel_id = "c", .message_id = "m", .thread_root_id = null } };
    try testing.expectEqual(@as(usize, 1), try registry.publishWhere(@as([]const []const u8, &members), Members.match, nudge));
    try testing.expectEqual(@as(usize, 1), alice.frames.items.len);
    try testing.expectEqual(@as(usize, 0), bob.frames.items.len);
    try testing.expectEqual(@as(usize, 0), run_topic.frames.items.len);
}

test "realtime: orgTopics lists each org topic once" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var registry = Registry.init(testing.allocator, testing.io);
    defer registry.deinit();
    var fakes: [4]Fake = @splat(.{});
    defer for (&fakes) |*fake| fake.deinit();
    _ = try registry.add(specFor("org:" ++ uuid_a, "u1", "s1", &fakes[0]));
    _ = try registry.add(specFor("org:" ++ uuid_a, "u2", "s2", &fakes[1]));
    _ = try registry.add(specFor("org:" ++ uuid_b, "u3", "s3", &fakes[2]));
    _ = try registry.add(specFor("runs", "u4", "s4", &fakes[3]));
    const topics = try registry.orgTopics(arena.allocator());
    try testing.expectEqual(@as(usize, 2), topics.len);
}

test "realtime: revoking a session closes its sockets with 4401" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();
    var mine: Fake = .{};
    defer mine.deinit();
    var other: Fake = .{};
    defer other.deinit();
    _ = try registry.add(specFor("runs", "u1", "s1", &mine));
    _ = try registry.add(specFor("runs", "u2", "s2", &other));

    try testing.expectEqual(@as(usize, 1), registry.closeSession("s1"));
    try testing.expectEqual(@as(?u16, 4401), mine.closed_code);
    try testing.expectEqualStrings("access ended", mine.reasonText());
    try testing.expectEqual(@as(?u16, null), other.closed_code);
    // A closing connection is not closed twice and gets no more frames.
    try testing.expectEqual(@as(usize, 0), registry.closeSession("s1"));
    try testing.expectEqual(@as(usize, 1), try registry.publish("runs", .dashboard));
    try testing.expectEqual(@as(usize, 0), mine.frames.items.len);
}

test "realtime: removing a member closes only their socket on that org topic" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();
    var same_org: Fake = .{};
    defer same_org.deinit();
    var other_org: Fake = .{};
    defer other_org.deinit();
    var other_user: Fake = .{};
    defer other_user.deinit();
    _ = try registry.add(specFor("org:" ++ uuid_a, "u1", "s1", &same_org));
    _ = try registry.add(specFor("org:" ++ uuid_b, "u1", "s1", &other_org));
    _ = try registry.add(specFor("org:" ++ uuid_a, "u2", "s2", &other_user));

    try testing.expectEqual(@as(usize, 1), registry.closeUserOnTopic("u1", "org:" ++ uuid_a));
    try testing.expectEqual(@as(?u16, 4401), same_org.closed_code);
    try testing.expectEqual(@as(?u16, null), other_org.closed_code);
    try testing.expectEqual(@as(?u16, null), other_user.closed_code);
}

test "realtime: idle connections close, touched ones stay, pings reach everyone" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();
    var quiet: Fake = .{};
    defer quiet.deinit();
    var chatty: Fake = .{};
    defer chatty.deinit();
    _ = try registry.add(specFor("runs", "u1", "s1", &quiet));
    const alive = try registry.add(specFor("runs", "u2", "s2", &chatty));

    registry.pingAll();
    try testing.expectEqualSlices(u8, &.{ 0x89, 0 }, quiet.frames.items[0]);
    try testing.expectEqualSlices(u8, &.{ 0x89, 0 }, chatty.frames.items[0]);

    alive.touch(100_000);
    try testing.expectEqual(@as(usize, 1), registry.closeIdle(120_000, 120_000));
    try testing.expectEqual(@as(?u16, 1001), quiet.closed_code);
    try testing.expectEqual(@as(?u16, null), chatty.closed_code);
    try testing.expectEqual(@as(usize, 0), registry.closeIdle(120_001, 120_000));
}

test "realtime: expiry sweep closes a lapsed session and keeps a slid one" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var registry = Registry.init(testing.allocator, testing.io);
    defer registry.deinit();
    var lapsed: Fake = .{};
    defer lapsed.deinit();
    var slid: Fake = .{};
    defer slid.deinit();
    var fresh: Fake = .{};
    defer fresh.deinit();
    _ = try registry.add(specFor("runs", "u1", "s-lapsed", &lapsed));
    _ = try registry.add(specFor("runs", "u2", "s-slid", &slid));
    var later = specFor("runs", "u3", "s-fresh", &fresh);
    later.expires_at_ms = 5_000;
    _ = try registry.add(later);

    const due = try registry.expiredSessions(arena.allocator(), 2_000);
    try testing.expectEqual(@as(usize, 2), due.len);
    for (due) |item| {
        const current: ?i64 = if (std.mem.eql(u8, item.session_id, "s-slid")) 9_000 else null;
        registry.applyExpiry(item.id, current);
    }
    try testing.expectEqual(@as(?u16, 4401), lapsed.closed_code);
    try testing.expectEqualStrings("session expired", lapsed.reasonText());
    try testing.expectEqual(@as(?u16, null), slid.closed_code);
    try testing.expectEqual(@as(?u16, null), fresh.closed_code);
    // The slid session is not due again until its new expiry.
    try testing.expectEqual(@as(usize, 0), (try registry.expiredSessions(arena.allocator(), 3_000)).len);
    // An id that disconnected meanwhile is ignored.
    registry.applyExpiry(9999, null);
}

test "realtime: add, publish and sweep survive every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn run(gpa: std.mem.Allocator) !void {
            var registry = Registry.init(gpa, testing.io);
            defer registry.deinit();
            var fake: Fake = .{};
            defer fake.deinit();
            const entry = registry.add(specFor("org:" ++ uuid_a, "u1", "s1", &fake)) catch |err| return err;
            _ = try registry.publish("org:" ++ uuid_a, .{ .task = .{ .project_id = "p", .task_id = "t", .kind = "k" } });
            _ = try registry.publishText("org:" ++ uuid_a, "{}");
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            _ = try registry.orgTopics(arena.allocator());
            _ = try registry.expiredSessions(arena.allocator(), 2_000);
            registry.remove(entry.id);
        }
    }.run, .{});
}

/// Counts sends and notices one that arrives after `remove` returned.
const Probe = struct {
    sends: std.atomic.Value(u64) = .init(0),
    removed: std.atomic.Value(bool) = .init(false),
    after_remove: std.atomic.Value(u64) = .init(0),

    fn send(ctx: *anyopaque, _: []const u8) SendResult {
        const probe: *Probe = @ptrCast(@alignCast(ctx));
        _ = probe.sends.fetchAdd(1, .monotonic);
        if (probe.removed.load(.acquire)) _ = probe.after_remove.fetchAdd(1, .monotonic);
        return .sent;
    }

    fn close(_: *anyopaque, _: u16, _: []const u8) void {}
};

test "realtime: many publishers racing connects and disconnects never reach a removed sink" {
    const gpa = testing.allocator;
    var registry = Registry.init(gpa, testing.io);
    defer registry.deinit();

    const Worker = struct {
        fn publisher(reg: *Registry, stop: *std.atomic.Value(bool)) void {
            while (!stop.load(.acquire)) {
                _ = reg.publish("runs", .dashboard) catch return;
                _ = reg.publishText("runs", "{}") catch return;
            }
        }
        fn churn(reg: *Registry, rounds: usize, violations: *std.atomic.Value(u64)) void {
            for (0..rounds) |_| {
                var probe: Probe = .{};
                const entry = reg.add(.{
                    .topic = Topic.parse("runs").?,
                    .session_id = "s",
                    .user_id = "u",
                    .expires_at_ms = 0,
                    .now_ms = 0,
                    .sink = .{ .ctx = &probe, .send = Probe.send, .close = Probe.close },
                }) catch return;
                std.atomic.spinLoopHint();
                reg.remove(entry.id);
                probe.removed.store(true, .release);
                // The probe's stack slot dies here; a late send would read garbage or be caught below.
                std.atomic.spinLoopHint();
                _ = violations.fetchAdd(probe.after_remove.load(.acquire), .monotonic);
            }
        }
    };

    var stop: std.atomic.Value(bool) = .init(false);
    var violations: std.atomic.Value(u64) = .init(0);
    var publishers: [3]std.Thread = undefined;
    for (&publishers) |*thread| thread.* = try std.Thread.spawn(.{}, Worker.publisher, .{ &registry, &stop });
    var churners: [3]std.Thread = undefined;
    for (&churners) |*thread| thread.* = try std.Thread.spawn(.{}, Worker.churn, .{ &registry, 300, &violations });
    for (churners) |thread| thread.join();
    stop.store(true, .release);
    for (publishers) |thread| thread.join();

    try testing.expectEqual(@as(u64, 0), violations.load(.acquire));
    try testing.expectEqual(@as(usize, 0), registry.stats().connections);
}
