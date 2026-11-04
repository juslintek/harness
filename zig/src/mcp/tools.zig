//! The tool table and the two tools that live in the dispatcher itself (`whoami`, `report`). One
//! comptime table of `{name, scope, handler}` feeds `tools/call` and the guard's allowlist;
//! `tools/list` serves `contract/mcp-tools.json` and a test pins the table to its names and scopes.
//! The tools of other slices are rows whose handler is `notImplemented` until that slice swaps it.
const std = @import("std");
const app_mod = @import("../app.zig");
const ids = @import("../ids.zig");
const manager = @import("../runtimes/manager.zig");
const sqlite = @import("../db/sqlite.zig");
const tokens = @import("tokens.zig");

const App = app_mod.App;
const State = app_mod.State;

/// `MAX_REPORT_CHARS`.
pub const max_report_chars = 4000;

/// `McpDeps` of server.ts. `on_report` is `onReport`; without it a report is a plain events row, as
/// in a server that has no logs slice yet.
pub const Deps = struct {
    ctx: ?*anyopaque = null,
    on_report: ?*const fn (ctx: ?*anyopaque, run_id: []const u8, text: []const u8) anyerror!void = null,
};

pub const Result = struct {
    text: []const u8,
    is_error: bool = false,
};

pub const Ctx = struct {
    arena: std.mem.Allocator,
    app: *App,
    deps: *const Deps,
    identity: tokens.Identity,
    tool: *const Tool,
    /// `params.arguments` of the call, or null when it was absent (`args ?? {}` in the SDK).
    args: ?std.json.Value,
};

pub const Handler = *const fn (ctx: *Ctx) anyerror!Result;

pub const Tool = struct {
    name: []const u8,
    /// The scope the handler demands first thing; null for `whoami`.
    scope: ?[]const u8,
    handler: Handler,
};

/// The refusal every scoped tool opens with. Null means the token holds the scope.
pub fn requireScope(ctx: *const Ctx) ?Result {
    const scope = ctx.tool.scope orelse return null;
    if (ctx.identity.hasScope(scope)) return null;
    return .{ .is_error = true, .text = std.fmt.allocPrint(ctx.arena, "token lacks {s} scope", .{scope}) catch "token lacks scope" };
}

pub fn notImplemented(ctx: *Ctx) anyerror!Result {
    if (requireScope(ctx)) |refused| return refused;
    return .{ .is_error = true, .text = try std.fmt.allocPrint(ctx.arena, "tool {s} is not implemented yet", .{ctx.tool.name}) };
}

fn pending(comptime name: []const u8, comptime scope: []const u8) Tool {
    return .{ .name = name, .scope = scope, .handler = notImplemented };
}

/// Sorted by name, as the dump is. `contract/mcp-tools.json` is the source of the names and scopes.
pub const table = [_]Tool{
    pending("approvals_decide", "approvals_decide"),
    pending("approvals_list", "approvals_decide"),
    pending("board_list", "board"),
    pending("chat_channels", "chat"),
    pending("chat_dm", "chat"),
    pending("chat_post", "chat"),
    pending("chat_read", "chat"),
    pending("hire_decide", "hiring"),
    pending("hire_list", "hiring"),
    pending("hire_request", "hiring"),
    pending("interview_answer", "interview"),
    pending("interview_ask", "hiring"),
    pending("interview_pass", "hiring"),
    pending("interview_score", "hiring"),
    pending("policy_decide", "policy"),
    pending("policy_get", "policy"),
    pending("policy_propose", "policy"),
    pending("policy_review", "policy"),
    pending("profile_card_submit", "profile"),
    pending("profile_get", "profile"),
    .{ .name = "report", .scope = "report", .handler = report },
    pending("task_checkout", "board"),
    pending("task_comment", "board"),
    pending("task_create", "board"),
    pending("task_delegate", "board"),
    pending("task_depend", "board"),
    pending("task_estimate", "board"),
    pending("task_get", "board"),
    pending("task_move", "board"),
    pending("task_release", "board"),
    pending("task_update", "board"),
    pending("team_roster", "board"),
    .{ .name = "whoami", .scope = null, .handler = whoami },
};

pub fn find(name: []const u8) ?*const Tool {
    for (&table) |*tool| if (std.mem.eql(u8, tool.name, name)) return tool;
    return null;
}

/// How zod words the type it got: `typeof`, with null and array told apart.
pub fn jsKind(value: ?std.json.Value) []const u8 {
    const v = value orelse return "undefined";
    return switch (v) {
        .null => "null",
        .bool => "boolean",
        .integer, .float, .number_string => "number",
        .string => "string",
        .array => "array",
        .object => "object",
    };
}

/// What the SDK's `validateToolInput` throws, as the text of the error result.
pub fn invalidArguments(arena: std.mem.Allocator, tool: []const u8, message: []const u8, path: []const u8) !Result {
    return .{
        .is_error = true,
        .text = try std.fmt.allocPrint(arena, "MCP error -32602: Input validation error: Invalid arguments for tool {s}: {s} at {s}", .{ tool, message, path }),
    };
}

// ---- whoami ----

const Member = struct { id: []const u8, handle: []const u8, org_id: []const u8, role: []const u8 };
const Position = struct { title: []const u8, is_manager: bool };
const WhoamiData = struct { member: ?Member, positions: []const Position };

fn dbOf(state: *State) !sqlite.Db {
    return .{ .handle = state.db orelse return error.NoDatabase };
}

const WhoamiArgs = struct { arena: std.mem.Allocator, member_id: ?[]const u8 };

/// `getMember` and the member's rows of `listPositions` (org order: created_at, id).
fn whoamiLocked(args: *const WhoamiArgs, state: *State) !WhoamiData {
    const member_id = args.member_id orelse return .{ .member = null, .positions = &.{} };
    const db = try dbOf(state);
    const stmt = try db.prepare("SELECT id, handle, org_id, role FROM members WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, member_id);
    if (!try stmt.step()) return .{ .member = null, .positions = &.{} };
    const member: Member = .{
        .id = (try stmt.textAlloc(args.arena, 0)).?,
        .handle = (try stmt.textAlloc(args.arena, 1)).?,
        .org_id = (try stmt.textAlloc(args.arena, 2)).?,
        .role = (try stmt.textAlloc(args.arena, 3)).?,
    };
    const rows = try db.prepare("SELECT title, is_manager FROM positions WHERE org_id = ? AND member_id = ? ORDER BY created_at, id");
    defer rows.finalize();
    try rows.bindText(1, member.org_id);
    try rows.bindText(2, member.id);
    var positions: std.ArrayList(Position) = .empty;
    while (try rows.step()) {
        try positions.append(args.arena, .{ .title = (try rows.textAlloc(args.arena, 0)).?, .is_manager = rows.int(1) != 0 });
    }
    return .{ .member = member, .positions = positions.items };
}

fn whoami(ctx: *Ctx) anyerror!Result {
    const data = try ctx.app.withLock(&WhoamiArgs{ .arena = ctx.arena, .member_id = ctx.identity.member_id }, whoamiLocked);
    var out: std.Io.Writer.Allocating = .init(ctx.arena);
    var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try jw.beginObject();
    try jw.objectField("runId");
    try jw.write(ctx.identity.run_id);
    try jw.objectField("scopes");
    try jw.write(ctx.identity.scopes);
    if (data.member) |member| {
        try jw.objectField("member");
        try jw.beginObject();
        try jw.objectField("id");
        try jw.write(member.id);
        try jw.objectField("handle");
        try jw.write(member.handle);
        try jw.objectField("orgId");
        try jw.write(member.org_id);
        try jw.objectField("role");
        try jw.write(member.role);
        try jw.objectField("positions");
        try jw.beginArray();
        for (data.positions) |position| {
            try jw.beginObject();
            try jw.objectField("title");
            try jw.write(position.title);
            try jw.objectField("isManager");
            try jw.write(position.is_manager);
            try jw.endObject();
        }
        try jw.endArray();
        try jw.endObject();
    }
    try jw.endObject();
    return .{ .text = out.written() };
}

// ---- report ----

const ReportArgs = struct { app: *App, run_id: []const u8, text: []const u8, now: i64 };

fn insertReport(args: *const ReportArgs, state: *State) !void {
    const id = ids.uuidV7(args.app.io);
    try manager.insertEventPlain(try dbOf(state), .{ .kind = .message, .source = "mcp", .run_id = args.run_id, .body = args.text }, &id, args.now);
}

/// `report`: `text` is a string of at most 4000 characters. zod 4 counts code points (checked
/// against SDK 1.32.2: 4000 emoji pass, 4001 fail), not UTF-16 units. Extra keys are ignored.
fn report(ctx: *Ctx) anyerror!Result {
    const text_value: ?std.json.Value = if (ctx.args) |args| (if (args == .object) args.object.get("text") else null) else null;
    const text = switch (text_value orelse return invalidArguments(ctx.arena, "report", "Invalid input: expected string, received undefined", "text")) {
        .string => |s| s,
        else => return invalidArguments(ctx.arena, "report", try std.fmt.allocPrint(ctx.arena, "Invalid input: expected string, received {s}", .{jsKind(text_value)}), "text"),
    };
    const chars = std.unicode.utf8CountCodepoints(text) catch return error.InvalidUtf8;
    if (chars > max_report_chars) {
        return invalidArguments(ctx.arena, "report", try std.fmt.allocPrint(ctx.arena, "Too big: expected string to have <={d} characters", .{max_report_chars}), "text");
    }
    if (requireScope(ctx)) |refused| return refused;
    if (ctx.deps.on_report) |on_report| {
        try on_report(ctx.deps.ctx, ctx.identity.run_id, text);
    } else {
        try ctx.app.withLock(&ReportArgs{ .app = ctx.app, .run_id = ctx.identity.run_id, .text = text, .now = ids.nowMs(ctx.app.io) }, insertReport);
    }
    return .{ .text = "ok" };
}

// ---- tools/list ----

/// The embedded `contract/mcp-tools.json`, what the TS server answers `tools/list` with plus the
/// `scope` field the dump adds.
pub const dump = @embedFile("mcp_tools_json");

/// `{"tools":[...]}` in the order and shape of the SDK's ListTools handler: name, description,
/// inputSchema, execution. `scope` is the dump's own addition and never goes on the wire. The
/// schemas keep the dump's key order.
pub fn writeToolsList(arena: std.mem.Allocator, jw: *std.json.Stringify) !void {
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena, dump, .{});
    try jw.beginObject();
    try jw.objectField("tools");
    try jw.beginArray();
    for (parsed.array.items) |entry| {
        try jw.beginObject();
        inline for (.{ "name", "description", "inputSchema", "execution" }) |key| {
            if (entry.object.get(key)) |field| {
                try jw.objectField(key);
                try jw.write(field);
            }
        }
        try jw.endObject();
    }
    try jw.endArray();
    try jw.endObject();
}

// ---- tests ----

const testing = std.testing;

test "mcp: the tool table has the names and scopes of the contract dump, in order" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), dump, .{});
    try testing.expectEqual(table.len, parsed.array.items.len);
    for (parsed.array.items, table) |entry, tool| {
        try testing.expectEqualStrings(entry.object.get("name").?.string, tool.name);
        const scope = entry.object.get("scope").?;
        if (tool.scope) |expected| try testing.expectEqualStrings(expected, scope.string) else try testing.expect(scope == .null);
    }
}

test "mcp: tools/list drops the dump's scope field and keeps the SDK key order" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var out: std.Io.Writer.Allocating = .init(arena.allocator());
    var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{} };
    try writeToolsList(arena.allocator(), &jw);
    const text = out.written();
    try testing.expect(std.mem.startsWith(u8, text, "{\"tools\":[{\"name\":\"approvals_decide\",\"description\":"));
    try testing.expect(std.mem.find(u8, text, "\"scope\"") == null);
    try testing.expect(std.mem.find(u8, text, "{\"name\":\"whoami\",\"description\":\"Identify the run and member this token belongs to\",\"inputSchema\":{\"properties\":{},\"type\":\"object\"},\"execution\":{\"taskSupport\":\"forbidden\"}}") != null);
}

test "mcp: find resolves names and nothing else" {
    try testing.expect(find("report") != null and find("whoami") != null);
    try testing.expect(find("Report") == null and find("") == null and find("report ") == null);
}

test "mcp: text that is not a string names the type it got" {
    try testing.expectEqualStrings("undefined", jsKind(null));
    try testing.expectEqualStrings("null", jsKind(.null));
    try testing.expectEqualStrings("array", jsKind(.{ .array = .init(testing.allocator) }));
    try testing.expectEqualStrings("number", jsKind(.{ .integer = 5 }));
}
