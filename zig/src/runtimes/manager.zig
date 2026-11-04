//! Run rows, the run state machine and the live-run table. Port of runs-repo.ts, manager.ts,
//! outcome.ts and shutdown.ts in code/src/server/features/runtimes.
//!
//! Locking: every database call happens inside `App.withLock`. The live table has its own mutex,
//! never held across the database lock, a spawn or a wait. The other slices the TS manager calls
//! directly (events with redaction, usage, guard, tokens, realtime) are reached through `Links`,
//! so this file depends on none of them.
const std = @import("std");
const app_mod = @import("../app.zig");
const sqlite = @import("../db/sqlite.zig");
const ids = @import("../ids.zig");
const types = @import("types.zig");
const acp = @import("acp.zig");
const launch_mod = @import("launch.zig");
const process_mod = @import("process.zig");

const Io = std.Io;
const Allocator = std.mem.Allocator;

pub const default_idle_timeout_ms = 300_000;
const finalize_attempts = 4;
/// Added to the approval timeout, which the guard enforces itself, so the lane's own cut-off
/// only fires when the guard hangs (APPROVAL_SLACK_MS in manager.ts).
pub const approval_slack_ms = 30_000;

pub const RunState = enum {
    queued,
    starting,
    running,
    completed,
    failed,
    blocked,
    cancelled,
    killed,

    pub fn isLive(state: RunState) bool {
        return state == .queued or state == .starting or state == .running;
    }
};

pub const RunRow = struct {
    id: []const u8,
    task_id: ?[]const u8,
    member_id: ?[]const u8,
    agent_id: []const u8,
    model: ?[]const u8,
    repo: []const u8,
    worktree: ?[]const u8,
    branch: ?[]const u8,
    prompt: []const u8,
    state: RunState,
    reason: ?[]const u8,
    created_at: i64,
    started_at: ?i64,
    ended_at: ?i64,
    attempt: i64,
    batch_id: ?[]const u8,
};

pub const NewRun = struct {
    id: []const u8,
    task_id: ?[]const u8 = null,
    member_id: ?[]const u8 = null,
    project_id: ?[]const u8 = null,
    charged_to: ?[]const u8 = null,
    agent_id: []const u8,
    model: ?[]const u8 = null,
    repo: []const u8,
    prompt: []const u8,
    attempt: i64 = 1,
    batch_id: ?[]const u8 = null,
};

fn bindOpt(stmt: sqlite.Stmt, index: c_int, value: ?[]const u8) sqlite.Error!void {
    if (value) |text| try stmt.bindText(index, text) else try stmt.bindNull(index);
}

fn optText(stmt: sqlite.Stmt, a: Allocator, column: c_int) (sqlite.Error || Allocator.Error)!?[]const u8 {
    return try stmt.textAlloc(a, column);
}

fn optInt(stmt: sqlite.Stmt, column: c_int) ?i64 {
    return if (stmt.isNull(column)) null else stmt.int(column);
}

const select_run = "SELECT id, task_id, member_id, agent_id, model, repo, worktree, branch, prompt, state, reason, " ++
    "created_at, started_at, ended_at, attempt, batch_id FROM runs";

fn readRow(stmt: sqlite.Stmt, a: Allocator) !RunRow {
    const state_text = (try stmt.text(9)) orelse return error.CorruptRun;
    return .{
        .id = (try optText(stmt, a, 0)).?,
        .task_id = try optText(stmt, a, 1),
        .member_id = try optText(stmt, a, 2),
        .agent_id = (try optText(stmt, a, 3)).?,
        .model = try optText(stmt, a, 4),
        .repo = (try optText(stmt, a, 5)).?,
        .worktree = try optText(stmt, a, 6),
        .branch = try optText(stmt, a, 7),
        .prompt = (try optText(stmt, a, 8)).?,
        .state = std.meta.stringToEnum(RunState, state_text) orelse return error.CorruptRun,
        .reason = try optText(stmt, a, 10),
        .created_at = stmt.int(11),
        .started_at = optInt(stmt, 12),
        .ended_at = optInt(stmt, 13),
        .attempt = stmt.int(14),
        .batch_id = try optText(stmt, a, 15),
    };
}

pub fn insertRun(db: sqlite.Db, run: NewRun, now_ms: i64) !void {
    const stmt = try db.prepare("INSERT INTO runs (id, task_id, member_id, project_id, agent_id, model, repo, prompt, state, " ++
        "created_at, attempt, batch_id, charged_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)");
    defer stmt.finalize();
    try stmt.bindText(1, run.id);
    try bindOpt(stmt, 2, run.task_id);
    try bindOpt(stmt, 3, run.member_id);
    try bindOpt(stmt, 4, run.project_id);
    try stmt.bindText(5, run.agent_id);
    try bindOpt(stmt, 6, run.model);
    try stmt.bindText(7, run.repo);
    try stmt.bindText(8, run.prompt);
    try stmt.bindInt(9, now_ms);
    try stmt.bindInt(10, run.attempt);
    try bindOpt(stmt, 11, run.batch_id);
    try bindOpt(stmt, 12, run.charged_to);
    _ = try stmt.step();
}

fn rowsChanged(db: sqlite.Db) !i64 {
    const stmt = try db.prepare("SELECT changes()");
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

/// False when the run has already ended (shutdown got there first): its row is left alone.
pub fn setStarting(db: sqlite.Db, id: []const u8, worktree: ?[]const u8, branch: ?[]const u8) !bool {
    const stmt = try db.prepare("UPDATE runs SET worktree = ?, branch = ?, state = 'starting' WHERE id = ? AND ended_at IS NULL");
    defer stmt.finalize();
    try bindOpt(stmt, 1, worktree);
    try bindOpt(stmt, 2, branch);
    try stmt.bindText(3, id);
    _ = try stmt.step();
    return try rowsChanged(db) > 0;
}

/// False when the run has already ended.
pub fn markRunning(db: sqlite.Db, id: []const u8, now_ms: i64) !bool {
    const stmt = try db.prepare("UPDATE runs SET state = 'running', started_at = ? WHERE id = ? AND ended_at IS NULL");
    defer stmt.finalize();
    try stmt.bindInt(1, now_ms);
    try stmt.bindText(2, id);
    _ = try stmt.step();
    return try rowsChanged(db) > 0;
}

pub fn markEnded(db: sqlite.Db, id: []const u8, state: RunState, reason: ?[]const u8, now_ms: i64) !void {
    const stmt = try db.prepare("UPDATE runs SET state = ?, reason = ?, ended_at = ? WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, @tagName(state));
    try bindOpt(stmt, 2, reason);
    try stmt.bindInt(3, now_ms);
    try stmt.bindText(4, id);
    _ = try stmt.step();
}

pub fn setPid(db: sqlite.Db, id: []const u8, pid: i64, identity: ?[]const u8) !void {
    const stmt = try db.prepare("UPDATE runs SET pid = ?, pid_identity = ? WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindInt(1, pid);
    try bindOpt(stmt, 2, identity);
    try stmt.bindText(3, id);
    _ = try stmt.step();
}

/// Strings are allocated from `a`.
pub fn getRun(db: sqlite.Db, a: Allocator, id: []const u8) !?RunRow {
    const stmt = try db.prepare(select_run ++ " WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if (!try stmt.step()) return null;
    return try readRow(stmt, a);
}

pub fn listRuns(db: sqlite.Db, a: Allocator, limit: i64) ![]RunRow {
    const stmt = try db.prepare(select_run ++ " ORDER BY created_at DESC, id DESC LIMIT ?");
    defer stmt.finalize();
    try stmt.bindInt(1, limit);
    var rows: std.ArrayList(RunRow) = .empty;
    while (try stmt.step()) try rows.append(a, try readRow(stmt, a));
    return rows.toOwnedSlice(a);
}

pub fn listLiveRuns(db: sqlite.Db, a: Allocator) ![]RunRow {
    const stmt = try db.prepare(select_run ++ " WHERE state IN ('queued', 'starting', 'running')");
    defer stmt.finalize();
    var rows: std.ArrayList(RunRow) = .empty;
    while (try stmt.step()) try rows.append(a, try readRow(stmt, a));
    return rows.toOwnedSlice(a);
}

/// Returns how many rows changed.
pub fn failLiveRuns(db: sqlite.Db, reason: []const u8, now_ms: i64) !i64 {
    const stmt = try db.prepare("UPDATE runs SET state = 'failed', reason = ?, ended_at = ? " ++
        "WHERE state IN ('queued', 'starting', 'running')");
    defer stmt.finalize();
    try stmt.bindText(1, reason);
    try stmt.bindInt(2, now_ms);
    _ = try stmt.step();
    const changes = try db.prepare("SELECT changes()");
    defer changes.finalize();
    _ = try changes.step();
    return changes.int(0);
}

pub fn getFlag(db: sqlite.Db, a: Allocator, key: []const u8) !?[]const u8 {
    const stmt = try db.prepare("SELECT value FROM instance_flags WHERE key = ?");
    defer stmt.finalize();
    try stmt.bindText(1, key);
    if (!try stmt.step()) return null;
    return try optText(stmt, a, 0);
}

pub fn setFlag(db: sqlite.Db, key: []const u8, value: []const u8) !void {
    const stmt = try db.prepare("INSERT INTO instance_flags (key, value) VALUES (?, ?) " ++
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    defer stmt.finalize();
    try stmt.bindText(1, key);
    try stmt.bindText(2, value);
    _ = try stmt.step();
}

pub fn hasExpiredApproval(db: sqlite.Db, run_id: []const u8) !bool {
    const stmt = try db.prepare("SELECT count(*) FROM approvals WHERE run_id = ? AND status = 'expired'");
    defer stmt.finalize();
    try stmt.bindText(1, run_id);
    _ = try stmt.step();
    return stmt.int(0) > 0;
}

/// A plain INSERT into events for tests and for a server without the logs slice. Production
/// wires the logs slice's append instead, which redacts secrets and indexes the body: this one
/// does neither.
pub fn insertEventPlain(db: sqlite.Db, event: types.NewEvent, id: []const u8, now_ms: i64) !void {
    const stmt = try db.prepare("INSERT INTO events (id, ts, run_id, task_id, agent, kind, gen_ai_operation_name, " ++
        "gen_ai_tool_name, gen_ai_conversation_id, gen_ai_request_model, gen_ai_usage_input_tokens, " ++
        "gen_ai_usage_output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, reported_cost_usd, " ++
        "command, exit_code, duration_ms, guard_layer, guard_verdict, guard_rule, source, dedupe_key) " ++
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    try stmt.bindInt(2, event.ts orelse now_ms);
    try bindOpt(stmt, 3, event.run_id);
    try bindOpt(stmt, 4, event.task_id);
    try bindOpt(stmt, 5, event.agent);
    try stmt.bindText(6, @tagName(event.kind));
    try bindOpt(stmt, 7, event.operation);
    try bindOpt(stmt, 8, event.tool_name);
    try bindOpt(stmt, 9, event.conversation_id);
    try bindOpt(stmt, 10, event.model);
    inline for (.{ event.input_tokens, event.output_tokens, event.cache_read_tokens, event.cache_write_tokens, event.reasoning_tokens }, 11..) |value, index| {
        if (value) |n| try stmt.bindInt(index, n) else try stmt.bindNull(index);
    }
    if (event.reported_cost_usd) |cost| try stmt.bindReal(16, cost) else try stmt.bindNull(16);
    try bindOpt(stmt, 17, event.command);
    if (event.exit_code) |n| try stmt.bindInt(18, n) else try stmt.bindNull(18);
    if (event.duration_ms) |n| try stmt.bindInt(19, n) else try stmt.bindNull(19);
    try bindOpt(stmt, 20, if (event.guard_layer) |layer| @tagName(layer) else null);
    try bindOpt(stmt, 21, if (event.guard_verdict) |verdict| @tagName(verdict) else null);
    try bindOpt(stmt, 22, event.guard_rule);
    try bindOpt(stmt, 23, event.source);
    try bindOpt(stmt, 24, event.dedupe_key);
    _ = try stmt.step();
    // As indexEvent in logs/repo.ts: the raw body waits in pending_payloads for the logs slice to
    // seal it, and both text indexes are fed.
    const rowid_stmt = try db.prepare("SELECT last_insert_rowid()");
    defer rowid_stmt.finalize();
    _ = try rowid_stmt.step();
    const rowid = rowid_stmt.int(0);
    if (event.body) |body| {
        const payload = try db.prepare("INSERT INTO pending_payloads (event_rowid, run_id, body) VALUES (?, ?, ?)");
        defer payload.finalize();
        try payload.bindInt(1, rowid);
        try bindOpt(payload, 2, event.run_id);
        try payload.bindText(3, body);
        _ = try payload.step();
        const fts = try db.prepare("INSERT INTO events_fts (rowid, body) VALUES (?, ?)");
        defer fts.finalize();
        try fts.bindInt(1, rowid);
        try fts.bindText(2, body);
        _ = try fts.step();
    }
    if (event.command) |command| {
        const fts = try db.prepare("INSERT INTO commands_fts (rowid, text) VALUES (?, ?)");
        defer fts.finalize();
        try fts.bindInt(1, rowid);
        try fts.bindText(2, command);
        _ = try fts.step();
    }
}

const rate_limit_words = [_][]const u8{ "ratelimit", "quota", "usage limit", "overloaded" };

/// /rate.?limit|\b429\b|quota|usage limit|overloaded/i from outcome.ts.
pub fn looksRateLimited(text: []const u8) bool {
    for (rate_limit_words) |word| {
        if (std.ascii.findIgnoreCase(text, word) != null) return true;
    }
    var from: usize = 0;
    while (std.ascii.findIgnoreCasePos(text, from, "rate")) |at| : (from = at + 1) {
        const rest = text[at + 4 ..];
        if (rest.len >= 6 and std.ascii.startsWithIgnoreCase(rest[1..], "limit")) return true;
    }
    from = 0;
    while (std.mem.findPos(u8, text, from, "429")) |at| : (from = at + 1) {
        const before_ok = at == 0 or !isWordChar(text[at - 1]);
        const after_ok = at + 3 >= text.len or !isWordChar(text[at + 3]);
        if (before_ok and after_ok) return true;
    }
    return false;
}

fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

pub const End = struct { state: RunState, reason: ?[]const u8 };

/// How a run ended, from what the lane reported (endState in outcome.ts).
pub fn endState(
    kill_reason: ?[]const u8,
    expired_approval: bool,
    denied: bool,
    quota_full: bool,
    outcome: *const types.Outcome,
) End {
    if (kill_reason) |reason| return .{ .state = .killed, .reason = reason };
    if (expired_approval) return .{ .state = .blocked, .reason = "approval_timeout" };
    return switch (outcome.stop_reason) {
        .end_turn => .{ .state = .completed, .reason = null },
        .cancelled => if (denied) .{ .state = .blocked, .reason = "guard_denied" } else .{ .state = .cancelled, .reason = null },
        .refusal => .{ .state = .failed, .reason = "refusal" },
        .max_tokens => .{ .state = .failed, .reason = "max_tokens" },
        .@"error", .timeout => blk: {
            if (quota_full or looksRateLimited(outcome.error_text orelse "")) break :blk .{ .state = .failed, .reason = "rate_limited" };
            break :blk .{ .state = .failed, .reason = outcome.error_text orelse @tagName(outcome.stop_reason) };
        },
    };
}

/// What other slices plug in. All optional: without `decide` every permission request is denied,
/// the fail-closed default.
pub const Links = struct {
    ctx: ?*anyopaque = null,
    /// Appends an event; runs under the App lock. Defaults to `insertEventPlain`. The end event of
    /// a run is appended inside a transaction the manager has opened, so an implementation must
    /// not BEGIN its own (use a savepoint).
    append_event: ?*const fn (ctx: ?*anyopaque, db: sqlite.Db, event: types.NewEvent, now_ms: i64) anyerror!void = null,
    /// Realtime and anything else that listens to run events. Runs outside the lock; the event is
    /// borrowed for the call.
    on_event: ?*const fn (ctx: ?*anyopaque, event: types.NewEvent) void = null,
    /// The guard. May block for an approval; it must wait through cancelable Io calls.
    decide: ?*const fn (ctx: ?*anyopaque, run_id: []const u8, ask: types.Ask) anyerror!types.Verdict = null,
    record_usage: ?*const fn (ctx: ?*anyopaque, db: sqlite.Db, run_id: []const u8, agent: []const u8, conversation_id: ?[]const u8, usage: []const types.UsageRecord) anyerror!void = null,
    record_quota: ?*const fn (ctx: ?*anyopaque, db: sqlite.Db, quota: types.Quota) anyerror!void = null,
    /// Expires the run's pending approvals; runs under the lock.
    expire_approvals: ?*const fn (ctx: ?*anyopaque, db: sqlite.Db, run_id: []const u8) void = null,
    /// Seals the run's log segments and revokes its tokens; runs under the lock after the run ends.
    release_run: ?*const fn (ctx: ?*anyopaque, db: sqlite.Db, run_id: []const u8) void = null,
    /// Where error-level failures go instead of the log, for alerting.
    report_error: ?*const fn (ctx: ?*anyopaque, message: []const u8) void = null,
    /// Context fill reported by the agent; the circuit breaker listens.
    on_progress: ?*const fn (ctx: ?*anyopaque, run_id: []const u8, context_tokens: i64) void = null,
};

pub const StartInput = struct {
    spec: types.Spec,
    repo: []const u8,
    prompt: []const u8,
    model: ?[]const u8 = null,
    task_id: ?[]const u8 = null,
    member_id: ?[]const u8 = null,
    project_id: ?[]const u8 = null,
    charged_to: ?[]const u8 = null,
    attempt: i64 = 1,
    batch_id: ?[]const u8 = null,
    inject_terminate_failures: u32 = 0,
    /// Test hook: the scrubbed run env carries nothing a fake agent needs, so its script arrives here.
    extra_env: []const launch_mod.Extra = &.{},
};

const Live = struct {
    arena: std.heap.ArenaAllocator,
    manager: *Manager,
    id: []const u8,
    agent: []const u8,
    input: StartInput,
    abort: Io.Event = .unset,
    /// Set once under `Manager.mutex`, never changed or freed before the Live is.
    kill_reason: ?[]const u8 = null,
    denied: std.atomic.Value(bool) = .init(false),
    quota_full: std.atomic.Value(bool) = .init(false),
    pid: std.atomic.Value(std.posix.pid_t) = .init(0),
    /// Both under `Manager.mutex`. An orphaned record is freed by whichever of the owner task and
    /// shutdown comes second, so it is never freed under a task that has not returned.
    owner_done: bool = false,
    /// The agent process of a run whose group could not be ended, kept (under `Manager.mutex`)
    /// with its pgid published so shutdown retries the kill. The record stays registered.
    survivor: ?*process_mod.Process = null,
    shutdown_took: bool = false,
    /// Set under `Manager.mutex` when the run's own task could not write its end state. The record
    /// then stays registered, so shutdown retries the finalize with the intended outcome and
    /// frees it.
    orphaned: bool = false,
    pending_state: RunState = .failed,
    pending_reason: ?[]const u8 = null,
};

pub const Manager = struct {
    app: *app_mod.App,
    gpa: Allocator,
    io: Io,
    links: Links,
    /// The server's environment, scrubbed per run.
    parent_env: *const std.process.Environ.Map,
    idle_timeout_ms: i64 = default_idle_timeout_ms,
    approval_timeout_ms: ?i64 = null,
    mutex: Io.Mutex = .init,
    live: std.StringHashMapUnmanaged(*Live) = .empty,
    tasks: Io.Group = .init,
    shutting_down: std.atomic.Value(bool) = .init(false),
    /// `startRun` calls between their admission check and their registration (or refusal), under
    /// `mutex`. Shutdown waits for them, or its caller could tear the manager down under them.
    starters: u32 = 0,
    /// How many agent groups the last `shutdown` could not end; those runs stay registered.
    survivors_after_shutdown: usize = 0,
    /// Test hook: that many end-state writes fail with Busy, like a locked database.
    inject_end_failures: std.atomic.Value(u32) = .init(0),
    /// Test hooks: that many event appends, or approval-expiry reads, fail with Busy.
    inject_append_failures: std.atomic.Value(u32) = .init(0),
    inject_expired_failures: std.atomic.Value(u32) = .init(0),
    /// Test hooks: `orphan_reached` is set, then the task waits for `orphan_gate`, right after a
    /// run is flagged orphaned. `signal_count` counts the signals shutdown sends to agent groups.
    orphan_reached: ?*Io.Event = null,
    orphan_gate: ?*Io.Event = null,
    signal_count: std.atomic.Value(u32) = .init(0),
    /// Test hooks: `startRun` sets `admission_reached` and then waits for `admission_gate` between
    /// persisting the row and registering the run.
    admission_reached: ?*Io.Event = null,
    admission_gate: ?*Io.Event = null,

    pub fn init(app: *app_mod.App, links: Links, parent_env: *const std.process.Environ.Map) Manager {
        return .{ .app = app, .gpa = app.gpa, .io = app.io, .links = links, .parent_env = parent_env };
    }

    /// Call after a `shutdown` that returned without error, or when no run is live. A record
    /// that is still registered (a failed shutdown left an agent group alive) is the only owner
    /// able to end that group, so it is neither freed nor forgotten silently: deinit reports it at
    /// error level and leaks the registry instead.
    pub fn deinit(m: *Manager) void {
        m.tasks.cancel(m.io);
        if (m.live.count() > 0) {
            m.loud("deinit with {d} run(s) still registered: their records are leaked on purpose", .{m.live.count()});
            return;
        }
        m.live.deinit(m.gpa);
    }

    fn lock(m: *Manager) void {
        m.mutex.lockUncancelable(m.io);
    }

    fn unlock(m: *Manager) void {
        m.mutex.unlock(m.io);
    }

    // The database, always through the App lock.

    fn dbOf(state: *app_mod.State) error{NoDatabase}!sqlite.Db {
        return .{ .handle = state.db orelse return error.NoDatabase };
    }

    const InsertCtx = struct { run: NewRun, now_ms: i64 };

    fn insertLocked(ctx: InsertCtx, state: *app_mod.State) !void {
        try insertRun(try dbOf(state), ctx.run, ctx.now_ms);
    }

    const StartingCtx = struct { id: []const u8, now_ms: i64 };

    const Begin = enum { started, halted, ended };

    /// Moves a queued run to running unless the harness is halted or the run was already ended.
    fn beginLocked(ctx: StartingCtx, state: *app_mod.State) !Begin {
        const db = try dbOf(state);
        if (!try setStarting(db, ctx.id, null, null)) return .ended;
        var buffer: [8]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&buffer);
        const halted = try getFlag(db, fba.allocator(), "halted");
        if (halted != null and std.mem.eql(u8, halted.?, "1")) return .halted;
        if (!try markRunning(db, ctx.id, ctx.now_ms)) return .ended;
        return .started;
    }

    const EventCtx = struct { m: *Manager, event: types.NewEvent, now_ms: i64, id: []const u8 };

    fn appendIn(m: *Manager, db: sqlite.Db, event: types.NewEvent, now_ms: i64, id: []const u8) !void {
        if (takeInjected(&m.inject_append_failures)) return error.Busy;
        if (m.links.append_event) |append| return append(m.links.ctx, db, event, now_ms);
        try insertEventPlain(db, event, id, now_ms);
    }

    fn appendLocked(ctx: EventCtx, state: *app_mod.State) !void {
        try ctx.m.appendIn(try dbOf(state), ctx.event, ctx.now_ms, ctx.id);
    }

    /// Persists an event, then tells the listeners. A failed append is returned to the lane,
    /// which ends the run as a fault.
    pub fn publish(m: *Manager, event: types.NewEvent) !void {
        const id = ids.uuidV7(m.io);
        try m.app.withLock(EventCtx{ .m = m, .event = event, .now_ms = ids.nowMs(m.io), .id = &id }, appendLocked);
        if (m.links.on_event) |listener| listener(m.links.ctx, event);
    }

    /// Unregisters a run, except one that still owns a surviving agent process.
    fn removeLive(m: *Manager, id: []const u8) void {
        m.lock();
        defer m.unlock();
        if (m.live.get(id)) |live| {
            if (live.survivor != null) return;
        }
        _ = m.live.remove(id);
    }

    const FinalizeCtx = struct {
        m: *Manager,
        id: []const u8,
        agent: []const u8,
        state: RunState,
        reason: ?[]const u8,
        now_ms: i64,
    };

    const EndEventCtx = struct { fin: FinalizeCtx, body: []const u8, event_id: []const u8 };

    /// One transaction ends the run and appends its end event: the UPDATE only changes a row that
    /// has no ended_at, so only that caller gets true, and an append that fails rolls the end back
    /// so a retry publishes the event.
    fn endWithEvent(ctx: EndEventCtx, state: *app_mod.State) !bool {
        return (try dbOf(state)).transaction(ctx, endWithEventTx);
    }

    fn endWithEventTx(ctx: EndEventCtx, db: sqlite.Db) !bool {
        const fin = ctx.fin;
        if (takeInjected(&fin.m.inject_end_failures)) return error.Busy;
        const stmt = try db.prepare("UPDATE runs SET state = ?, reason = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL");
        defer stmt.finalize();
        try stmt.bindText(1, @tagName(fin.state));
        try bindOpt(stmt, 2, fin.reason);
        try stmt.bindInt(3, fin.now_ms);
        try stmt.bindText(4, fin.id);
        _ = try stmt.step();
        if (try rowsChanged(db) == 0) return false;
        try fin.m.appendIn(db, .{ .kind = .run, .run_id = fin.id, .agent = fin.agent, .body = ctx.body }, fin.now_ms, ctx.event_id);
        return true;
    }

    fn releaseLocked(ctx: FinalizeCtx, state: *app_mod.State) void {
        const db = dbOf(state) catch |err| {
            std.log.warn("run {s}: not released: {t}", .{ ctx.id, err });
            return;
        };
        if (ctx.m.links.release_run) |release| release(ctx.m.links.ctx, db, ctx.id);
        if (ctx.m.links.expire_approvals) |expire| expire(ctx.m.links.ctx, db, ctx.id);
    }

    /// Ends the run once. Shutdown and the lane's own return can both end the same run; the first
    /// one wins and only it releases (finalize in manager.ts). The end and its event are one
    /// transaction. A failed write leaves the run registered and is returned, so the caller can
    /// retry.
    pub fn finalize(m: *Manager, id: []const u8, agent: []const u8, state: RunState, reason: ?[]const u8) !void {
        const fin: FinalizeCtx = .{ .m = m, .id = id, .agent = agent, .state = state, .reason = reason, .now_ms = ids.nowMs(m.io) };
        // The whole reason is stored, as in TS: `${state}: ${reason}` with no cap.
        const body = if (reason) |text|
            try std.fmt.allocPrint(m.gpa, "{t}: {s}", .{ state, text })
        else
            try m.gpa.dupe(u8, @tagName(state));
        defer m.gpa.free(body);
        const event_id = ids.uuidV7(m.io);
        const changed = try m.app.withLock(EndEventCtx{ .fin = fin, .body = body, .event_id = &event_id }, endWithEvent);
        defer m.removeLive(id);
        if (!changed) return;
        defer m.app.withLock(fin, releaseLocked);
        if (m.links.on_event) |listener| listener(m.links.ctx, .{ .kind = .run, .run_id = id, .agent = agent, .body = body });
    }

    /// Whether the run has an expired approval; null when the read keeps failing.
    fn readExpiredApproval(m: *Manager, id: []const u8) ?bool {
        var attempt: i64 = 1;
        while (attempt <= 3) : (attempt += 1) {
            if (m.app.withLock(EndCtx{ .m = m, .id = id }, expiredLocked)) |expired| return expired else |err| {
                std.log.warn("run {s}: approval check attempt {d} failed: {t}", .{ id, attempt, err });
                if (attempt < 3) m.io.sleep(.fromMilliseconds(20 * attempt), .awake) catch return null;
            }
        }
        m.loud("run {s}: approval check failed, failing the run closed", .{id});
        return null;
    }

    /// Error-level report of a failure that leaves data wrong or a run unowned. `Links.report_error`
    /// replaces the log line when the server wants to alert on it.
    fn loud(m: *Manager, comptime fmt: []const u8, args: anytype) void {
        var buffer: [512]u8 = undefined;
        const message = std.fmt.bufPrint(&buffer, fmt, args) catch buffer[0..];
        if (m.links.report_error) |report| return report(m.links.ctx, message);
        std.log.err("{s}", .{message});
    }

    /// Bounded retries with a short backoff for a transient failure such as Busy.
    fn finalizeRetrying(m: *Manager, id: []const u8, agent: []const u8, state: RunState, reason: ?[]const u8) bool {
        var attempt: i64 = 1;
        while (attempt <= finalize_attempts) : (attempt += 1) {
            if (m.finalize(id, agent, state, reason)) return true else |err| {
                std.log.warn("run {s}: finalize attempt {d} failed: {t}", .{ id, attempt, err });
                if (attempt < finalize_attempts) m.io.sleep(.fromMilliseconds(20 * attempt), .awake) catch return false;
            }
        }
        m.loud("run {s} could not be finalized as {t}: it stays registered as finalize_failed until shutdown", .{ id, state });
        return false;
    }

    /// Ends a run, or keeps its record flagged with the intended outcome when the write keeps
    /// failing. True when the run ended and its record can be freed.
    fn endOrOrphan(m: *Manager, live: *Live, state: RunState, reason: ?[]const u8) bool {
        if (m.finalizeRetrying(live.id, live.agent, state, reason)) return true;
        {
            m.lock();
            defer m.unlock();
            live.orphaned = true;
            live.pending_state = state;
            live.pending_reason = if (reason) |text| live.arena.allocator().dupe(u8, text) catch null else null;
        }
        m.pauseAfterOrphan();
        return false;
    }

    /// Registers a surviving agent process with its run, flagged orphaned, so the record stays
    /// until shutdown has killed and freed the process.
    fn keepSurvivor(m: *Manager, live: *Live, proc: *process_mod.Process, reason: ?[]const u8) void {
        m.lock();
        defer m.unlock();
        live.survivor = proc;
        live.orphaned = true;
        live.pending_state = .failed;
        live.pending_reason = if (reason) |text| live.arena.allocator().dupe(u8, text) catch null else null;
    }

    fn clearPid(m: *Manager, live: *Live) void {
        m.lock();
        defer m.unlock();
        live.pid.store(0, .release);
    }

    fn pauseAfterOrphan(m: *Manager) void {
        if (m.orphan_reached) |event| event.set(m.io);
        if (m.orphan_gate) |gate| gate.waitUncancelable(m.io);
    }

    // Live runs.

    pub fn isHalted(m: *Manager) !bool {
        return m.app.withLock({}, haltedLocked);
    }

    fn haltedLocked(_: void, state: *app_mod.State) !bool {
        var buffer: [8]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&buffer);
        const value = try getFlag(try dbOf(state), fba.allocator(), "halted");
        return value != null and std.mem.eql(u8, value.?, "1");
    }

    const KillCtx = struct { m: *Manager, id: []const u8 };

    fn expireLocked(ctx: KillCtx, state: *app_mod.State) void {
        const db = dbOf(state) catch |err| {
            std.log.warn("run {s}: approvals not expired on kill: {t}", .{ ctx.id, err });
            return;
        };
        if (ctx.m.links.expire_approvals) |expire| expire(ctx.m.links.ctx, db, ctx.id);
    }

    /// Aborts a live run. The reason sticks to the first kill. False when no such run is live.
    pub fn killRun(m: *Manager, id: []const u8, reason: []const u8) !bool {
        {
            m.lock();
            defer m.unlock();
            const run = m.live.get(id) orelse return false;
            if (run.kill_reason == null) run.kill_reason = try run.arena.allocator().dupe(u8, reason);
            run.abort.set(m.io);
        }
        m.app.withLock(KillCtx{ .m = m, .id = id }, expireLocked);
        return true;
    }

    const FlagCtx = struct { value: []const u8 };

    fn haltFlagLocked(ctx: FlagCtx, state: *app_mod.State) !void {
        try setFlag(try dbOf(state), "halted", ctx.value);
    }

    pub fn setHalted(m: *Manager, halted: bool) !void {
        try m.app.withLock(FlagCtx{ .value = if (halted) "1" else "0" }, haltFlagLocked);
        if (!halted) return;
        var arena: std.heap.ArenaAllocator = .init(m.gpa);
        defer arena.deinit();
        for (try m.liveIds(arena.allocator())) |id| _ = try m.killRun(id, "halted");
    }

    fn liveIds(m: *Manager, a: Allocator) ![]const []const u8 {
        m.lock();
        defer m.unlock();
        var list: std.ArrayList([]const u8) = .empty;
        var it = m.live.keyIterator();
        while (it.next()) |key| try list.append(a, try a.dupe(u8, key.*));
        return list.toOwnedSlice(a);
    }

    /// Runs whose task is still working; a record kept for a failed finalize does not count.
    fn activeCount(m: *Manager) usize {
        m.lock();
        defer m.unlock();
        var n: usize = 0;
        var it = m.live.valueIterator();
        while (it.next()) |entry| {
            if (!entry.*.orphaned) n += 1;
        }
        return n;
    }

    pub fn liveCount(m: *Manager) usize {
        m.lock();
        defer m.unlock();
        return m.live.count();
    }

    /// Starts a run and returns its id; the lane runs on a task of the manager. Launch failures
    /// end the run as failed before this returns.
    pub fn startRun(m: *Manager, input: StartInput) ![ids.uuid_len]u8 {
        {
            m.lock();
            defer m.unlock();
            if (m.shutting_down.load(.acquire)) return error.ShuttingDown;
            m.starters += 1;
        }
        defer {
            m.lock();
            m.starters -= 1;
            m.unlock();
        }
        const id = ids.uuidV7(m.io);
        const live = try m.gpa.create(Live);
        live.* = .{ .arena = .init(m.gpa), .manager = m, .id = undefined, .agent = undefined, .input = undefined };
        var handed_off = false;
        errdefer if (!handed_off) {
            live.arena.deinit();
            m.gpa.destroy(live);
        };
        const a = live.arena.allocator();
        live.id = try a.dupe(u8, &id);
        live.agent = try a.dupe(u8, input.spec.id);
        live.input = try cloneInput(a, input);

        try m.app.withLock(InsertCtx{
            .run = .{
                .id = live.id,
                .task_id = input.task_id,
                .member_id = input.member_id,
                .project_id = input.project_id,
                .charged_to = input.charged_to,
                .agent_id = input.spec.id,
                .model = input.model,
                .repo = input.repo,
                .prompt = input.prompt,
                .attempt = input.attempt,
                .batch_id = input.batch_id,
            },
            .now_ms = ids.nowMs(m.io),
        }, insertLocked);

        if (m.admission_reached) |event| event.set(m.io);
        if (m.admission_gate) |gate| gate.waitUncancelable(m.io);
        // Admission and the shutdown flag share one lock: a run registered here is seen by the
        // shutdown scan, and one that comes later is refused, so no agent outlives shutdown.
        var put_failed = false;
        const admitted = blk: {
            m.lock();
            defer m.unlock();
            if (m.shutting_down.load(.acquire)) break :blk false;
            m.live.put(m.gpa, live.id, live) catch {
                put_failed = true;
                break :blk false;
            };
            break :blk true;
        };
        handed_off = true;
        if (put_failed) {
            // The row exists as queued and has no owner: end it, or it would stay queued forever.
            m.endUnstarted(live, "failed", "admission failed", error.OutOfMemory);
            return error.OutOfMemory;
        }
        if (!admitted) {
            m.endUnstarted(live, "killed", "harness_shutdown", null);
            return error.ShuttingDown;
        }
        const started = m.app.withLock(StartingCtx{ .id = live.id, .now_ms = ids.nowMs(m.io) }, beginLocked) catch |err| {
            m.endUnstarted(live, "failed", "internal_error", err);
            return id;
        };
        switch (started) {
            .started => {},
            .halted => {
                m.endUnstarted(live, "killed", "halted", null);
                return id;
            },
            .ended => {
                // Shutdown ended the row between admission and now: nothing to start or finalize.
                m.endUnstarted(live, "killed", "harness_shutdown", null);
                return id;
            },
        }
        m.tasks.concurrent(m.io, runTask, .{live}) catch |err| {
            m.endUnstarted(live, "failed", "internal_error", err);
            return id;
        };
        return id;
    }

    /// Ends a run whose lane never started and frees its record.
    fn endUnstarted(m: *Manager, live: *Live, state: []const u8, reason: []const u8, err: ?anyerror) void {
        if (err) |e| std.log.warn("run {s} did not start: {t}", .{ live.id, e });
        const end_state = std.meta.stringToEnum(RunState, state).?;
        _ = m.endOrOrphan(live, end_state, reason);
        destroyLive(live);
    }

    /// A launch that fails publishes the cause and ends the run as launch_failed (prepare in
    /// manager.ts).
    fn failLaunch(m: *Manager, live: *Live, err: anyerror) void {
        var buffer: [128]u8 = undefined;
        const body = std.fmt.bufPrint(&buffer, "launch failed: {t}", .{err}) catch "launch failed";
        m.publish(.{ .kind = .@"error", .run_id = live.id, .agent = live.agent, .task_id = live.input.task_id, .body = body }) catch |publish_err| {
            std.log.warn("run {s}: launch failure event lost: {t}", .{ live.id, publish_err });
        };
        _ = m.endOrOrphan(live, .failed, "launch_failed");
    }

    /// Stops every live run: abort and SIGTERM, then SIGKILL on the agent groups once `grace_ms`
    /// is over, then end whatever is still registered so nothing outlives the harness. Returns
    /// error.AgentSurvived, with the count in `survivors_after_shutdown`, when an agent group
    /// could not be ended after the bounded retries: those runs stay registered, and calling
    /// `shutdown` again retries them. `deinit` must not follow a failed shutdown.
    pub fn shutdown(m: *Manager, grace_ms: i64) !void {
        m.lock();
        {
            defer m.unlock();
            m.shutting_down.store(true, .release);
            var it = m.live.valueIterator();
            while (it.next()) |entry| {
                const run = entry.*;
                if (run.kill_reason == null) run.kill_reason = "harness_shutdown";
                run.abort.set(m.io);
                const pid = run.pid.load(.acquire);
                if (pid != 0) {
                    _ = m.signal_count.fetchAdd(1, .monotonic);
                    process_mod.signalGroup(pid, .TERM);
                }
            }
        }
        m.waitStarters(5000);
        try m.waitLiveEmpty(grace_ms);
        m.signalAll(.KILL);
        try m.waitLiveEmpty(1000);

        var arena: std.heap.ArenaAllocator = .init(m.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const Straggler = struct { id: []const u8, agent: []const u8, state: RunState, reason: ?[]const u8, orphan: ?*Live, survivor: ?*process_mod.Process };
        var stragglers: std.ArrayList(Straggler) = .empty;
        {
            m.lock();
            defer m.unlock();
            var it = m.live.valueIterator();
            while (it.next()) |entry| {
                const run = entry.*;
                const reason = if (run.orphaned) run.pending_reason else run.kill_reason orelse "harness_shutdown";
                try stragglers.append(a, .{
                    .id = try a.dupe(u8, run.id),
                    .agent = try a.dupe(u8, run.agent),
                    .state = if (run.orphaned) run.pending_state else .killed,
                    .reason = if (reason) |text| try a.dupe(u8, text) else null,
                    .orphan = if (run.orphaned) run else null,
                    .survivor = run.survivor,
                });
            }
        }
        for (stragglers.items) |s| {
            if (s.survivor) |proc| {
                if (m.endSurvivor(proc, s.id)) {
                    m.lock();
                    if (s.orphan) |live| live.survivor = null;
                    m.unlock();
                } else {
                    // Still alive: the record stays registered with its pgid for the next shutdown.
                    continue;
                }
            }
            const ended = m.finalizeRetrying(s.id, s.agent, s.state, s.reason);
            if (ended) {
                if (s.orphan) |live| shutdownTake(live);
            }
        }
        m.lock();
        var survivors: usize = 0;
        var left = m.live.valueIterator();
        while (left.next()) |entry| {
            if (entry.*.survivor != null) survivors += 1;
        }
        m.survivors_after_shutdown = survivors;
        m.unlock();
        if (survivors > 0) {
            m.loud("shutdown left {d} agent process group(s) alive; their runs stay registered", .{survivors});
            return error.AgentSurvived;
        }
    }

    /// Kills and reaps a surviving agent group, retrying a failed attempt once more after a pause.
    /// True when the group is gone and the process was freed.
    fn endSurvivor(m: *Manager, proc: *process_mod.Process, id: []const u8) bool {
        var attempt: i64 = 1;
        while (attempt <= 2) : (attempt += 1) {
            if (proc.terminate(1000)) |_| {
                proc.destroy();
                return true;
            } else |err| {
                m.loud("run {s}: agent process group {d} still alive, attempt {d}: {t}", .{ id, proc.pgid, attempt, err });
                if (attempt < 2) m.io.sleep(.fromMilliseconds(50), .awake) catch return false;
            }
        }
        return false;
    }

    fn signalAll(m: *Manager, sig: std.posix.SIG) void {
        m.lock();
        defer m.unlock();
        var it = m.live.valueIterator();
        while (it.next()) |entry| {
            const pid = entry.*.pid.load(.acquire);
            if (pid != 0) {
                _ = m.signal_count.fetchAdd(1, .monotonic);
                process_mod.signalGroup(pid, sig);
            }
        }
    }

    fn waitStarters(m: *Manager, limit_ms: i64) void {
        var waited: i64 = 0;
        while (waited < limit_ms) : (waited += 5) {
            m.lock();
            const pending = m.starters;
            m.unlock();
            if (pending == 0) return;
            m.io.sleep(.fromMilliseconds(5), .awake) catch return;
        }
        m.loud("shutdown gave up waiting for starting runs after {d} ms", .{limit_ms});
    }

    fn waitLiveEmpty(m: *Manager, limit_ms: i64) !void {
        var waited: i64 = 0;
        while (m.activeCount() > 0 and waited < limit_ms) : (waited += 10) {
            try m.io.sleep(.fromMilliseconds(10), .awake);
        }
    }

    /// Blocks until every started run's task has returned.
    pub fn waitIdle(m: *Manager) !void {
        try m.tasks.await(m.io);
    }
};

fn cloneInput(a: Allocator, input: StartInput) Allocator.Error!StartInput {
    var copy = input;
    copy.spec.id = try a.dupe(u8, input.spec.id);
    const argv = try a.alloc([]const u8, input.spec.argv.len);
    for (input.spec.argv, argv) |arg, *dst| dst.* = try a.dupe(u8, arg);
    copy.spec.argv = argv;
    if (input.spec.mode_option) |mode| copy.spec.mode_option = .{
        .config_id = try a.dupe(u8, mode.config_id),
        .value = try a.dupe(u8, mode.value),
    };
    copy.repo = try a.dupe(u8, input.repo);
    copy.prompt = try a.dupe(u8, input.prompt);
    copy.model = if (input.model) |s| try a.dupe(u8, s) else null;
    copy.task_id = if (input.task_id) |s| try a.dupe(u8, s) else null;
    copy.member_id = if (input.member_id) |s| try a.dupe(u8, s) else null;
    copy.project_id = if (input.project_id) |s| try a.dupe(u8, s) else null;
    copy.charged_to = if (input.charged_to) |s| try a.dupe(u8, s) else null;
    copy.batch_id = if (input.batch_id) |s| try a.dupe(u8, s) else null;
    const extra = try a.alloc(launch_mod.Extra, input.extra_env.len);
    for (input.extra_env, extra) |item, *dst| dst.* = .{ .key = try a.dupe(u8, item.key), .value = try a.dupe(u8, item.value) };
    copy.extra_env = extra;
    return copy;
}

/// The owner task's last act on its record. A record whose end state is still unwritten stays
/// for shutdown: whichever of the two comes second frees it.
fn destroyLive(live: *Live) void {
    const m = live.manager;
    m.lock();
    const handed_over = live.orphaned and !live.shutdown_took;
    if (handed_over) live.owner_done = true;
    m.unlock();
    if (!handed_over) freeLive(live);
}

/// Shutdown's side of the same handover, after it ended the orphan's row.
fn shutdownTake(live: *Live) void {
    const m = live.manager;
    m.lock();
    const owner_gone = live.owner_done;
    if (!owner_gone) live.shutdown_took = true;
    m.unlock();
    if (owner_gone) freeLive(live);
}

fn freeLive(live: *Live) void {
    const m = live.manager;
    m.lock();
    _ = m.live.remove(live.id);
    m.unlock();
    live.arena.deinit();
    m.gpa.destroy(live);
}

// The hooks of one run, called from the lane's tasks.

fn liveOf(ctx: *anyopaque) *Live {
    return @ptrCast(@alignCast(ctx));
}

fn hookEmit(ctx: *anyopaque, event: types.NewEvent) anyerror!void {
    const live = liveOf(ctx);
    var full = event;
    full.run_id = live.id;
    full.agent = live.agent;
    full.task_id = live.input.task_id;
    try live.manager.publish(full);
}

fn hookDecide(ctx: *anyopaque, ask: types.Ask) anyerror!types.Verdict {
    const live = liveOf(ctx);
    const m = live.manager;
    const decide = m.links.decide orelse {
        live.denied.store(true, .release);
        return .deny;
    };
    // A guard that cannot decide must not let the action through (decideAsk in decide.ts).
    const verdict = decide(m.links.ctx, live.id, ask) catch |err| {
        live.denied.store(true, .release);
        m.publish(.{ .kind = .@"error", .run_id = live.id, .agent = live.agent, .task_id = live.input.task_id, .body = "guard failed" }) catch |publish_err| {
            std.log.warn("run {s}: guard failure event lost: {t}", .{ live.id, publish_err });
        };
        std.log.warn("run {s}: guard failed: {t}", .{ live.id, err });
        return .deny;
    };
    if (verdict == .deny) live.denied.store(true, .release);
    return verdict;
}

const QuotaCtx = struct { m: *Manager, quota: types.Quota };

fn quotaLocked(ctx: QuotaCtx, state: *app_mod.State) !void {
    const record = ctx.m.links.record_quota orelse return;
    try record(ctx.m.links.ctx, try Manager.dbOf(state), ctx.quota);
}

fn hookQuota(ctx: *anyopaque, quota: types.Quota) anyerror!void {
    const live = liveOf(ctx);
    if (quota.used_percent >= 100) live.quota_full.store(true, .release);
    try live.manager.app.withLock(QuotaCtx{ .m = live.manager, .quota = quota }, quotaLocked);
}

fn hookProgress(ctx: *anyopaque, tokens: i64) anyerror!void {
    const live = liveOf(ctx);
    const m = live.manager;
    if (m.links.on_progress) |listener| listener(m.links.ctx, live.id, tokens);
}

const PidCtx = struct { id: []const u8, pid: i64 };

fn pidLocked(ctx: PidCtx, state: *app_mod.State) !void {
    try setPid(try Manager.dbOf(state), ctx.id, ctx.pid, null);
}

fn hookSpawn(ctx: *anyopaque, pid: std.posix.pid_t) anyerror!void {
    const live = liveOf(ctx);
    live.pid.store(pid, .release);
    try live.manager.app.withLock(PidCtx{ .id = live.id, .pid = pid }, pidLocked);
}

fn hookLog(ctx: *anyopaque, message: []const u8) void {
    std.log.warn("run {s}: {s}", .{ liveOf(ctx).id, message });
}

const UsageCtx = struct { live: *Live, outcome: *const types.Outcome };

fn usageLocked(ctx: UsageCtx, state: *app_mod.State) !void {
    const m = ctx.live.manager;
    const record = m.links.record_usage orelse return;
    try record(m.links.ctx, try Manager.dbOf(state), ctx.live.id, ctx.live.agent, ctx.outcome.session_id, ctx.outcome.usage);
}

const EndCtx = struct { m: *Manager, id: []const u8 };

fn expiredLocked(ctx: EndCtx, state: *app_mod.State) !bool {
    if (takeInjected(&ctx.m.inject_expired_failures)) return error.Busy;
    return hasExpiredApproval(try Manager.dbOf(state), ctx.id);
}

/// True while a test hook still owes a failure; each call uses one up.
fn takeInjected(counter: *std.atomic.Value(u32)) bool {
    if (counter.load(.acquire) == 0) return false;
    _ = counter.fetchSub(1, .acq_rel);
    return true;
}

fn killReasonOf(live: *Live) ?[]const u8 {
    const m = live.manager;
    m.lock();
    defer m.unlock();
    return live.kill_reason;
}

/// The task of one run: the lane, then usage, then the end state (execute in manager.ts).
fn runTask(live: *Live) void {
    const m = live.manager;
    defer destroyLive(live);
    // Shutdown or a kill that arrived before the agent started: do not start it at all.
    if (live.abort.isSet()) {
        const kill = killReasonOf(live) orelse "killed";
        return finishRun(m, live, .{ .state = .killed, .reason = kill });
    }
    var extras: std.ArrayList(launch_mod.Extra) = .empty;
    defer extras.deinit(m.gpa);
    extras.appendSlice(m.gpa, &launch_mod.run_env) catch |err| return m.failLaunch(live, err);
    extras.append(m.gpa, .{ .key = "HARNESS_RUN_ID", .value = live.id }) catch |err| return m.failLaunch(live, err);
    extras.appendSlice(m.gpa, live.input.extra_env) catch |err| return m.failLaunch(live, err);
    var launch = launch_mod.build(m.gpa, live.input.spec, live.input.repo, m.parent_env, extras.items) catch |err| {
        return m.failLaunch(live, err);
    };
    defer launch.deinit();

    // The smoke runs name a tee file through the agent's env, as with acp-tee.ts.
    var tee_path: ?[]const u8 = null;
    for (live.input.extra_env) |item| {
        if (std.mem.eql(u8, item.key, "ACP_TEE_LOG")) tee_path = item.value;
    }
    const hooks: types.Hooks = .{
        .ctx = live,
        .emit = hookEmit,
        .decide = hookDecide,
        .on_quota = hookQuota,
        .on_progress = hookProgress,
        .on_spawn = hookSpawn,
        .log_error = hookLog,
    };
    const cfg: types.RunConfig = .{
        .run_id = live.id,
        .task_id = live.input.task_id,
        .cwd = launch.cwd,
        .prompt = live.input.prompt,
        .model = live.input.model,
        .spec = live.input.spec,
        .argv = launch.argv,
        .env = &launch.env,
        .idle_timeout_ms = m.idle_timeout_ms,
        .tee_path = tee_path,
        .inject_terminate_failures = live.input.inject_terminate_failures,
        .decide_timeout_ms = if (m.approval_timeout_ms) |ms| ms + approval_slack_ms else 15 * 60_000,
    };
    const lane_result = acp.execute(m.gpa, m.io, cfg, &hooks, &live.abort);
    const survived = if (lane_result) |executed| executed.survivor != null else |_| false;
    // The lane reaped the agent: from here a signal to its pgid could hit an unrelated group.
    // A group that could not be ended keeps its pgid published so shutdown can retry the kill.
    if (!survived) m.clearPid(live);
    if (lane_result) |executed| {
        var outcome = executed;
        defer outcome.deinit();
        if (outcome.survivor) |proc| m.keepSurvivor(live, proc, outcome.error_text);
        // TS records usage inside the try of execute(): a throw there fails the run with the
        // message (manager.ts, `recordUsage(...)` then the catch that sets state failed).
        var usage_reason: [96]u8 = undefined;
        var usage_failure: ?[]const u8 = null;
        m.app.withLock(UsageCtx{ .live = live, .outcome = &outcome }, usageLocked) catch |err| {
            m.loud("run {s}: usage not recorded: {t}", .{ live.id, err });
            usage_failure = std.fmt.bufPrint(&usage_reason, "{t}", .{err}) catch "usage_failed";
        };
        if (usage_failure) |text| {
            const end: End = if (killReasonOf(live)) |kill|
                .{ .state = .killed, .reason = kill }
            else
                .{ .state = .failed, .reason = text };
            return finishRun(m, live, end);
        }
        const expired = m.readExpiredApproval(live.id) orelse {
            // Without the answer a timed-out approval could be missed, so the run cannot complete.
            const end: End = if (killReasonOf(live)) |kill|
                .{ .state = .killed, .reason = kill }
            else
                .{ .state = .failed, .reason = "internal_error" };
            return finishRun(m, live, end);
        };
        const end = endState(killReasonOf(live), expired, live.denied.load(.acquire), live.quota_full.load(.acquire), &outcome);
        finishRun(m, live, end);
    } else |err| {
        // The lane threw before it had an outcome; a kill that raced it still counts as a kill.
        var reason_buffer: [128]u8 = undefined;
        const reason = std.fmt.bufPrint(&reason_buffer, "{t}", .{err}) catch "internal_error";
        const end: End = if (killReasonOf(live)) |kill|
            .{ .state = .killed, .reason = kill }
        else
            .{ .state = .failed, .reason = reason };
        finishRun(m, live, end);
    }
}

fn finishRun(m: *Manager, live: *Live, end: End) void {
    _ = m.endOrOrphan(live, end.state, end.reason);
}
