//! The ACP v1 client lane: one agent child, JSON-RPC over its stdio, one prompt. Port of
//! code/src/server/features/runtimes/acp.ts and acp-rpc.ts.
//!
//! TS drives the conversation with promises and races them against an idle clock, an abort
//! signal and an adapter fault. Here one loop selects over the same sources: the next stdout
//! line (queued by the process's reader task), a 25 ms tick that checks the idle and flush
//! deadlines, the abort event, and one task per permission request that waits for the decision.
const std = @import("std");
const types = @import("types.zig");
const process_mod = @import("process.zig");
const updates = @import("acp_updates.zig");
const json_opts = @import("../json.zig");

const Io = std.Io;
const Value = std.json.Value;
const Allocator = std.mem.Allocator;

pub const cancel_grace_ms = 2000;
pub const kill_grace_ms = 5000;
const tick_ms = 25;
const stderr_settle_ms = 500;
const max_pending_permissions = 16;

const stop_reasons = [_]struct { name: []const u8, reason: types.StopReason }{
    .{ .name = "end_turn", .reason = .end_turn },
    .{ .name = "cancelled", .reason = .cancelled },
    .{ .name = "max_tokens", .reason = .max_tokens },
    .{ .name = "refusal", .reason = .refusal },
};

const DecideResult = union(enum) { verdict: types.Verdict, timeout, failed: anyerror };

/// A permission request waiting for its decision. Owns the parsed message, because the options
/// and the request id are read again when the decision arrives.
const Pending = struct {
    message: std.json.Parsed(Value),
    arena: std.heap.ArenaAllocator,
    ask: types.Ask,
};

const Decided = struct { pending: *Pending, result: DecideResult };

const Event = union(enum) {
    line: (error{Closed} || Io.Cancelable)!process_mod.Line,
    tick: Io.Cancelable!void,
    abort: Io.Cancelable!void,
    decided: Decided,
};

fn lineTask(process: *process_mod.Process) (error{Closed} || Io.Cancelable)!process_mod.Line {
    return process.lines.getOne(process.io);
}

fn tickTask(io: Io) Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(tick_ms), .awake);
}

fn abortTask(io: Io, event: *Io.Event) Io.Cancelable!void {
    return event.wait(io);
}

fn callDecide(hooks: *const types.Hooks, ask: types.Ask) anyerror!types.Verdict {
    return hooks.decide(hooks.ctx, ask);
}

fn sleepTask(io: Io, ms: i64) Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

/// Anything but a clear allow is a deny; a decide that never answers is cut off here so the run
/// cannot sit on a pending permission forever (verdictFor in acp.ts).
fn decideTask(io: Io, hooks: *const types.Hooks, pending: *Pending, timeout_ms: i64) Decided {
    return .{ .pending = pending, .result = decideWithin(io, hooks, pending.ask, timeout_ms) };
}

fn decideWithin(io: Io, hooks: *const types.Hooks, ask: types.Ask, timeout_ms: i64) DecideResult {
    const Inner = union(enum) { decided: anyerror!types.Verdict, timer: Io.Cancelable!void };
    var buffer: [2]Inner = undefined;
    var select: Io.Select(Inner) = .init(io, &buffer);
    defer select.cancelDiscard();
    select.concurrent(.decided, callDecide, .{ hooks, ask }) catch |err| return .{ .failed = err };
    select.concurrent(.timer, sleepTask, .{ io, timeout_ms }) catch |err| return .{ .failed = err };
    const first = select.await() catch |err| return .{ .failed = err };
    return switch (first) {
        .decided => |result| if (result) |verdict| .{ .verdict = verdict } else |err| .{ .failed = err },
        .timer => .timeout,
    };
}

const Step = enum { initialize, session_new, set_config, prompt, finished };

const ConfigOption = struct { config_id: []const u8, value: []const u8 };

const Run = struct {
    gpa: Allocator,
    io: Io,
    cfg: types.RunConfig,
    hooks: *const types.Hooks,
    process: *process_mod.Process,
    sink: updates.Sink,
    /// Everything the final outcome points at.
    arena: std.heap.ArenaAllocator,
    step: Step = .initialize,
    next_id: i64 = 1,
    pending_id: i64 = 0,
    session_id: ?[]const u8 = null,
    options: [2]ConfigOption = undefined,
    option_count: usize = 0,
    option_index: usize = 0,
    deciding: usize = 0,
    last_touch_ms: i64,
    fault: ?[]const u8 = null,
    /// The message of a JSON-RPC error response to a request of ours.
    agent_error: ?[]const u8 = null,
    write_failure_logged: bool = false,

    fn nowMs(run: *Run) i64 {
        return Io.Clock.awake.now(run.io).toMilliseconds();
    }

    fn logError(run: *Run, comptime fmt: []const u8, args: anytype) void {
        var buffer: [256]u8 = undefined;
        const message = std.fmt.bufPrint(&buffer, fmt, args) catch buffer[0..];
        run.hooks.log_error(run.hooks.ctx, message);
    }

    fn raise(run: *Run, err: anyerror) void {
        if (run.fault != null) return;
        run.logError("acp run fault: {t}", .{err});
        run.fault = run.arena.allocator().dupe(u8, @errorName(err)) catch "OutOfMemory";
    }

    fn emitOrLog(run: *Run, event: types.NewEvent) void {
        run.sink.emit(event) catch |err| run.raise(err);
    }

    fn send(run: *Run, value: anytype) !void {
        const bytes = try std.json.Stringify.valueAlloc(run.gpa, value, .{});
        defer run.gpa.free(bytes);
        run.process.writeLine(bytes) catch |err| {
            // The child is gone; the stdout reader reports it and ends the conversation.
            if (!run.write_failure_logged) run.logError("write to agent failed: {t}", .{err});
            run.write_failure_logged = true;
        };
    }

    fn request(run: *Run, method: []const u8, params: anytype) !void {
        const id = run.next_id;
        run.next_id += 1;
        run.pending_id = id;
        try run.send(.{ .jsonrpc = "2.0", .id = id, .method = method, .params = params });
    }

    fn notify(run: *Run, method: []const u8, params: anytype) !void {
        try run.send(.{ .jsonrpc = "2.0", .method = method, .params = params });
    }

    fn startConversation(run: *Run) !void {
        try run.request("initialize", .{
            .protocolVersion = 1,
            .clientCapabilities = .{ .fs = .{ .readTextFile = false, .writeTextFile = false }, .terminal = false },
            .clientInfo = .{ .name = "harness", .version = "0" },
        });
    }

    /// Advances the conversation with the result of the request in flight.
    fn advance(run: *Run, result: Value) !void {
        switch (run.step) {
            .initialize => {
                if (run.cfg.spec.mode_option == null) {
                    run.emitOrLog(.{
                        .kind = .guard,
                        .guard_layer = .L0,
                        .guard_verdict = .ask,
                        .guard_rule = "no_permission_mode",
                        .body = "agent has no permission mode to set; only L0 and native rules protect this run",
                    });
                }
                run.step = .session_new;
                var scratch: std.heap.ArenaAllocator = .init(run.gpa);
                defer scratch.deinit();
                try run.request("session/new", try newSessionParams(scratch.allocator(), run.cfg));
            },
            .session_new => {
                const id = updates.str(updates.get(result, "sessionId")) orelse return error.NoSessionId;
                run.session_id = try run.arena.allocator().dupe(u8, id);
                if (run.cfg.spec.mode_option) |mode| {
                    run.options[run.option_count] = .{ .config_id = mode.config_id, .value = mode.value };
                    run.option_count += 1;
                }
                if (run.cfg.model) |model| {
                    run.options[run.option_count] = .{ .config_id = "model", .value = model };
                    run.option_count += 1;
                }
                run.step = .set_config;
                try run.nextConfigOrPrompt();
            },
            .set_config => try run.nextConfigOrPrompt(),
            .prompt => run.step = .finished,
            .finished => {},
        }
    }

    fn nextConfigOrPrompt(run: *Run) !void {
        if (run.option_index < run.option_count) {
            const option = run.options[run.option_index];
            run.option_index += 1;
            try run.request("session/set_config_option", .{
                .sessionId = run.session_id.?,
                .configId = option.config_id,
                .value = option.value,
            });
            return;
        }
        run.step = .prompt;
        try run.request("session/prompt", .{
            .sessionId = run.session_id.?,
            .prompt = [_]struct { type: []const u8, text: []const u8 }{.{ .type = "text", .text = run.cfg.prompt }},
        });
    }

    fn touch(run: *Run) void {
        run.last_touch_ms = run.nowMs();
    }

    fn idleExpired(run: *Run) bool {
        return run.deciding == 0 and run.nowMs() - run.last_touch_ms >= run.cfg.idle_timeout_ms;
    }
};

fn newSessionParams(a: Allocator, cfg: types.RunConfig) Allocator.Error!Value {
    var params = std.json.ObjectMap.empty;
    try params.put(a, "cwd", .{ .string = cfg.cwd });
    var servers = std.json.Array.init(a);
    if (cfg.mcp) |mcp| {
        var server = std.json.ObjectMap.empty;
        try server.put(a, "type", .{ .string = "http" });
        try server.put(a, "name", .{ .string = "harness" });
        try server.put(a, "url", .{ .string = mcp.url });
        var header = std.json.ObjectMap.empty;
        try header.put(a, "name", .{ .string = "Authorization" });
        try header.put(a, "value", .{ .string = try std.fmt.allocPrint(a, "Bearer {s}", .{mcp.token}) });
        var headers = std.json.Array.init(a);
        try headers.append(.{ .object = header });
        try server.put(a, "headers", .{ .array = headers });
        try servers.append(.{ .object = server });
    }
    try params.put(a, "mcpServers", .{ .array = servers });
    if (cfg.spec.claude_meta) {
        var env = std.json.ObjectMap.empty;
        var it = cfg.env.iterator();
        while (it.next()) |entry| try env.put(a, entry.key_ptr.*, .{ .string = entry.value_ptr.* });
        var options = std.json.ObjectMap.empty;
        try options.put(a, "settingSources", .{ .array = std.json.Array.init(a) });
        const settings = std.json.parseFromSliceLeaky(Value, a, cfg.claude_settings_json, .{}) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => Value{ .object = std.json.ObjectMap.empty },
        };
        try options.put(a, "settings", settings);
        try options.put(a, "env", .{ .object = env });
        var claude_code = std.json.ObjectMap.empty;
        try claude_code.put(a, "options", .{ .object = options });
        var meta = std.json.ObjectMap.empty;
        try meta.put(a, "claudeCode", .{ .object = claude_code });
        try params.put(a, "_meta", .{ .object = meta });
    }
    return .{ .object = params };
}

/// Runs one prompt against a freshly spawned agent and returns how it ended. Whatever the way
/// out, the agent's process group is gone and reaped when this returns.
pub fn execute(gpa: Allocator, io: Io, cfg: types.RunConfig, hooks: *const types.Hooks, abort: *Io.Event) !types.Outcome {
    const process = try process_mod.Process.spawn(gpa, io, .{
        .argv = cfg.argv,
        .cwd = cfg.cwd,
        .env = cfg.env,
        .tee_path = cfg.tee_path,
        .max_line = cfg.max_line,
        .inject_terminate_failures = cfg.inject_terminate_failures,
    });
    var keep_process = false;
    defer if (!keep_process) process.destroy();

    var state: Run = .{
        .gpa = gpa,
        .io = io,
        .cfg = cfg,
        .hooks = hooks,
        .process = process,
        .sink = .init(gpa, io, cfg.run_id, cfg.spec.id, hooks),
        .arena = .init(gpa),
        .last_touch_ms = Io.Clock.awake.now(io).toMilliseconds(),
    };
    defer state.sink.deinit();
    errdefer state.arena.deinit();

    var ended = conversation(&state, abort);
    defer if (ended.response_owner) |owned| owned.deinit();
    // The final error event is emitted before the process is torn down, as in the TS finally.
    if (ended.error_text) |text| state.emitOrLog(.{ .kind = .@"error", .body = text });
    var terminated = true;
    if (process.terminate(kill_grace_ms)) |_| {} else |err| {
        // The group may still be alive: the run fails, and the caller keeps the process to retry.
        state.logError("terminate failed: {t}", .{err});
        terminated = false;
        keep_process = true;
        const text = std.fmt.allocPrint(state.arena.allocator(), "internal error: agent process group {d} survived termination", .{process.pgid}) catch "internal error: agent process group survived termination";
        ended.stop_reason = .@"error";
        ended.error_text = text;
        state.emitOrLog(.{ .kind = .@"error", .body = text });
    }
    var outcome = try finishOutcome(&state, &ended);
    if (!terminated) outcome.survivor = process;
    return outcome;
}

const Ended = struct {
    stop_reason: types.StopReason,
    error_text: ?[]const u8 = null,
    usage_response: ?Value = null,
    /// Keeps the parsed prompt response alive until the outcome is built.
    response_owner: ?std.json.Parsed(Value) = null,
};

/// Builds the outcome from the arena: the sink text, usage records and the session id.
fn finishOutcome(state: *Run, ended: *Ended) !types.Outcome {
    const a = state.arena.allocator();
    var usage: []types.UsageRecord = &.{};
    if (ended.usage_response) |response| usage = try updates.usageRecords(a, response, state.cfg.model, state.sink.cost_usd);
    // Every allocation is done before the arena state is copied out, or it would be lost.
    const text = try a.dupe(u8, state.sink.text.items);
    return .{
        .arena = state.arena,
        .stop_reason = ended.stop_reason,
        .text = text,
        .usage = usage,
        .error_text = ended.error_text,
        .session_id = state.session_id,
    };
}

fn conversation(state: *Run, abort: *Io.Event) Ended {
    return converse(state, abort) catch |err| {
        const text = state.arena.allocator().dupe(u8, @errorName(err)) catch "OutOfMemory";
        return .{ .stop_reason = .@"error", .error_text = text };
    };
}

fn converse(state: *Run, abort: *Io.Event) !Ended {
    const io = state.io;
    var buffer: [4 + max_pending_permissions]Event = undefined;
    var select: Io.Select(Event) = .init(io, &buffer);
    defer drain(state, &select);

    state.hooks.on_spawn(state.hooks.ctx, state.process.pgid) catch |err| {
        return failed(state, @errorName(err));
    };
    try select.concurrent(.line, lineTask, .{state.process});
    try select.concurrent(.tick, tickTask, .{io});
    try select.concurrent(.abort, abortTask, .{ io, abort });
    state.startConversation() catch |err| return failed(state, @errorName(err));

    var cancel_deadline_ms: ?i64 = null;
    var response_owner: ?std.json.Parsed(Value) = null;
    defer if (response_owner) |owned| owned.deinit();

    while (true) {
        if (state.fault) |message| {
            return failed(state, try std.fmt.allocPrint(state.arena.allocator(), "adapter fault: {s}", .{message}));
        }
        if (state.step == .finished) {
            if (cancel_deadline_ms != null) return stopped(state, .cancelled, null);
            state.sink.flush() catch |err| state.raise(err);
            if (state.fault != null) continue;
            return finished(state, &response_owner);
        }
        switch (try select.await()) {
            .tick => {
                try select.concurrent(.tick, tickTask, .{io});
                state.sink.flushIfDue() catch |err| state.raise(err);
                if (cancel_deadline_ms) |deadline| {
                    if (state.nowMs() >= deadline) return stopped(state, .cancelled, null);
                } else if (state.idleExpired()) {
                    const text = try std.fmt.allocPrint(state.arena.allocator(), "no update for {d} ms", .{state.cfg.idle_timeout_ms});
                    return stopped(state, .timeout, text);
                }
            },
            .abort => {
                if (cancel_deadline_ms == null) {
                    const session: ?[]const u8 = state.session_id;
                    state.notify("session/cancel", .{ .sessionId = session }) catch |err| state.raise(err);
                    cancel_deadline_ms = state.nowMs() + cancel_grace_ms;
                }
            },
            .decided => |decided| {
                defer destroyPending(state, decided.pending);
                state.deciding -= 1;
                state.touch();
                answerPermission(state, decided) catch |err| state.raise(err);
            },
            .line => |maybe_line| {
                const line = maybe_line catch |err| switch (err) {
                    error.Closed, error.Canceled => return exited(state),
                };
                switch (line) {
                    .eof => return exited(state),
                    .failed => |err| return if (err == error.LineTooLong) lineTooLong(state) else exited(state),
                    .text => |text| {
                        defer state.gpa.free(text);
                        handleLine(state, &select, text, &response_owner) catch |err| switch (err) {
                            error.AgentError => return failed(state, state.agent_error.?),
                            error.NoSessionId => return failed(state, "session/new returned no sessionId"),
                            else => |other| return other,
                        };
                        try select.concurrent(.line, lineTask, .{state.process});
                    },
                }
            },
        }
    }
}

fn failed(state: *Run, text: []const u8) Ended {
    state.sink.flush() catch |err| state.raise(err);
    const copy = state.arena.allocator().dupe(u8, text) catch "OutOfMemory";
    return .{ .stop_reason = .@"error", .error_text = copy };
}

fn stopped(state: *Run, reason: types.StopReason, text: ?[]const u8) Ended {
    state.sink.flush() catch |err| state.raise(err);
    return .{ .stop_reason = reason, .error_text = text };
}

/// An oversized agent line fails the run with a clear reason (plan 5.1), not the server.
fn lineTooLong(state: *Run) Ended {
    const text = std.fmt.allocPrint(state.arena.allocator(), "agent output line too long (over {d} bytes)", .{state.cfg.max_line}) catch "agent output line too long";
    return failed(state, text);
}

fn exited(state: *Run) Ended {
    const tail = waitForStderrTail(state);
    return failed(state, tail);
}

/// The agent's stderr tail trimmed, after giving the stderr reader a moment to catch up with the
/// end of stdout.
fn waitForStderrTail(state: *Run) []const u8 {
    const a = state.arena.allocator();
    var waited: i64 = 0;
    while (!state.process.stderr_done.isSet() and waited < stderr_settle_ms) : (waited += 5) {
        state.io.sleep(.fromMilliseconds(5), .awake) catch break;
    }
    const tail = state.process.stderrTail(state.gpa) catch return "agent exited before a response";
    defer state.gpa.free(tail);
    return std.fmt.allocPrint(a, "agent exited before a response: {s}", .{std.mem.trim(u8, tail, " \t\r\n")}) catch "agent exited before a response";
}

fn finished(state: *Run, response_owner: *?std.json.Parsed(Value)) !Ended {
    const owned = response_owner.* orelse return error.NoResponse;
    response_owner.* = null;
    const response = updates.get(owned.value, "result");
    const stop = updates.str(updates.get(response, "stopReason"));
    for (stop_reasons) |known| {
        if (stop != null and std.mem.eql(u8, stop.?, known.name)) {
            return .{ .stop_reason = known.reason, .usage_response = response, .response_owner = owned };
        }
    }
    const a = state.arena.allocator();
    const text = try std.fmt.allocPrint(a, "unexpected stop reason {s}", .{stop orelse "undefined"});
    return .{ .stop_reason = .@"error", .error_text = text, .usage_response = response, .response_owner = owned };
}

/// Strings are copied out of the line: a permission request and the prompt response outlive it.
const line_parse_options: std.json.ParseOptions = .{
    .duplicate_field_behavior = json_opts.parse_options.duplicate_field_behavior,
    .ignore_unknown_fields = true,
    .allocate = .alloc_always,
};

fn handleLine(
    state: *Run,
    select: *Io.Select(Event),
    text: []const u8,
    response_owner: *?std.json.Parsed(Value),
) !void {
    const parsed = std.json.parseFromSlice(Value, state.gpa, text, line_parse_options) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        // A line that is not JSON is dropped, as parseLine does in acp-rpc.ts.
        else => return,
    };
    var keep = false;
    defer if (!keep) parsed.deinit();
    const message = parsed.value;
    if (message != .object) return;
    const method_value = updates.get(message, "method");
    if (method_value == .null and !message.object.contains("method")) {
        // A response: only the request in flight has a waiter.
        const id = message.object.get("id") orelse return;
        if (id != .integer or id.integer != state.pending_id) return;
        if (message.object.contains("error")) {
            const text_message = updates.str(updates.get(updates.get(message, "error"), "message")) orelse "agent error";
            state.agent_error = try state.arena.allocator().dupe(u8, text_message);
            return error.AgentError;
        }
        if (state.step == .prompt) {
            response_owner.* = parsed;
            keep = true;
        }
        try state.advance(updates.get(message, "result"));
        return;
    }
    state.touch();
    const method = updates.str(method_value) orelse "";
    if (std.mem.eql(u8, method, "session/update")) {
        state.sink.handle(updates.get(updates.get(message, "params"), "update")) catch |err| state.raise(err);
    } else if (std.mem.eql(u8, method, "session/request_permission")) {
        if (message.object.contains("id")) {
            keep = try startPermission(state, select, parsed);
        }
    } else if (message.object.get("id")) |id| {
        try refuse(state, id, method);
    }
}

fn refuse(state: *Run, id: Value, method: []const u8) !void {
    var buffer: [256]u8 = undefined;
    const message = std.fmt.bufPrint(&buffer, "{s} not supported", .{method}) catch "method not supported";
    try state.send(.{ .jsonrpc = "2.0", .id = id, .@"error" = .{ .code = -32601, .message = message } });
}

/// Takes ownership of `parsed` when it returns true.
fn startPermission(state: *Run, select: *Io.Select(Event), parsed: std.json.Parsed(Value)) !bool {
    if (state.deciding >= max_pending_permissions) {
        // More than the loop can track: refuse the request instead of growing without bound.
        try refuse(state, updates.get(parsed.value, "id"), "session/request_permission");
        return false;
    }
    const pending = try state.gpa.create(Pending);
    errdefer state.gpa.destroy(pending);
    pending.* = .{ .message = parsed, .arena = .init(state.gpa), .ask = undefined };
    errdefer pending.arena.deinit();
    const params = updates.get(parsed.value, "params");
    pending.ask = try state.sink.describe(pending.arena.allocator(), updates.get(params, "toolCall"));
    state.sink.flush() catch |err| state.raise(err);
    try select.concurrent(.decided, decideTask, .{ state.io, state.hooks, pending, state.cfg.decide_timeout_ms });
    state.deciding += 1;
    return true;
}

fn destroyPending(state: *Run, pending: *Pending) void {
    pending.message.deinit();
    pending.arena.deinit();
    state.gpa.destroy(pending);
}

fn answerPermission(state: *Run, decided: Decided) !void {
    const pending = decided.pending;
    const params = updates.get(pending.message.value, "params");
    const options = updates.get(params, "options");
    var verdict: types.Verdict = .deny;
    switch (decided.result) {
        .verdict => |v| verdict = v,
        .timeout => state.emitOrLog(.{
            .kind = .guard,
            .guard_verdict = .deny,
            .guard_layer = .L3,
            .guard_rule = "decide_timeout",
            .body = "decide timeout",
        }),
        .failed => |err| {
            var buffer: [128]u8 = undefined;
            const body = std.fmt.bufPrint(&buffer, "decide failed, denying: {t}", .{err}) catch "decide failed, denying";
            state.emitOrLog(.{ .kind = .@"error", .body = body });
        },
    }
    var pick = updates.pickOption(options, verdict);
    if (pick.option_id == null and pick.allow_always_only) {
        state.emitOrLog(.{ .kind = .@"error", .body = "allow_always only: no allow_once option offered, answering reject" });
        pick = updates.pickOption(options, .deny);
    }
    const id = updates.get(pending.message.value, "id");
    if (pick.option_id) |option_id| {
        try state.send(.{ .jsonrpc = "2.0", .id = id, .result = .{ .outcome = .{ .outcome = "selected", .optionId = option_id } } });
    } else {
        try state.send(.{ .jsonrpc = "2.0", .id = id, .result = .{ .outcome = .{ .outcome = "cancelled" } } });
    }
    var buffer: [256]u8 = undefined;
    const body = std.fmt.bufPrint(&buffer, "{t} {s}", .{ verdict, pick.option_id orelse "cancelled" }) catch @tagName(verdict);
    state.emitOrLog(.{
        .kind = .permission,
        .command = pending.ask.command,
        .tool_name = pending.ask.tool_name,
        .body = body,
    });
}

/// Cancels every outstanding task and frees what finished ones still hold.
fn drain(state: *Run, select: *Io.Select(Event)) void {
    // The reader may be blocked on a full queue; closing it lets the cancelled tasks finish.
    state.process.lines.close(state.io);
    while (select.cancel()) |event| switch (event) {
        .decided => |decided| destroyPending(state, decided.pending),
        .line => |maybe| if (maybe) |line| switch (line) {
            .text => |text| state.gpa.free(text),
            .eof, .failed => {},
        } else |_| {},
        .tick, .abort => {},
    };
}
