//! Types the runtimes files share: the event shape other slices consume, the hooks a run calls
//! out to, and the outcome of one lane run. Ports adapter.ts and the NewEvent type of
//! code/src/server/features/logs/api.ts. Strings in an event or an ask are borrowed for the call;
//! a hook that keeps one must copy it.
const std = @import("std");
const process_mod = @import("process.zig");

pub const EventKind = enum { run, message, tool_call, permission, guard, usage, approval, process, @"error" };
pub const GuardLayer = enum { L0, L1, L2, L3, L4 };
pub const GuardVerdict = enum { allow, ask, deny };

pub const NewEvent = struct {
    run_id: ?[]const u8 = null,
    task_id: ?[]const u8 = null,
    agent: ?[]const u8 = null,
    kind: EventKind,
    operation: ?[]const u8 = null,
    tool_name: ?[]const u8 = null,
    conversation_id: ?[]const u8 = null,
    model: ?[]const u8 = null,
    input_tokens: ?i64 = null,
    output_tokens: ?i64 = null,
    cache_read_tokens: ?i64 = null,
    cache_write_tokens: ?i64 = null,
    reasoning_tokens: ?i64 = null,
    reported_cost_usd: ?f64 = null,
    command: ?[]const u8 = null,
    exit_code: ?i64 = null,
    duration_ms: ?i64 = null,
    guard_layer: ?GuardLayer = null,
    guard_verdict: ?GuardVerdict = null,
    guard_rule: ?[]const u8 = null,
    source: ?[]const u8 = null,
    dedupe_key: ?[]const u8 = null,
    body: ?[]const u8 = null,
    ts: ?i64 = null,
};

pub const AskKind = enum { execute, read, edit, delete, fetch, other };

pub const Ask = struct {
    kind: AskKind,
    command: ?[]const u8 = null,
    paths: []const []const u8 = &.{},
    tool_name: ?[]const u8 = null,
    title: ?[]const u8 = null,
};

pub const Verdict = enum { allow, deny };

pub const QuotaWindow = enum { five_hour, seven_day };

pub const Quota = struct {
    window: QuotaWindow,
    used_percent: f64,
    /// Epoch ms, like the rest of the harness.
    resets_at: ?i64,
};

/// Only the fields the ACP lane reads from an agent spec; the agents slice owns the full record.
pub const Spec = struct {
    id: []const u8,
    /// Executable followed by its arguments.
    argv: []const []const u8,
    mode_option: ?ModeOption = null,
    claude_meta: bool = false,

    pub const ModeOption = struct { config_id: []const u8, value: []const u8 };
};

/// Callbacks of one run. A hook that fails ends the run as an adapter fault, as a throwing emit
/// does in acp.ts. `decide` may block for a human, so it must wait through `io` primitives that
/// observe cancellation; the lane cancels it when the decide timeout or an abort fires.
pub const Hooks = struct {
    ctx: *anyopaque,
    emit: *const fn (ctx: *anyopaque, event: NewEvent) anyerror!void,
    decide: *const fn (ctx: *anyopaque, ask: Ask) anyerror!Verdict,
    on_quota: *const fn (ctx: *anyopaque, quota: Quota) anyerror!void,
    on_progress: *const fn (ctx: *anyopaque, context_tokens: i64) anyerror!void,
    on_spawn: *const fn (ctx: *anyopaque, pid: std.posix.pid_t) anyerror!void,
    log_error: *const fn (ctx: *anyopaque, message: []const u8) void,
};

pub const StopReason = enum { end_turn, cancelled, max_tokens, refusal, @"error", timeout };

pub const UsageRecord = struct {
    model: ?[]const u8,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    reasoning_tokens: i64,
    reported_cost_usd: ?f64,
};

/// Everything in it is allocated from `arena`.
pub const Outcome = struct {
    arena: std.heap.ArenaAllocator,
    stop_reason: StopReason,
    text: []const u8,
    usage: []UsageRecord,
    error_text: ?[]const u8,
    session_id: ?[]const u8,
    /// Set when the agent's process group could not be ended. The caller owns the process and
    /// must retry `terminate` before it frees it.
    survivor: ?*process_mod.Process = null,

    pub fn deinit(outcome: *Outcome) void {
        outcome.arena.deinit();
    }
};

pub const RunConfig = struct {
    run_id: []const u8,
    task_id: ?[]const u8 = null,
    cwd: []const u8,
    prompt: []const u8,
    model: ?[]const u8,
    spec: Spec,
    argv: []const []const u8,
    env: *const std.process.Environ.Map,
    mcp: ?Mcp = null,
    /// The Claude hook settings, already serialised as a JSON value.
    claude_settings_json: []const u8 = "{}",
    idle_timeout_ms: i64,
    decide_timeout_ms: i64 = 15 * 60_000,
    /// Optional file that receives every complete stdout line, like acp-tee.ts.
    tee_path: ?[]const u8 = null,
    /// The longest agent stdout line the run accepts; a longer one fails the run.
    max_line: usize = 32 * 1024 * 1024,
    /// Test hook: that many terminations fail before doing anything, as if the group survived.
    inject_terminate_failures: u32 = 0,

    pub const Mcp = struct { url: []const u8, token: []const u8 };
};

test "types: an outcome frees its arena" {
    var outcome: Outcome = .{
        .arena = .init(std.testing.allocator),
        .stop_reason = .end_turn,
        .text = "",
        .usage = &.{},
        .error_text = null,
        .session_id = null,
    };
    outcome.text = try outcome.arena.allocator().dupe(u8, "x");
    outcome.deinit();
}
