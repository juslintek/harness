//! Process-level tests of the ACP lane against scripts/fake-acp-agent.ts, the Zig counterparts of
//! acp.test.ts and acp-hardening.test.ts. They need bun on PATH and run from zig/.
const std = @import("std");
const acp = @import("acp.zig");
const types = @import("types.zig");
const kit = @import("testkit.zig");
const process = @import("process.zig");

const Io = std.Io;
const testing = std.testing;

const Driven = struct {
    fake: *kit.Fake,
    rec: *kit.Recorder,
    outcome: types.Outcome,

    fn deinit(d: *Driven) void {
        d.outcome.deinit();
        d.rec.deinit();
        testing.allocator.destroy(d.rec);
        d.fake.deinit();
    }

    fn methods(d: *Driven) ![]u8 {
        return d.fake.receivedMethods(testing.io);
    }
};

const Options = struct {
    mode: kit.DecideMode = .deny,
    decide_timeout_ms: i64 = 15 * 60_000,
    idle_timeout_ms: i64 = 10_000,
    fail_emit_on: ?types.EventKind = null,
    abort_on: ?types.EventKind = null,
    fail_spawn_hook: bool = false,
    fail_progress: bool = false,
    no_mode: bool = false,
    model: ?[]const u8 = null,
    mcp: bool = false,
    claude_meta: bool = false,
    max_line: usize = 32 * 1024 * 1024,
};

fn drive(script: []const u8, options: Options) !Driven {
    const gpa = testing.allocator;
    const io = testing.io;
    const fake = try kit.Fake.init(gpa, io, script);
    errdefer fake.deinit();
    const rec = try gpa.create(kit.Recorder);
    errdefer gpa.destroy(rec);
    rec.* = kit.Recorder.init(gpa, io);
    errdefer rec.deinit();
    rec.mode = options.mode;
    rec.fail_emit_on = options.fail_emit_on;
    rec.fail_spawn_hook = options.fail_spawn_hook;
    rec.fail_progress = options.fail_progress;
    var abort: Io.Event = .unset;
    rec.abort_on = options.abort_on;
    rec.abort_event = &abort;
    var cfg = fake.config("fake");
    cfg.idle_timeout_ms = options.idle_timeout_ms;
    cfg.decide_timeout_ms = options.decide_timeout_ms;
    cfg.model = options.model;
    cfg.max_line = options.max_line;
    cfg.spec.claude_meta = options.claude_meta;
    if (options.no_mode) cfg.spec.mode_option = null;
    if (options.mcp) cfg.mcp = .{ .url = "http://127.0.0.1:1/mcp", .token = "tok" };
    const hooks = rec.hooks();
    const outcome = try acp.execute(gpa, io, cfg, &hooks, &abort);
    return .{ .fake = fake, .rec = rec, .outcome = outcome };
}

fn expectGone(d: *Driven) !void {
    const pid = try d.fake.agentPid(testing.io);
    try testing.expect(!process.pidExists(pid));
    try testing.expect(!process.groupExists(pid));
}

test "acp: say and usage end the turn with one usage record" {
    var d = try drive(
        \\[{"say":"hello"},{"usage":{"inputTokens":4,"outputTokens":78,"cachedReadTokens":9,"cachedWriteTokens":121442,"costUsd":0.25}}]
    , .{});
    defer d.deinit();
    try testing.expectEqual(types.StopReason.end_turn, d.outcome.stop_reason);
    try testing.expectEqualStrings("hello", d.outcome.text);
    try testing.expectEqualStrings("fake-session", d.outcome.session_id.?);
    try testing.expect(d.outcome.error_text == null);
    try testing.expectEqual(@as(usize, 1), d.outcome.usage.len);
    const row = d.outcome.usage[0];
    try testing.expectEqual(@as(i64, 4), row.input_tokens);
    try testing.expectEqual(@as(i64, 78), row.output_tokens);
    try testing.expectEqual(@as(i64, 9), row.cache_read_tokens);
    try testing.expectEqual(@as(i64, 121442), row.cache_write_tokens);
    try testing.expectEqual(@as(f64, 0.25), row.reported_cost_usd.?);
    const said = try d.rec.said(testing.allocator);
    defer testing.allocator.free(said);
    try testing.expectEqualStrings("hello", said);
    try expectGone(&d);
}

test "acp: a turn without usage yields no records" {
    var d = try drive("[{\"say\":\"x\"}]", .{});
    defer d.deinit();
    try testing.expectEqual(@as(usize, 0), d.outcome.usage.len);
}

test "acp: the conversation is initialize, session/new, the mode, then the prompt" {
    var d = try drive("[]", .{});
    defer d.deinit();
    const methods = try d.methods();
    defer testing.allocator.free(methods);
    try testing.expectEqualStrings("initialize\nsession/new\nsession/set_config_option\nsession/prompt\n", methods);
}

test "acp: deny picks the reject option and allow picks allow_once" {
    var denied = try drive("[{\"ask\":{\"command\":\"rm -rf x\"}}]", .{ .mode = .deny });
    defer denied.deinit();
    try testing.expectEqualStrings("permission selected reject", denied.outcome.text);
    try testing.expectEqualStrings("deny reject", denied.rec.firstOf(.permission).?.body);
    try testing.expectEqualStrings("rm -rf x", denied.rec.firstOf(.permission).?.command.?);

    var allowed = try drive("[{\"ask\":{\"command\":\"ls\"}}]", .{ .mode = .allow });
    defer allowed.deinit();
    try testing.expectEqualStrings("permission selected allow-once", allowed.outcome.text);
}

test "acp: codex options are chosen by kind" {
    var d = try drive("[{\"ask\":{\"command\":\"ls\",\"options\":\"codex\"}}]", .{ .mode = .deny });
    defer d.deinit();
    try testing.expectEqualStrings("permission selected cancel", d.outcome.text);
}

test "acp: allow_always alone is answered with reject and logged as an error" {
    var d = try drive("[{\"ask\":{\"command\":\"ls\",\"options\":\"always-only\"}}]", .{ .mode = .allow });
    defer d.deinit();
    try testing.expectEqualStrings("permission selected cancel", d.outcome.text);
    try testing.expect(std.mem.find(u8, d.rec.firstOf(.@"error").?.body, "allow_always only") != null);
}

test "acp: a failing decide is a deny" {
    var d = try drive("[{\"ask\":{\"command\":\"ls\"}}]", .{ .mode = .fail });
    defer d.deinit();
    try testing.expectEqualStrings("permission selected reject", d.outcome.text);
    try testing.expect(std.mem.find(u8, d.rec.firstOf(.@"error").?.body, "decide failed, denying") != null);
}

test "acp: a decide that never answers is cut off, rejected and logged" {
    var d = try drive("[{\"ask\":{\"command\":\"ls\"}}]", .{ .mode = .hang, .decide_timeout_ms = 100 });
    defer d.deinit();
    try testing.expectEqualStrings("permission selected reject", d.outcome.text);
    const guard = d.rec.firstOf(.guard).?;
    try testing.expectEqualStrings("decide timeout", guard.body);
    try testing.expectEqualStrings("decide_timeout", guard.rule.?);
    try testing.expectEqual(types.GuardLayer.L3, guard.layer.?);
}

test "acp: a crash ends with the stderr tail and no process is left" {
    var d = try drive("[{\"crash\":true}]", .{});
    defer d.deinit();
    try testing.expectEqual(types.StopReason.@"error", d.outcome.stop_reason);
    try testing.expect(std.mem.find(u8, d.outcome.error_text.?, "fake agent crashing") != null);
    try testing.expect(std.mem.startsWith(u8, d.outcome.error_text.?, "agent exited before a response"));
    try expectGone(&d);
}

test "acp: a hang times out on the idle clock and the process is gone" {
    var d = try drive("[{\"hang\":true}]", .{ .idle_timeout_ms = 200 });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.timeout, d.outcome.stop_reason);
    try testing.expectEqualStrings("no update for 200 ms", d.outcome.error_text.?);
    try expectGone(&d);
}

test "acp: abort cancels the turn" {
    var d = try drive("[{\"say\":\"working\"},{\"hang\":true}]", .{ .abort_on = .message });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.cancelled, d.outcome.stop_reason);
    try testing.expect(d.outcome.error_text == null);
    const methods = try d.methods();
    defer testing.allocator.free(methods);
    try testing.expect(std.mem.endsWith(u8, methods, "session/prompt\nsession/cancel\n"));
    try expectGone(&d);
}

test "acp: an emit that fails ends the run as an adapter fault and kills the child" {
    var d = try drive("[{\"say\":\"x\"},{\"hang\":true}]", .{ .fail_emit_on = .message });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.@"error", d.outcome.stop_reason);
    try testing.expectEqualStrings("adapter fault: DbBusy", d.outcome.error_text.?);
    try expectGone(&d);
}

test "acp: a progress listener that fails is logged and the run completes" {
    var d = try drive("[{\"usageUpdate\":10},{\"say\":\"after\"}]", .{ .fail_progress = true });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.end_turn, d.outcome.stop_reason);
    try testing.expect(d.rec.logged.items.len > 0);
}

test "acp: a failing mode set aborts before session/prompt" {
    const gpa = testing.allocator;
    const io = testing.io;
    const fake = try kit.Fake.init(gpa, io, "[{\"say\":\"never\"}]");
    defer fake.deinit();
    try fake.env.put("FAKE_AGENT_FAIL_CONFIG", "1");
    var rec = kit.Recorder.init(gpa, io);
    defer rec.deinit();
    var abort: Io.Event = .unset;
    const hooks = rec.hooks();
    var outcome = try acp.execute(gpa, io, fake.config("fake"), &hooks, &abort);
    defer outcome.deinit();
    try testing.expectEqual(types.StopReason.@"error", outcome.stop_reason);
    try testing.expectEqualStrings("config refused", outcome.error_text.?);
    const methods = try fake.receivedMethods(io);
    defer gpa.free(methods);
    try testing.expect(std.mem.find(u8, methods, "session/prompt") == null);
}

test "acp: an agent without a permission mode runs but is flagged" {
    var d = try drive("[]", .{ .no_mode = true });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.end_turn, d.outcome.stop_reason);
    const guard = d.rec.firstOf(.guard).?;
    try testing.expectEqualStrings("no_permission_mode", guard.rule.?);
    try testing.expectEqual(types.GuardLayer.L0, guard.layer.?);
    try testing.expectEqual(types.GuardVerdict.ask, guard.verdict.?);
    const methods = try d.methods();
    defer testing.allocator.free(methods);
    try testing.expect(std.mem.find(u8, methods, "set_config_option") == null);
}

test "acp: an onSpawn hook that fails ends the run as an error and the process is gone" {
    var d = try drive("[{\"hang\":true}]", .{ .fail_spawn_hook = true });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.@"error", d.outcome.stop_reason);
    try testing.expectEqualStrings("PidWriteFailed", d.outcome.error_text.?);
    try testing.expectEqual(@as(usize, 1), d.rec.countKind(.@"error"));
}

test "acp: model and the mcp server reach session setup" {
    var d = try drive("[]", .{ .model = "fake-b", .mcp = true, .claude_meta = true });
    defer d.deinit();
    const text = try Io.Dir.cwd().readFileAlloc(testing.io, d.fake.log_file, testing.allocator, .limited(1 << 20));
    defer testing.allocator.free(text);
    try testing.expect(std.mem.find(u8, text, "\"configId\":\"model\",\"value\":\"fake-b\"") != null);
    try testing.expect(std.mem.find(u8, text, "Bearer tok") != null);
    try testing.expect(std.mem.find(u8, text, "\"claudeCode\"") != null);
}

test "acp: a flood of events is delivered and the run completes" {
    var script: std.Io.Writer.Allocating = .init(testing.allocator);
    defer script.deinit();
    try script.writer.writeByte('[');
    for (0..400) |i| {
        if (i > 0) try script.writer.writeByte(',');
        try script.writer.print("{{\"say\":\"chunk-{d};\"}}", .{i});
    }
    try script.writer.writeByte(']');
    var d = try drive(script.written(), .{});
    defer d.deinit();
    try testing.expectEqual(types.StopReason.end_turn, d.outcome.stop_reason);
    try testing.expect(std.mem.find(u8, d.outcome.text, "chunk-399;") != null);
    try testing.expectEqual(@as(usize, 400), std.mem.count(u8, d.outcome.text, "chunk-"));
}

test "acp: an agent line over the limit fails the run with a clear reason" {
    const big: [10_000]u8 = @splat('x');
    const script = try std.fmt.allocPrint(testing.allocator, "[{{\"say\":\"{s}\"}}]", .{big});
    defer testing.allocator.free(script);
    var d = try drive(script, .{ .max_line = 4096 });
    defer d.deinit();
    try testing.expectEqual(types.StopReason.@"error", d.outcome.stop_reason);
    try testing.expect(std.mem.find(u8, d.outcome.error_text.?, "line too long") != null);
    try expectGone(&d);
}
