//! Port of code/src/server/features/usage/codex-tail.ts.
const std = @import("std");
const log = @import("claude_log.zig");
const quota = @import("quota.zig");

fn windowQuota(name: []const u8, w: ?log.Value, ts: ?i64) ?quota.QuotaInput {
    const o = log.asObj(w) orelse return null;
    const used = o.get("used_percent") orelse return null;
    const percent: f64 = switch (used) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => return null,
    };
    // Codex writes epoch seconds; the harness stores epoch ms.
    const resets: ?i64 = if (o.get("resets_at")) |r| switch (r) {
        .integer => |i| std.math.mul(i64, i, 1000) catch null,
        .float => |f| std.math.lossyCast(i64, f * 1000),
        else => null,
    } else null;
    return .{ .provider = "codex", .window = name, .used_percent = percent, .resets_at = resets, .source = "tail", .ts = ts };
}

/// `parseCodexLine`. Everything the result points at lives in `arena`.
pub fn parseCodexLine(arena: std.mem.Allocator, line: []const u8, offset: u64, ctx: log.LineContext) std.mem.Allocator.Error!log.ParsedLine {
    const raw = log.parseJson(arena, line) orelse return .{};
    const top = log.asObj(raw) orelse return .{};
    const payload = log.asObj(top.get("payload"));
    const top_type = log.asString(top.get("type")) orelse return .{};
    const payload_type = log.asString(log.field(payload, "type")) orelse return .{};
    if (!std.mem.eql(u8, top_type, "event_msg") or !std.mem.eql(u8, payload_type, "token_count")) return .{};
    const ts: ?i64 = if (log.asString(top.get("timestamp"))) |t| log.parseIsoMs(t) else null;
    var out: log.ParsedLine = .{};
    const limits = log.asObj(log.field(payload, "rate_limits"));
    inline for (.{ "primary", "secondary" }) |name| {
        if (windowQuota(name, log.field(limits, name), ts)) |q| {
            out.quota_buf[out.quota_len] = q;
            out.quota_len += 1;
        }
    }
    const info = log.asObj(log.field(payload, "info"));
    const last = log.asObj(log.field(info, "last_token_usage")) orelse return out;
    const cached = log.count(last.get("cached_input_tokens"));
    out.event = .{
        .kind = .usage,
        .agent = "codex",
        .operation = "chat",
        .conversation_id = ctx.session_id,
        // Codex counts cached tokens inside input_tokens; split them so the sum is not doubled.
        .input_tokens = @max(0, log.count(last.get("input_tokens")) -| cached),
        .output_tokens = log.count(last.get("output_tokens")),
        .cache_read_tokens = cached,
        .cache_write_tokens = log.count(last.get("cache_write_input_tokens")),
        .reasoning_tokens = log.count(last.get("reasoning_output_tokens")),
        .source = "tail",
        .dedupe_key = try std.fmt.allocPrint(arena, "codex:{s}:{d}", .{ ctx.file, offset }),
        .ts = ts,
    };
    return out;
}

const testing = std.testing;

fn parse(arena: std.mem.Allocator, line: []const u8) !log.ParsedLine {
    return parseCodexLine(arena, line, 42, .{ .file = "/r/rollout-x.jsonl", .session_id = "sess" });
}

test "usage: a codex token_count gives an event and two quota snapshots" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const p = try parse(arena.allocator(),
        \\{"timestamp":"2026-11-02T01:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"cached_input_tokens":20,"output_tokens":9,"reasoning_output_tokens":4}},"rate_limits":{"primary":{"used_percent":42,"window_minutes":300,"resets_at":4102444800},"secondary":{"used_percent":5,"window_minutes":10080,"resets_at":4102448400}}}}
    );
    const e = p.event.?;
    try testing.expectEqual(@as(i64, 30), e.input_tokens.?);
    try testing.expectEqual(@as(i64, 20), e.cache_read_tokens.?);
    try testing.expectEqual(@as(i64, 9), e.output_tokens.?);
    try testing.expectEqual(@as(i64, 4), e.reasoning_tokens.?);
    try testing.expectEqual(@as(i64, 0), e.cache_write_tokens.?);
    try testing.expectEqualStrings("codex:/r/rollout-x.jsonl:42", e.dedupe_key.?);
    try testing.expectEqual(@as(usize, 2), p.quotas().len);
    try testing.expectEqualStrings("primary", p.quotas()[0].window);
    try testing.expectEqual(@as(f64, 42), p.quotas()[0].used_percent.?);
    try testing.expectEqual(@as(i64, 4102444800000), p.quotas()[0].resets_at.?);
    try testing.expectEqual(@as(i64, 1_793_581_200_000), p.quotas()[1].ts.?);
}

test "usage: a token_count without info only snapshots, cached above input floors at zero" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const bare = try parse(arena.allocator(),
        \\{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":43}}}}
    );
    try testing.expect(bare.event == null);
    try testing.expectEqual(@as(usize, 1), bare.quotas().len);
    try testing.expect(bare.quotas()[0].resets_at == null and bare.quotas()[0].ts == null);
    const floored = try parse(arena.allocator(),
        \\{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"cached_input_tokens":9}}}}
    );
    try testing.expectEqual(@as(i64, 0), floored.event.?.input_tokens.?);
}

test "usage: other codex lines give nothing" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_][]const u8{
        "garbage",
        "{}",
        \\{"type":"response_item","payload":{"type":"token_count"}}
        ,
        \\{"type":"event_msg","payload":{"type":"agent_message"}}
        ,
        \\{"type":"event_msg"}
        ,
    };
    for (cases) |line| {
        const p = try parse(arena.allocator(), line);
        try testing.expect(p.event == null and p.quotas().len == 0);
    }
}
