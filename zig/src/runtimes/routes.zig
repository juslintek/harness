const std = @import("std");
const httpz = @import("httpz");
const specs = @import("../agents/specs.zig");
const middleware = @import("../auth/middleware.zig");
const headers = @import("../http/headers.zig");
const routes = @import("../http/routes.zig");
const app_mod = @import("../app.zig");
const sqlite = @import("../db/sqlite.zig");
const logs = @import("../logs/api.zig");
const log_text = @import("../logs/text.zig");
const manager = @import("manager.zig");
const parity = @import("../parity.zig");
const summary = @import("../usage/summary.zig");
const types = @import("types.zig");
const ids = @import("../ids.zig");

const Call = routes.Call;

const RunView = struct {
    id: []const u8,
    memberId: ?[]const u8,
    agentId: []const u8,
    model: ?[]const u8,
    repo: []const u8,
    branch: ?[]const u8,
    prompt: []const u8,
    state: []const u8,
    reason: ?[]const u8,
    createdAt: i64,
    startedAt: ?i64,
    endedAt: ?i64,
    inputTokens: i64,
    outputTokens: i64,
};

fn view(row: manager.RunRow, totals: []const summary.SummaryRow) RunView {
    var result: RunView = .{
        .id = row.id,
        .memberId = row.member_id,
        .agentId = row.agent_id,
        .model = row.model,
        .repo = row.repo,
        .branch = row.branch,
        .prompt = row.prompt,
        .state = @tagName(row.state),
        .reason = row.reason,
        .createdAt = row.created_at,
        .startedAt = row.started_at,
        .endedAt = row.ended_at,
        .inputTokens = 0,
        .outputTokens = 0,
    };
    for (totals) |total| if (std.mem.eql(u8, total.key, row.id)) {
        result.inputTokens = total.input_tokens;
        result.outputTokens = total.output_tokens;
        break;
    };
    return result;
}

const ListCtx = struct { arena: std.mem.Allocator };
const ListData = struct { rows: []manager.RunRow, totals: []summary.SummaryRow };

fn listLocked(ctx: ListCtx, state: *app_mod.State) !ListData {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    return .{
        .rows = try manager.listRuns(db, ctx.arena, 50),
        .totals = try summary.usageSummary(ctx.arena, db, .run, 0),
    };
}

pub fn list(call: *Call) anyerror!void {
    const data = try call.services.app.withLock(ListCtx{ .arena = call.res.arena }, listLocked);
    const rows = try call.res.arena.alloc(RunView, data.rows.len);
    for (data.rows, rows) |row, *dst| dst.* = view(row, data.totals);
    try headers.sendJson(call.res, rows);
}

const StartBody = struct {
    agentId: []const u8,
    repo: []const u8,
    prompt: []const u8,
    model: ?[]const u8 = null,
};

fn parseStartBody(arena: std.mem.Allocator, bytes: []const u8) error{InvalidBody}!StartBody {
    const value = std.json.parseFromSliceLeaky(std.json.Value, arena, bytes, .{
        .duplicate_field_behavior = .use_last,
        .ignore_unknown_fields = true,
    }) catch return error.InvalidBody;
    if (value != .object) return error.InvalidBody;
    if (value.object.get("model")) |model| if (model != .string) return error.InvalidBody;
    const body = std.json.parseFromSliceLeaky(StartBody, arena, bytes, .{
        .duplicate_field_behavior = .use_last,
        .ignore_unknown_fields = true,
    }) catch return error.InvalidBody;
    if (!validLength(body.agentId, 1, 64) or !validLength(body.repo, 1, 4096) or
        !std.mem.startsWith(u8, body.repo, "/") or !validLength(body.prompt, 1, 20000) or
        (body.model != null and !validLength(body.model.?, 1, 200)))
        return error.InvalidBody;
    return body;
}

fn validLength(value: []const u8, min: usize, max: usize) bool {
    const length = parity.utf16Len(value) catch return false;
    return length >= min and length <= max;
}

pub fn start(call: *Call) anyerror!void {
    const m = call.services.manager orelse return callNotImplemented(call);
    const actor = call.actor orelse return headers.sendError(call.res, 401, "unauthorized");
    if (!try middleware.requireStepUp(call.res, actor, ids.nowMs(call.services.app.io))) return;
    const body_bytes = call.req.body() orelse return headers.sendError(call.res, 400, "invalid body");
    const body = parseStartBody(call.res.arena, body_bytes) catch return headers.sendError(call.res, 400, "invalid body");

    const agent_ctx = call.services.agents orelse return callNotImplemented(call);
    const test_mode = agent_ctx.env.get("HARNESS_TEST") != null and std.mem.eql(u8, agent_ctx.env.get("HARNESS_TEST").?, "1");
    const override = agent_ctx.env.get("HARNESS_TEST_AGENTS");
    if (!test_mode or override == null or override.?.len == 0)
        return headers.sendError(call.res, 503, "sandbox unavailable");
    if (m.shutting_down.load(.acquire)) return headers.sendError(call.res, 409, "harness is shutting down");
    if (try m.isHalted()) return headers.sendError(call.res, 409, "harness is halted");
    const spec = specs.find(agent_ctx.specs, body.agentId) orelse return headers.sendError(call.res, 404, "unknown agent");
    const argv = try call.res.arena.alloc([]const u8, spec.args.len + 1);
    argv[0] = spec.bin;
    @memcpy(argv[1..], spec.args);
    const mode_option = if (spec.mode_option) |option|
        types.Spec.ModeOption{ .config_id = option.config_id, .value = option.value }
    else
        null;
    const id = m.startRun(.{
        .spec = .{ .id = spec.id, .argv = argv, .mode_option = mode_option, .claude_meta = spec.claude_meta },
        .repo = body.repo,
        .prompt = body.prompt,
        .model = body.model,
    }) catch |err| switch (err) {
        error.ShuttingDown => return headers.sendError(call.res, 409, "harness is shutting down"),
        else => return err,
    };
    call.res.status = 201;
    try headers.sendJson(call.res, .{ .id = id[0..] });
}

const GetCtx = struct { arena: std.mem.Allocator, id: []const u8 };

fn viewJsonLocked(ctx: GetCtx, state: *app_mod.State) !?[]const u8 {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const row = try manager.getRun(db, ctx.arena, ctx.id) orelse return null;
    const totals = try summary.usageSummary(ctx.arena, db, .run, 0);
    return try std.json.Stringify.valueAlloc(ctx.arena, view(row, totals), .{});
}

pub fn viewJson(arena: std.mem.Allocator, app: *app_mod.App, id: []const u8) !?[]const u8 {
    return app.withLock(GetCtx{ .arena = arena, .id = id }, viewJsonLocked);
}

test "runtime routes: start body rejects an explicit null model" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(error.InvalidBody, parseStartBody(arena.allocator(), "{\"agentId\":\"fake\",\"repo\":\"/tmp\",\"prompt\":\"say\",\"model\":null}"));
}

test "runtime routes: event body truncates at UTF-16 units and preserves a lone surrogate" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const body = try allocator.alloc(u8, 8003);
    @memset(body[0..7999], 'a');
    @memcpy(body[7999..], "🙂");
    const value = (try bodyPrefix(allocator, body)).?;
    const json = try std.json.Stringify.valueAlloc(allocator, value, .{});
    defer allocator.free(json);
    var expected: std.ArrayList(u8) = .empty;
    defer expected.deinit(allocator);
    try expected.append(allocator, '"');
    try expected.appendNTimes(allocator, 'a', 7999);
    try expected.appendSlice(allocator, "\\ud83d\"");
    try std.testing.expectEqualStrings(expected.items, json);
}

const EventView = struct {
    rowid: i64,
    ts: i64,
    kind: []const u8,
    toolName: ?[]const u8,
    command: ?[]const u8,
    exitCode: ?i64,
    guardLayer: ?[]const u8,
    guardVerdict: ?[]const u8,
    guardRule: ?[]const u8,
    body: ?JsonString,
};

const JsonString = struct {
    units: []const u16,

    pub fn jsonStringify(self: JsonString, jw: anytype) !void {
        try jw.beginWriteRaw();
        try log_text.writeJsonString(jw.writer, self.units);
        jw.endWriteRaw();
    }
};

fn bodyPrefix(arena: std.mem.Allocator, body: ?[]u8) !?JsonString {
    const text = body orelse return null;
    const units = try log_text.toUtf16(arena, text);
    return .{ .units = units[0..@min(units.len, 8000)] };
}

const Detail = struct { run: RunView, events: []EventView };
const DetailCtx = struct { arena: std.mem.Allocator, id: []const u8, after: i64 };

fn detailLocked(ctx: DetailCtx, state: *app_mod.State) !?Detail {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const row = try manager.getRun(db, ctx.arena, ctx.id) orelse return null;
    const totals = try summary.usageSummary(ctx.arena, db, .run, 0);
    const stmt = try db.prepare("SELECT rowid, ts, kind, gen_ai_tool_name, command, exit_code, guard_layer, guard_verdict, guard_rule FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid");
    defer stmt.finalize();
    try stmt.bindText(1, ctx.id);
    try stmt.bindInt(2, ctx.after);
    var events: std.ArrayList(EventView) = .empty;
    while (try stmt.step()) {
        const rowid = stmt.int(0);
        try events.append(ctx.arena, .{
            .rowid = rowid,
            .ts = stmt.int(1),
            .kind = (try stmt.textAlloc(ctx.arena, 2)).?,
            .toolName = try stmt.textAlloc(ctx.arena, 3),
            .command = try stmt.textAlloc(ctx.arena, 4),
            .exitCode = if (stmt.isNull(5)) null else stmt.int(5),
            .guardLayer = try stmt.textAlloc(ctx.arena, 6),
            .guardVerdict = try stmt.textAlloc(ctx.arena, 7),
            .guardRule = try stmt.textAlloc(ctx.arena, 8),
            .body = try bodyPrefix(ctx.arena, try logs.readBody(ctx.arena, db, rowid)),
        });
    }
    return .{ .run = view(row, totals), .events = events.items };
}

fn afterQuery(req: *httpz.Request) error{InvalidAfter}!i64 {
    const query = req.query() catch return error.InvalidAfter;
    const raw = query.get("after") orelse return 0;
    const number = parity.coerceNumber(raw) orelse return error.InvalidAfter;
    if (!std.math.isFinite(number) or number < 0 or number >= 9223372036854775808.0 or number != @floor(number)) return error.InvalidAfter;
    return @intFromFloat(number);
}

pub fn detail(call: *Call) anyerror!void {
    const after = afterQuery(call.req) catch return headers.sendError(call.res, 400, "invalid after");
    const row = try call.services.app.withLock(DetailCtx{ .arena = call.res.arena, .id = call.req.param("id") orelse "", .after = after }, detailLocked);
    try headers.sendJson(call.res, row orelse return headers.sendError(call.res, 404, "unknown run"));
}

pub fn kill(call: *Call) anyerror!void {
    const m = call.services.manager orelse return callNotImplemented(call);
    const actor = call.actor orelse return headers.sendError(call.res, 401, "unauthorized");
    if (!try middleware.requireStepUp(call.res, actor, ids.nowMs(call.services.app.io))) return;
    if (!try m.killRun(call.req.param("id") orelse "", "killed"))
        return headers.sendError(call.res, 404, "no live run");
    try headers.sendJson(call.res, .{ .ok = true });
}

fn callNotImplemented(call: *Call) anyerror!void {
    try headers.sendError(call.res, 501, "not_implemented");
}
