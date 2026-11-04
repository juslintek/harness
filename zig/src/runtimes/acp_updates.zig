//! Maps ACP session/update notifications to run events. Port of
//! code/src/server/features/runtimes/acp-updates.ts: message chunks are coalesced per message,
//! tool calls are remembered by id so a later permission request can be described, and usage
//! updates feed the cost, the context fill and the Claude quota windows.
const std = @import("std");
const types = @import("types.zig");
const shell = @import("../guard/shell.zig");

const Value = std.json.Value;
const Allocator = std.mem.Allocator;

pub const message_quiet_ms = 300;

pub fn get(v: Value, key: []const u8) Value {
    return switch (v) {
        .object => |object| object.get(key) orelse .null,
        else => .null,
    };
}

pub fn str(v: Value) ?[]const u8 {
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

/// A JSON number as a float; null for anything else, like `typeof v === "number"` in TS.
pub fn float(v: Value) ?f64 {
    const f: f64 = switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |s| std.fmt.parseFloat(f64, s) catch return null,
        else => return null,
    };
    return if (std.math.isFinite(f)) f else null;
}

/// TS `num`: a finite number, else 0. Fractions are cut and out-of-range values clamp, which
/// JavaScript would have carried as a double.
pub fn count(v: Value) i64 {
    if (v == .integer) return v.integer;
    const f = float(v) orelse return 0;
    return std.math.lossyCast(i64, f);
}

fn coalesce(a: Value, b: Value) Value {
    return if (a == .null) b else a;
}

/// JS `[...].join(" ")` for the shapes a command array holds.
fn joinCommand(a: Allocator, items: []const Value) Allocator.Error![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    errdefer out.deinit();
    for (items, 0..) |item, index| {
        if (index > 0) out.writer.writeByte(' ') catch return error.OutOfMemory;
        switch (item) {
            .string => |s| out.writer.writeAll(s) catch return error.OutOfMemory,
            .integer => |i| out.writer.print("{d}", .{i}) catch return error.OutOfMemory,
            .float => |f| out.writer.print("{d}", .{f}) catch return error.OutOfMemory,
            .bool => |b| out.writer.writeAll(if (b) "true" else "false") catch return error.OutOfMemory,
            .null => {},
            else => out.writer.writeAll("[object Object]") catch return error.OutOfMemory,
        }
    }
    return out.toOwnedSlice();
}

fn commandOf(a: Allocator, raw_input: Value) Allocator.Error!?[]const u8 {
    const command = get(raw_input, "command");
    return switch (command) {
        .array => |array| try joinCommand(a, array.items),
        .string => |s| try a.dupe(u8, s),
        else => null,
    };
}

fn pathsOf(a: Allocator, locations: Value) Allocator.Error![]const []const u8 {
    if (locations != .array) return &.{};
    var list: std.ArrayList([]const u8) = .empty;
    for (locations.array.items) |location| {
        const path = str(get(location, "path")) orelse continue;
        try list.append(a, try a.dupe(u8, path));
    }
    return list.toOwnedSlice(a);
}

fn dupeOpt(a: Allocator, s: ?[]const u8) Allocator.Error!?[]const u8 {
    return if (s) |value| try a.dupe(u8, value) else null;
}

const ToolInfo = struct {
    arena: std.heap.ArenaAllocator,
    title: ?[]const u8,
    kind: ?[]const u8,
    command: ?[]const u8,
    paths: []const []const u8,

    /// Merges an update over the call announced before it; the new info owns every string.
    fn merge(gpa: Allocator, prev: ?*const ToolInfo, update: Value) Allocator.Error!*ToolInfo {
        const info = try gpa.create(ToolInfo);
        errdefer gpa.destroy(info);
        info.arena = .init(gpa);
        errdefer info.arena.deinit();
        const a = info.arena.allocator();
        const paths = try pathsOf(a, get(update, "locations"));
        info.* = .{
            .arena = info.arena,
            .title = try dupeOpt(a, str(get(update, "title")) orelse if (prev) |p| p.title else null),
            .kind = try dupeOpt(a, str(get(update, "kind")) orelse if (prev) |p| p.kind else null),
            .command = (try commandOf(a, get(update, "rawInput"))) orelse
                try dupeOpt(a, if (prev) |p| p.command else null),
            .paths = if (paths.len > 0) paths else if (prev) |p| try dupePaths(a, p.paths) else &.{},
        };
        return info;
    }

    fn destroy(info: *ToolInfo, gpa: Allocator) void {
        info.arena.deinit();
        gpa.destroy(info);
    }
};

fn dupePaths(a: Allocator, paths: []const []const u8) Allocator.Error![]const []const u8 {
    const out = try a.alloc([]const u8, paths.len);
    for (paths, out) |path, *dst| dst.* = try a.dupe(u8, path);
    return out;
}

pub fn askKind(kind: ?[]const u8) types.AskKind {
    const name = kind orelse return .other;
    if (std.mem.eql(u8, name, "search")) return .read;
    if (std.mem.eql(u8, name, "move")) return .edit;
    return std.meta.stringToEnum(types.AskKind, name) orelse .other;
}

/// Codex shell-quotes a multi-statement script into one word in the permission request, which L1
/// reads as a dynamic command name. The tool_call announced the same call unquoted, so the asked
/// command is replaced only when it is exactly that one word. An unparseable command stays as it
/// is so L1's own unparseable path applies.
fn unquoted(gpa: Allocator, asked: ?[]const u8, announced: ?[]const u8) Allocator.Error!?[]const u8 {
    const a = asked orelse return announced;
    const b = announced orelse return asked;
    var outcome = try shell.parse(gpa, a);
    defer outcome.deinit();
    const parsed = switch (outcome) {
        .parsed => |p| p,
        .unparseable => return asked,
    };
    var only: ?*const shell.Cmd = null;
    for (parsed.cmds) |cmd| {
        if (cmd.argv.len == 0) continue;
        if (only != null) return asked;
        only = cmd;
    }
    const cmd = only orelse return asked;
    return if (cmd.argv.len == 1 and std.mem.eql(u8, cmd.argv[0], b)) announced else asked;
}

pub const Sink = struct {
    gpa: Allocator,
    io: std.Io,
    run_id: []const u8,
    agent: []const u8,
    hooks: *const types.Hooks,
    /// The concatenated agent_message text, the run's answer.
    text: std.ArrayList(u8) = .empty,
    cost_usd: ?f64 = null,
    buffer: std.ArrayList(u8) = .empty,
    buffer_is_thought: bool = false,
    /// Awake-clock ms at which a stalled message is flushed anyway; null when nothing is buffered.
    flush_deadline_ms: ?i64 = null,
    tools: std.StringHashMapUnmanaged(*ToolInfo) = .empty,

    pub fn init(gpa: Allocator, io: std.Io, run_id: []const u8, agent: []const u8, hooks: *const types.Hooks) Sink {
        return .{ .gpa = gpa, .io = io, .run_id = run_id, .agent = agent, .hooks = hooks };
    }

    pub fn deinit(sink: *Sink) void {
        sink.text.deinit(sink.gpa);
        sink.buffer.deinit(sink.gpa);
        var it = sink.tools.iterator();
        while (it.next()) |entry| {
            sink.gpa.free(entry.key_ptr.*);
            entry.value_ptr.*.destroy(sink.gpa);
        }
        sink.tools.deinit(sink.gpa);
    }

    pub fn emit(sink: *Sink, event: types.NewEvent) !void {
        var full = event;
        full.run_id = sink.run_id;
        full.agent = sink.agent;
        try sink.hooks.emit(sink.hooks.ctx, full);
    }

    fn nowMs(sink: *Sink) i64 {
        return std.Io.Clock.awake.now(sink.io).toMilliseconds();
    }

    pub fn handle(sink: *Sink, update: Value) !void {
        const kind = str(get(update, "sessionUpdate")) orelse return;
        const is_message = std.mem.eql(u8, kind, "agent_message_chunk");
        const is_thought = std.mem.eql(u8, kind, "agent_thought_chunk");
        if (is_message or is_thought) {
            const chunk = str(get(get(update, "content"), "text")) orelse "";
            if (is_message) try sink.text.appendSlice(sink.gpa, chunk);
            try sink.append(is_thought, chunk);
        } else if (std.mem.eql(u8, kind, "tool_call") or std.mem.eql(u8, kind, "tool_call_update")) {
            try sink.flush();
            try sink.tool(update);
        } else if (std.mem.eql(u8, kind, "usage_update")) {
            try sink.usage(update);
        }
    }

    pub fn flush(sink: *Sink) !void {
        sink.flush_deadline_ms = null;
        if (sink.buffer.items.len == 0) return;
        // The buffer is cleared first: a failing emit must not deliver the same text twice.
        defer sink.buffer.clearRetainingCapacity();
        try sink.emit(.{
            .kind = .message,
            .source = "acp",
            .operation = if (sink.buffer_is_thought) "thought" else null,
            .body = sink.buffer.items,
        });
    }

    /// Flushes a message that has been quiet for `message_quiet_ms`.
    pub fn flushIfDue(sink: *Sink) !void {
        const deadline = sink.flush_deadline_ms orelse return;
        if (sink.nowMs() >= deadline) try sink.flush();
    }

    fn append(sink: *Sink, thought: bool, chunk: []const u8) !void {
        if (sink.buffer.items.len > 0 and sink.buffer_is_thought != thought) try sink.flush();
        sink.buffer_is_thought = thought;
        try sink.buffer.appendSlice(sink.gpa, chunk);
        sink.flush_deadline_ms = sink.nowMs() + message_quiet_ms;
    }

    /// Describes a permission request. Codex sends the request for an MCP call without title or
    /// input; the earlier tool_call carries them. Strings are allocated from `a`.
    pub fn describe(sink: *Sink, a: Allocator, tool_call: Value) Allocator.Error!types.Ask {
        const known: ?*const ToolInfo = if (str(get(tool_call, "toolCallId"))) |id| sink.tools.get(id) else null;
        const kind = str(get(tool_call, "kind")) orelse if (known) |k| k.kind else null;
        const asked = try commandOf(a, get(tool_call, "rawInput"));
        const command = try unquoted(sink.gpa, asked, if (known) |k| k.command else null);
        const paths = try pathsOf(a, get(tool_call, "locations"));
        const title = str(get(tool_call, "title")) orelse if (known) |k| k.title else null;
        const tool_name = str(get(tool_call, "name")) orelse if (known) |k| k.title else null;
        return .{
            .kind = askKind(kind),
            .paths = if (paths.len > 0) paths else if (known) |k| try dupePaths(a, k.paths) else &.{},
            .command = try dupeOpt(a, command),
            .tool_name = try dupeOpt(a, tool_name),
            .title = try dupeOpt(a, title),
        };
    }

    fn tool(sink: *Sink, update: Value) !void {
        const id = str(get(update, "toolCallId")) orelse "";
        const prev = sink.tools.get(id);
        const info = try ToolInfo.merge(sink.gpa, prev, update);
        errdefer info.destroy(sink.gpa);
        if (prev) |old| {
            sink.tools.getPtr(id).?.* = info;
            old.destroy(sink.gpa);
        } else {
            const key = try sink.gpa.dupe(u8, id);
            errdefer sink.gpa.free(key);
            try sink.tools.put(sink.gpa, key, info);
        }
        try sink.emit(.{
            .kind = .tool_call,
            .source = "acp",
            .tool_name = info.title orelse info.kind orelse "tool",
            .command = info.command,
            .body = str(get(update, "status")) orelse "",
        });
    }

    fn usage(sink: *Sink, update: Value) !void {
        if (float(get(get(update, "cost"), "amount"))) |amount| sink.cost_usd = amount;
        if (float(get(update, "used"))) |used| {
            // Progress only feeds the breaker; a listener that fails must not end a healthy run.
            sink.hooks.on_progress(sink.hooks.ctx, std.math.lossyCast(i64, used)) catch |err| {
                var buffer: [96]u8 = undefined;
                const message = std.fmt.bufPrint(&buffer, "acp progress listener failed: {t}", .{err}) catch "acp progress listener failed";
                sink.hooks.log_error(sink.hooks.ctx, message);
            };
        }
        const unified = get(get(get(update, "_meta"), "_claude/rateLimit"), "unifiedWindows");
        for (std.enums.values(types.QuotaWindow)) |which| {
            const window = get(unified, @tagName(which));
            if (float(get(window, "utilization"))) |utilization| {
                // Claude reports 0..1 and epoch seconds; the harness stores percent and epoch ms.
                const resets: ?i64 = if (float(get(window, "resetsAt"))) |seconds| std.math.lossyCast(i64, seconds * 1000) else null;
                try sink.hooks.on_quota(sink.hooks.ctx, .{
                    .window = which,
                    .used_percent = utilization * 100,
                    .resets_at = resets,
                });
            }
        }
    }
};

pub const Pick = struct { option_id: ?[]const u8, allow_always_only: bool };

/// Chosen by kind, never by id: Claude and Codex name their reject options differently, and
/// allow_always writes a standing rule that the harness never grants. The id points into
/// `options`.
pub fn pickOption(options: Value, verdict: types.Verdict) Pick {
    const list: []const Value = if (options == .array) options.array.items else &.{};
    const wanted: []const u8 = if (verdict == .allow) "allow_once" else "reject_once";
    for (list) |option| {
        const kind = str(get(option, "kind")) orelse continue;
        if (!std.mem.eql(u8, kind, wanted)) continue;
        if (str(get(option, "optionId"))) |id| return .{ .option_id = id, .allow_always_only = false };
        break;
    }
    var always = false;
    if (verdict == .allow) {
        for (list) |option| {
            if (str(get(option, "kind"))) |kind| always = always or std.mem.eql(u8, kind, "allow_always");
        }
    }
    return .{ .option_id = null, .allow_always_only = always };
}

fn record(model: ?[]const u8, t: Value) types.UsageRecord {
    return .{
        .model = model,
        .input_tokens = count(get(t, "inputTokens")),
        .output_tokens = count(get(t, "outputTokens")),
        .cache_read_tokens = count(coalesce(get(t, "cachedInputTokens"), get(t, "cachedReadTokens"))),
        .cache_write_tokens = count(coalesce(get(t, "cachedWriteTokens"), get(t, "cacheWriteInputTokens"))),
        .reasoning_tokens = count(coalesce(get(t, "reasoningOutputTokens"), get(t, "thoughtTokens"))),
        .reported_cost_usd = null,
    };
}

/// One record per model when the agent splits them (that figure already includes helper models
/// and subagents); otherwise the response total. The turn's cost is a single number, so it goes
/// on the first record only and a sum over records never double-counts it. Strings are
/// allocated from `a`.
pub fn usageRecords(a: Allocator, response: Value, model: ?[]const u8, cost_usd: ?f64) Allocator.Error![]types.UsageRecord {
    var rows: std.ArrayList(types.UsageRecord) = .empty;
    const per_model = get(get(get(response, "_meta"), "quota"), "model_usage");
    if (per_model == .array) {
        for (per_model.array.items) |row| {
            const tokens = get(row, "token_count");
            if (tokens != .object) continue;
            try rows.append(a, record(try dupeOpt(a, str(get(row, "model")) orelse model), tokens));
        }
    }
    const total = get(response, "usage");
    if (rows.items.len == 0 and total != .null) {
        try rows.append(a, record(try dupeOpt(a, model), total));
    }
    if (rows.items.len > 0) {
        if (cost_usd) |cost| rows.items[0].reported_cost_usd = cost;
    }
    return rows.toOwnedSlice(a);
}

const testing = std.testing;

const Recorder = struct {
    events: std.ArrayList(u8) = .empty,
    quotas: u32 = 0,
    progress: i64 = 0,
    fail_progress: bool = false,
    logged: u32 = 0,

    fn hooks(r: *Recorder) types.Hooks {
        return .{
            .ctx = r,
            .emit = emit,
            .decide = decide,
            .on_quota = onQuota,
            .on_progress = onProgress,
            .on_spawn = onSpawn,
            .log_error = logError,
        };
    }
    fn emit(ctx: *anyopaque, event: types.NewEvent) anyerror!void {
        const r: *Recorder = @ptrCast(@alignCast(ctx));
        try r.events.print(testing.allocator, "{t}:{s}|", .{ event.kind, event.body orelse "" });
    }
    fn decide(_: *anyopaque, _: types.Ask) anyerror!types.Verdict {
        return .deny;
    }
    fn onQuota(ctx: *anyopaque, _: types.Quota) anyerror!void {
        const r: *Recorder = @ptrCast(@alignCast(ctx));
        r.quotas += 1;
    }
    fn onProgress(ctx: *anyopaque, tokens: i64) anyerror!void {
        const r: *Recorder = @ptrCast(@alignCast(ctx));
        if (r.fail_progress) return error.BreakerBroke;
        r.progress = tokens;
    }
    fn onSpawn(_: *anyopaque, _: std.posix.pid_t) anyerror!void {}
    fn logError(ctx: *anyopaque, _: []const u8) void {
        const r: *Recorder = @ptrCast(@alignCast(ctx));
        r.logged += 1;
    }
};

fn parseValue(gpa: Allocator, json: []const u8) !std.json.Parsed(Value) {
    return std.json.parseFromSlice(Value, gpa, json, .{});
}

test "acp_updates: message chunks coalesce, a tool call flushes them first" {
    var recorder: Recorder = .{};
    defer recorder.events.deinit(testing.allocator);
    const hooks = recorder.hooks();
    var sink = Sink.init(testing.allocator, testing.io, "r1", "fake", &hooks);
    defer sink.deinit();
    inline for (.{
        \\{"sessionUpdate":"agent_message_chunk","content":{"text":"he"}}
        ,
        \\{"sessionUpdate":"agent_message_chunk","content":{"text":"llo"}}
        ,
        \\{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run ls","kind":"execute","rawInput":{"command":["ls","-la"]},"status":"pending"}
        ,
        \\{"sessionUpdate":"agent_thought_chunk","content":{"text":"hmm"}}
    }) |json| {
        const parsed = try parseValue(testing.allocator, json);
        defer parsed.deinit();
        try sink.handle(parsed.value);
    }
    try sink.flush();
    try testing.expectEqualStrings("message:hello|tool_call:pending|message:hmm|", recorder.events.items);
    try testing.expectEqualStrings("hello", sink.text.items);
}

test "acp_updates: a permission request borrows what the announced tool call knew" {
    var recorder: Recorder = .{};
    defer recorder.events.deinit(testing.allocator);
    const hooks = recorder.hooks();
    var sink = Sink.init(testing.allocator, testing.io, "r1", "codex", &hooks);
    defer sink.deinit();
    const announced = try parseValue(testing.allocator,
        \\{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Bash","kind":"execute","rawInput":{"command":"echo a; echo b"},"locations":[{"path":"/x"}]}
    );
    defer announced.deinit();
    try sink.handle(announced.value);
    const asked = try parseValue(testing.allocator,
        \\{"toolCallId":"t1","rawInput":{"command":"'echo a; echo b'"}}
    );
    defer asked.deinit();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const ask = try sink.describe(arena.allocator(), asked.value);
    try testing.expectEqual(types.AskKind.execute, ask.kind);
    try testing.expectEqualStrings("echo a; echo b", ask.command.?);
    try testing.expectEqualStrings("Bash", ask.title.?);
    try testing.expectEqual(@as(usize, 1), ask.paths.len);
    try testing.expectEqualStrings("/x", ask.paths[0]);

    const plain = try parseValue(testing.allocator,
        \\{"toolCallId":"t1","rawInput":{"command":"rm -rf /"}}
    );
    defer plain.deinit();
    const second = try sink.describe(arena.allocator(), plain.value);
    try testing.expectEqualStrings("rm -rf /", second.command.?);
}

test "acp_updates: usage updates report cost, context fill and quota windows" {
    var recorder: Recorder = .{};
    defer recorder.events.deinit(testing.allocator);
    const hooks = recorder.hooks();
    var sink = Sink.init(testing.allocator, testing.io, "r1", "claude", &hooks);
    defer sink.deinit();
    const parsed = try parseValue(testing.allocator,
        \\{"sessionUpdate":"usage_update","used":10,"size":100,"cost":{"amount":0.5,"currency":"USD"},
        \\ "_meta":{"_claude/rateLimit":{"unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":100},"seven_day":{"utilization":0.5}}}}}
    );
    defer parsed.deinit();
    try sink.handle(parsed.value);
    try testing.expectEqual(@as(i64, 10), recorder.progress);
    try testing.expectEqual(@as(u32, 2), recorder.quotas);
    try testing.expectEqual(@as(f64, 0.5), sink.cost_usd.?);
}

test "acp_updates: a failing progress listener is logged and the update still counts" {
    var recorder: Recorder = .{ .fail_progress = true };
    defer recorder.events.deinit(testing.allocator);
    const hooks = recorder.hooks();
    var sink = Sink.init(testing.allocator, testing.io, "r1", "claude", &hooks);
    defer sink.deinit();
    const parsed = try parseValue(testing.allocator, "{\"sessionUpdate\":\"usage_update\",\"used\":3,\"cost\":{\"amount\":2}}");
    defer parsed.deinit();
    try sink.handle(parsed.value);
    try testing.expectEqual(@as(u32, 1), recorder.logged);
    try testing.expectEqual(@as(f64, 2), sink.cost_usd.?);
}

test "acp_updates: pickOption chooses by kind and flags allow_always only" {
    const both = try parseValue(testing.allocator,
        \\[{"optionId":"a","kind":"allow_once"},{"optionId":"b","kind":"allow_always"},{"optionId":"c","kind":"reject_once"}]
    );
    defer both.deinit();
    try testing.expectEqualStrings("a", pickOption(both.value, .allow).option_id.?);
    try testing.expectEqualStrings("c", pickOption(both.value, .deny).option_id.?);
    const always = try parseValue(testing.allocator,
        \\[{"optionId":"x","kind":"allow_always"},{"optionId":"y","kind":"reject_once"}]
    );
    defer always.deinit();
    const pick = pickOption(always.value, .allow);
    try testing.expect(pick.option_id == null and pick.allow_always_only);
    try testing.expect(!pickOption(.null, .allow).allow_always_only);
}

test "acp_updates: usage records split per model, cost on the first only" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const response = try parseValue(testing.allocator,
        \\{"usage":{"inputTokens":1,"outputTokens":1},"_meta":{"quota":{"model_usage":[
        \\ {"model":"gpt","token_count":{"inputTokens":10,"cachedInputTokens":30,"cacheWriteInputTokens":7}},
        \\ {"token_count":{"inputTokens":2}}, {"model":"skipped"}]}}}
    );
    defer response.deinit();
    const rows = try usageRecords(arena.allocator(), response.value, "fallback", 1.5);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqualStrings("gpt", rows[0].model.?);
    try testing.expectEqual(@as(i64, 10), rows[0].input_tokens);
    try testing.expectEqual(@as(i64, 30), rows[0].cache_read_tokens);
    try testing.expectEqual(@as(i64, 7), rows[0].cache_write_tokens);
    try testing.expectEqual(@as(f64, 1.5), rows[0].reported_cost_usd.?);
    try testing.expectEqualStrings("fallback", rows[1].model.?);
    try testing.expect(rows[1].reported_cost_usd == null);

    const totals = try parseValue(testing.allocator, "{\"usage\":{\"inputTokens\":4,\"outputTokens\":78,\"cachedReadTokens\":9,\"cachedWriteTokens\":121442,\"thoughtTokens\":3}}");
    defer totals.deinit();
    const one = try usageRecords(arena.allocator(), totals.value, null, null);
    try testing.expectEqual(@as(usize, 1), one.len);
    try testing.expectEqual(@as(i64, 9), one[0].cache_read_tokens);
    try testing.expectEqual(@as(i64, 3), one[0].reasoning_tokens);
    try testing.expectEqual(@as(usize, 0), (try usageRecords(arena.allocator(), .null, null, 1)).len);
}

test "acp_updates: allocation failures in describe, handle and usageRecords leave nothing behind" {
    const Run = struct {
        fn run(gpa: Allocator) !void {
            var recorder: Recorder = .{};
            defer recorder.events.deinit(testing.allocator);
            const hooks = recorder.hooks();
            var sink = Sink.init(gpa, testing.io, "r1", "codex", &hooks);
            defer sink.deinit();
            const announced = try parseValue(testing.allocator,
                \\{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Bash","kind":"execute","rawInput":{"command":["a","b"]},"locations":[{"path":"/x"}]}
            );
            defer announced.deinit();
            try sink.handle(announced.value);
            try sink.handle(announced.value);
            const chunk = try parseValue(testing.allocator, "{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"text\":\"hi\"}}");
            defer chunk.deinit();
            try sink.handle(chunk.value);
            try sink.flush();
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            const ask = try sink.describe(arena.allocator(), announced.value);
            try testing.expectEqualStrings("a b", ask.command.?);
            const response = try parseValue(testing.allocator, "{\"usage\":{\"inputTokens\":1},\"_meta\":{\"quota\":{\"model_usage\":[{\"model\":\"m\",\"token_count\":{}}]}}}");
            defer response.deinit();
            _ = try usageRecords(arena.allocator(), response.value, "x", 1);
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Run.run, .{});
}
