//! Port of code/src/server/features/usage/claude-tail.ts, plus the JS-flavoured helpers the codex
//! parser shares (`num`, `asObj`, `Date.parse` of an ISO timestamp).
const std = @import("std");
const types = @import("../runtimes/types.zig");
const json = @import("../json.zig");
const quota = @import("quota.zig");

pub const LineContext = struct {
    /// Full path of the log file; the codex dedupe key embeds it.
    file: []const u8,
    session_id: []const u8,
};

pub const ParsedLine = struct {
    event: ?types.NewEvent = null,
    quota_buf: [2]quota.QuotaInput = undefined,
    quota_len: u8 = 0,

    pub fn quotas(self: *const ParsedLine) []const quota.QuotaInput {
        return self.quota_buf[0..self.quota_len];
    }
};

pub const Object = std.json.ObjectMap;
pub const Value = std.json.Value;

/// `num` of claude-tail.ts: a finite JS number, else 0.
pub fn num(v: ?Value) f64 {
    const value = v orelse return 0;
    return switch (value) {
        .integer => |i| @floatFromInt(i),
        .float => |f| if (std.math.isFinite(f)) f else 0,
        .number_string => |s| blk: {
            const f = std.fmt.parseFloat(f64, s) catch break :blk 0;
            break :blk if (std.math.isFinite(f)) f else 0;
        },
        else => 0,
    };
}

/// A JS number held in an INTEGER column: whole tokens. Fractions are dropped, which the logs
/// never contain.
pub fn count(v: ?Value) i64 {
    return std.math.lossyCast(i64, num(v));
}

pub fn asObj(v: ?Value) ?Object {
    const value = v orelse return null;
    return switch (value) {
        .object => |o| o,
        else => null,
    };
}

pub fn field(o: ?Object, key: []const u8) ?Value {
    return (o orelse return null).get(key);
}

pub fn asString(v: ?Value) ?[]const u8 {
    const value = v orelse return null;
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

fn daysFromCivil(year: i64, month: i64, day: i64) i64 {
    const y = if (month <= 2) year - 1 else year;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const mp = @mod(month + 9, 12);
    const doy = @divFloor(153 * mp + 2, 5) + day - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

fn digits(s: []const u8, at: *usize, n: usize) ?i64 {
    if (at.* + n > s.len) return null;
    var v: i64 = 0;
    for (s[at.*..][0..n]) |ch| {
        if (ch < '0' or ch > '9') return null;
        v = v * 10 + (ch - '0');
    }
    at.* += n;
    return v;
}

fn expect(s: []const u8, at: *usize, ch: u8) bool {
    if (at.* >= s.len or s[at.*] != ch) return false;
    at.* += 1;
    return true;
}

/// `Date.parse` for the ISO 8601 forms the agent CLIs write: `YYYY-MM-DD`, optionally followed by
/// `THH:mm[:ss[.fff]]` and `Z` or `+hh:mm`. Null is NaN. JS reads a date-time without an offset as
/// local time; this reads it as UTC, as the server runs on one. The extra digits of a long
/// fraction are cut, as JS does.
pub fn parseIsoMs(s: []const u8) ?i64 {
    var at: usize = 0;
    const year = digits(s, &at, 4) orelse return null;
    if (!expect(s, &at, '-')) return null;
    const month = digits(s, &at, 2) orelse return null;
    if (!expect(s, &at, '-')) return null;
    const day = digits(s, &at, 2) orelse return null;
    if (month < 1 or month > 12 or day < 1) return null;
    const leap = @rem(year, 4) == 0 and (@rem(year, 100) != 0 or @rem(year, 400) == 0);
    const dim = [_]i64{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day > dim[@intCast(month - 1)]) return null;
    var hour: i64 = 0;
    var minute: i64 = 0;
    var second: i64 = 0;
    var millis: i64 = 0;
    var offset_min: i64 = 0;
    if (at < s.len) {
        if (!expect(s, &at, 'T')) return null;
        hour = digits(s, &at, 2) orelse return null;
        if (!expect(s, &at, ':')) return null;
        minute = digits(s, &at, 2) orelse return null;
        if (expect(s, &at, ':')) {
            second = digits(s, &at, 2) orelse return null;
            if (expect(s, &at, '.')) {
                var n: usize = 0;
                while (at < s.len and s[at] >= '0' and s[at] <= '9') : (at += 1) {
                    if (n < 3) millis = millis * 10 + (s[at] - '0');
                    n += 1;
                }
                if (n == 0) return null;
                while (n < 3) : (n += 1) millis *= 10;
            }
        }
        if (hour > 24 or minute > 59 or second > 59) return null;
        if (hour == 24 and (minute != 0 or second != 0 or millis != 0)) return null;
        if (at < s.len) {
            if (expect(s, &at, 'Z')) {} else {
                const sign: i64 = if (s[at] == '+') 1 else if (s[at] == '-') -1 else return null;
                at += 1;
                const oh = digits(s, &at, 2) orelse return null;
                if (!expect(s, &at, ':')) return null;
                const om = digits(s, &at, 2) orelse return null;
                if (oh > 23 or om > 59) return null;
                offset_min = sign * (oh * 60 + om);
            }
        }
        if (at != s.len) return null;
    }
    const days = daysFromCivil(year, month, day);
    const seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_min * 60;
    return seconds * 1000 + millis;
}

/// Parses one log line to a JSON value in `arena`; null when it is not JSON.
pub fn parseJson(arena: std.mem.Allocator, line: []const u8) ?Value {
    return std.json.parseFromSliceLeaky(Value, arena, line, json.parse_options) catch null;
}

/// `parseClaudeLine`. Everything the result points at lives in `arena`.
pub fn parseClaudeLine(arena: std.mem.Allocator, line: []const u8, _: u64, ctx: LineContext) std.mem.Allocator.Error!ParsedLine {
    const raw = parseJson(arena, line) orelse return .{};
    const top = asObj(raw) orelse return .{};
    const message = asObj(top.get("message")) orelse return .{};
    const usage = asObj(message.get("usage")) orelse return .{};
    const id = asString(message.get("id")) orelse return .{};
    const ts: ?i64 = if (asString(top.get("timestamp"))) |t| parseIsoMs(t) else null;
    const details = asObj(usage.get("output_tokens_details"));
    return .{ .event = .{
        .kind = .usage,
        .agent = "claude",
        .operation = "chat",
        .conversation_id = ctx.session_id,
        .input_tokens = count(usage.get("input_tokens")),
        .output_tokens = count(usage.get("output_tokens")),
        .cache_read_tokens = count(usage.get("cache_read_input_tokens")),
        .cache_write_tokens = count(usage.get("cache_creation_input_tokens")),
        .reasoning_tokens = count(field(details, "thinking_tokens")),
        .source = "tail",
        .dedupe_key = try std.fmt.allocPrint(arena, "claude:{s}", .{id}),
        .model = asString(message.get("model")),
        .ts = ts,
    } };
}

const testing = std.testing;

test "usage: iso timestamps parse like Date.parse" {
    try testing.expectEqual(@as(?i64, 1_793_581_200_000), parseIsoMs("2026-11-02T01:00:00.000Z"));
    try testing.expectEqual(@as(?i64, 1_793_581_200_000), parseIsoMs("2026-11-02T01:00:00Z"));
    try testing.expectEqual(@as(?i64, 1_793_581_200_123), parseIsoMs("2026-11-02T01:00:00.1239Z"));
    try testing.expectEqual(@as(?i64, 1_793_581_200_100), parseIsoMs("2026-11-02T01:00:00.1Z"));
    try testing.expectEqual(@as(?i64, 1_793_581_200_000), parseIsoMs("2026-11-02T03:00:00+02:00"));
    try testing.expectEqual(@as(?i64, 1_793_577_600_000), parseIsoMs("2026-11-02"));
    try testing.expectEqual(@as(?i64, 951_782_400_000), parseIsoMs("2000-02-29"));
    try testing.expectEqual(@as(?i64, null), parseIsoMs("2026-02-29"));
    try testing.expectEqual(@as(?i64, null), parseIsoMs("yesterday"));
    try testing.expectEqual(@as(?i64, null), parseIsoMs(""));
    try testing.expectEqual(@as(?i64, null), parseIsoMs("2026-11-02T25:00:00Z"));
    try testing.expectEqual(@as(?i64, null), parseIsoMs("2026-11-02T01:00:00Zjunk"));
}

fn parse(arena: std.mem.Allocator, line: []const u8) !ParsedLine {
    return parseClaudeLine(arena, line, 0, .{ .file = "/f.jsonl", .session_id = "sess" });
}

test "usage: a claude line becomes one usage event" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const p = try parse(arena.allocator(),
        \\{"type":"assistant","timestamp":"2026-11-02T01:00:00.000Z","message":{"id":"msg_1","model":"model-a","usage":{"input_tokens":3,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":7,"output_tokens_details":{"thinking_tokens":4}}}}
    );
    const e = p.event.?;
    try testing.expectEqualStrings("claude", e.agent.?);
    try testing.expectEqualStrings("model-a", e.model.?);
    try testing.expectEqualStrings("sess", e.conversation_id.?);
    try testing.expectEqualStrings("claude:msg_1", e.dedupe_key.?);
    try testing.expectEqual(@as(i64, 3), e.input_tokens.?);
    try testing.expectEqual(@as(i64, 10), e.output_tokens.?);
    try testing.expectEqual(@as(i64, 100), e.cache_read_tokens.?);
    try testing.expectEqual(@as(i64, 7), e.cache_write_tokens.?);
    try testing.expectEqual(@as(i64, 4), e.reasoning_tokens.?);
    try testing.expectEqual(@as(i64, 1_793_581_200_000), e.ts.?);
    try testing.expectEqual(@as(usize, 0), p.quotas().len);
}

test "usage: claude lines without usage, id or valid json give nothing" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_][]const u8{
        "not json",
        "[1,2]",
        "{}",
        \\{"message":{"id":"m"}}
        ,
        \\{"message":{"usage":{"input_tokens":1}}}
        ,
        \\{"message":{"id":5,"usage":{}}}
        ,
        \\{"message":{"id":"m","usage":[]}}
        ,
    };
    for (cases) |line| try testing.expect((try parse(arena.allocator(), line)).event == null);
}

test "usage: a duplicate key keeps the last value, as JSON.parse does" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const p = try parse(arena.allocator(),
        \\{"message":{"id":"m","usage":{"input_tokens":1,"input_tokens":9}}}
    );
    try testing.expectEqual(@as(i64, 9), p.event.?.input_tokens.?);
}

test "usage: a claude line with odd fields keeps what is valid" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const p = try parse(arena.allocator(),
        \\{"timestamp":"nope","message":{"id":"m","model":7,"usage":{"input_tokens":"3","output_tokens":null,"cache_read_input_tokens":2.0}}}
    );
    const e = p.event.?;
    try testing.expect(e.model == null and e.ts == null);
    try testing.expectEqual(@as(i64, 0), e.input_tokens.?);
    try testing.expectEqual(@as(i64, 0), e.output_tokens.?);
    try testing.expectEqual(@as(i64, 2), e.cache_read_tokens.?);
}
