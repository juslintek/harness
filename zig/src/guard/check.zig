//! The guard orchestrator, `checkAction` of guard/api.ts: L1 decides first, L2 may raise an L1
//! allow of a command to ask or deny, and an ask goes to a human through an approval row. Only an
//! approval makes the verdict allow; a denial, a timeout and a run that ends all mean deny.
//! Autonomy and policies (phase 3) are not ported. TS `applyAutonomy` only tightens an L1 verdict
//! (an allow becomes an ask under a strict policy), so with policy rows this is looser than TS.
//!
//! The wait for the human does not hold the App lock: `approvals.waitForDecision` takes it for one
//! read per step, so a cancelation (the run's decide timeout, an abort) ends the call with
//! `error.Canceled`. Every other failure is an error for the caller to turn into a deny, as
//! `decideAsk` does in TS.
const std = @import("std");
const Allocator = std.mem.Allocator;
const app_mod = @import("../app.zig");
const client_mod = @import("../laya/client.zig");
const ids = @import("../ids.zig");
const l1 = @import("l1.zig");
const l2 = @import("l2.zig");
const core = @import("rules_core.zig");
const logs = @import("../logs/api.zig");
const redact = @import("../logs/redact.zig");
const sqlite = @import("../db/sqlite.zig");
const approvals = @import("approvals.zig");
const types = @import("../runtimes/types.zig");

const App = app_mod.App;
const State = app_mod.State;

pub const default_approval_timeout_ms: i64 = 600_000;

pub const Run = struct {
    id: []const u8,
    prompt: []const u8,
    scope: l1.Scope,
};

pub const Options = struct {
    /// What `HARNESS_APPROVAL_TIMEOUT_MS` says when it is a positive number, else the default.
    approval_timeout_ms: i64 = default_approval_timeout_ms,
    ctx: ?*anyopaque = null,
    /// `onApprovalPending`: told the id of a new approval, outside the lock.
    on_pending: ?*const fn (ctx: ?*anyopaque, approval_id: []const u8) void = null,
};

pub const Layer = enum { L1, L2, L3 };

/// `GuardOutcome`. Strings are allocated from the arena given to `checkAction`.
pub const Outcome = struct {
    verdict: types.Verdict,
    layer: Layer,
    reason: []const u8,
    rule: ?[]const u8,
    approval_id: ?[]const u8,
};

pub const Error = approvals.Error || l1.Error || error{Canceled};

/// An `Ask` of a lane as the action L1 reads. The two kind enums have the same names.
pub fn actionOf(ask: types.Ask) l1.Action {
    return .{
        .kind = std.meta.stringToEnum(l1.Kind, @tagName(ask.kind)).?,
        .command = ask.command,
        .paths = ask.paths,
        .tool_name = ask.tool_name,
    };
}

const LogArgs = struct {
    io: std.Io,
    gpa: Allocator,
    run_id: []const u8,
    layer: types.GuardLayer,
    verdict: core.Verdict,
    rule: ?[]const u8,
    command: []const u8,
    reason: []const u8,
};

fn logLocked(args: LogArgs, state: *State) !void {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const id = ids.uuidV7(args.io);
    _ = try logs.appendEvent(args.gpa, db, &id, ids.nowMs(args.io), .{
        .run_id = args.run_id,
        .kind = .guard,
        .guard_layer = args.layer,
        .guard_verdict = @fromBackingInt(@intCast(@backingInt(args.verdict))),
        .guard_rule = args.rule,
        .command = args.command,
        .body = args.reason,
    });
}

fn logLayer(app: *App, run: Run, layer: types.GuardLayer, verdict: core.Verdict, rule: ?[]const u8, command: []const u8, reason: []const u8) !void {
    try app.withLock(LogArgs{ .io = app.io, .gpa = app.gpa, .run_id = run.id, .layer = layer, .verdict = verdict, .rule = rule, .command = command, .reason = reason }, logLocked);
}

/// `action.command ?? action.paths.join(" ")`
fn commandOf(a: Allocator, action: l1.Action) Allocator.Error![]const u8 {
    return action.command orelse try std.mem.join(a, " ", action.paths);
}

/// What `approvals.action` stores: the action with secrets removed from the command, the title
/// and the paths, keys in the order of the TS object.
const StoredAction = struct {
    kind: []const u8,
    command: ?[]const u8,
    paths: []const []const u8,
    toolName: ?[]const u8,
    title: ?[]const u8,
};

/// Valid UTF-8 whatever the bytes were: std.json writes a string that is not valid UTF-8 as an
/// array of numbers, which nothing reading the row back would take for text.
fn scrubbed(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    if (std.unicode.utf8ValidateSlice(text)) return text;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        const len = std.unicode.utf8ByteSequenceLength(text[i]) catch 0;
        if (len > 0 and i + len <= text.len and std.unicode.utf8ValidateSlice(text[i..][0..len])) {
            try out.appendSlice(a, text[i..][0..len]);
            i += len;
        } else {
            try out.appendSlice(a, "\u{fffd}");
            i += 1;
        }
    }
    return out.items;
}

/// Redacted first: a secret cut by a replacement character would no longer match its pattern.
fn redacted(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    return scrubbed(a, try redact.redactSecrets(a, text));
}

fn redactedOpt(a: Allocator, text: ?[]const u8) Allocator.Error!?[]const u8 {
    return if (text) |t| try redacted(a, t) else null;
}

fn actionJson(a: Allocator, action: l1.Action, title: ?[]const u8) Allocator.Error![]const u8 {
    const paths = try a.alloc([]const u8, action.paths.len);
    for (action.paths, paths) |path, *slot| slot.* = try redacted(a, path);
    const stored: StoredAction = .{
        .kind = @tagName(action.kind),
        .command = try redactedOpt(a, action.command),
        .paths = paths,
        .toolName = if (action.tool_name) |name| try scrubbed(a, name) else null,
        .title = try redactedOpt(a, title),
    };
    return std.json.Stringify.valueAlloc(a, stored, .{ .emit_null_optional_fields = false });
}

const Redactable = struct { verdict: core.Verdict, rule: ?[]const u8, reason: []const u8, category: core.Category };

fn l1Json(a: Allocator, result: core.Result) Allocator.Error![]const u8 {
    const stored: Redactable = .{ .verdict = result.verdict, .rule = result.rule, .reason = try redacted(a, result.reason), .category = result.category };
    return std.json.Stringify.valueAlloc(a, stored, .{});
}

fn l2Json(a: Allocator, result: l2.Result) Allocator.Error![]const u8 {
    var stored = result;
    stored.reason = try redacted(a, result.reason);
    return std.json.Stringify.valueAlloc(a, stored, .{});
}

const CreateArgs = struct { io: std.Io, input: approvals.NewApproval };

fn createLocked(args: CreateArgs, state: *State) approvals.Error!approvals.Created {
    return approvals.create(.{ .handle = state.db orelse return error.NoDatabase }, args.io, args.input);
}

fn askHuman(a: Allocator, app: *App, run: Run, action: l1.Action, title: ?[]const u8, l1_result: core.Result, l2_result: ?l2.Result, opts: Options) Error!Outcome {
    const created = try app.withLock(CreateArgs{ .io = app.io, .input = .{
        .run_id = run.id,
        .action = try actionJson(a, action, title),
        .l1 = try l1Json(a, l1_result),
        .l2 = if (l2_result) |r| try l2Json(a, r) else null,
        .timeout_ms = opts.approval_timeout_ms,
    } }, createLocked);
    const approval_id = try a.dupe(u8, &created.id);
    if (opts.on_pending) |notify| notify(opts.ctx, approval_id);
    const status = try approvals.waitForDecision(app, approval_id, created.expires_at);
    const approved = status == .approved;
    const reason: []const u8 = if (approved) "approved" else if (status == .denied) "denied" else "approval_timeout";
    try logLayer(app, run, .L3, if (approved) .allow else .deny, l1_result.rule, try commandOf(a, action), reason);
    return .{
        .verdict = if (approved) .allow else .deny,
        .layer = .L3,
        .reason = reason,
        .rule = l1_result.rule,
        .approval_id = approval_id,
    };
}

pub fn checkAction(a: Allocator, app: *App, client: *client_mod.Client, run: Run, ask: types.Ask, opts: Options) Error!Outcome {
    const action = actionOf(ask);
    const command = try commandOf(a, action);
    const l1_result = try l1.evaluate(a, app.gpa, app.io, action, run.scope);
    try logLayer(app, run, .L1, l1_result.verdict, l1_result.rule, command, l1_result.reason);
    if (l1_result.verdict == .deny) {
        return .{ .verdict = .deny, .layer = .L1, .reason = l1_result.reason, .rule = l1_result.rule, .approval_id = null };
    }
    // Laya reads command text; a bare path inside the task root told it nothing.
    if (l1_result.verdict == .allow and action.kind != .execute) {
        return .{ .verdict = .allow, .layer = .L1, .reason = l1_result.reason, .rule = l1_result.rule, .approval_id = null };
    }
    var l2_result: ?l2.Result = null;
    if (l1_result.verdict == .allow) {
        const judged = try l2.escalate(a, client, .{ .request = run.prompt, .command = command }, l1_result);
        l2_result = judged;
        try logLayer(app, run, .L2, judged.verdict, @tagName(judged.source), command, judged.reason);
        if (judged.verdict != .ask) {
            const denied = judged.verdict == .deny;
            return .{
                .verdict = if (denied) .deny else .allow,
                .layer = if (judged.source == .laya) .L2 else .L1,
                .reason = judged.reason,
                .rule = if (denied) @tagName(judged.source) else l1_result.rule,
                .approval_id = null,
            };
        }
    }
    return askHuman(a, app, run, action, ask.title, l1_result, l2_result, opts);
}

test {
    _ = @import("check_test.zig");
}
