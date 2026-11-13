//! The guard routes: `GET /api/approvals` and `POST /api/approvals/:id` of guard/routes.ts, and
//! `POST /api/guard/hook` of http.ts. `GET /api/approvals/:id` (the deep link) belongs to phase 5.
//!
//! The approvals are not behind the instance-admin gate: an org owner or admin may decide the runs
//! of its own members. The session gate has run; `requireOrgAdmin` is the first thing each handler
//! does, as the `app.use("*")` of TS is.
const std = @import("std");
const Allocator = std.mem.Allocator;
const app_mod = @import("../app.zig");
const middleware = @import("../auth/middleware.zig");
const headers = @import("../http/headers.zig");
const ids = @import("../ids.zig");
const logs = @import("../logs/api.zig");
const policy = @import("../http/policy.zig");
const routes = @import("../http/routes.zig");
const sqlite = @import("../db/sqlite.zig");
const tokens = @import("../mcp/tokens.zig");
const types = @import("../runtimes/types.zig");
const approvals = @import("approvals.zig");
const limits = @import("limits.zig");

const State = app_mod.State;

const LockedError = approvals.Error;

fn dbOf(state: *State) LockedError!sqlite.Db {
    return .{ .handle = state.db orelse return error.NoDatabase };
}

// ---- org access: the only SQL of this file on org tables, for orgs/repo.zig to replace --------
// `administeredOrgs`, `runOrg` and `mayDecide` of guard/routes.ts. The run and project reads are
// the ones limits.zig already has; the role read is `orgAccess` plus `roleAtLeast(role, "admin")`.

/// The ids of the orgs where the user is owner or admin.
fn administeredOrgs(db: sqlite.Db, a: Allocator, user_id: []const u8) ![]const []const u8 {
    const stmt = try db.prepare(
        \\SELECT DISTINCT m.org_id FROM members m JOIN orgs o ON o.id = m.org_id
        \\ WHERE m.user_id = ? AND m.role IN ('admin', 'owner')
    );
    defer stmt.finalize();
    try stmt.bindText(1, user_id);
    var out: std.ArrayList([]const u8) = .empty;
    while (try stmt.step()) try out.append(a, (try stmt.textAlloc(a, 0)).?);
    return out.items;
}

fn contains(set: []const []const u8, id: []const u8) bool {
    for (set) |item| if (std.mem.eql(u8, item, id)) return true;
    return false;
}

/// The org that decides for a run. A run in a project works in that project's repo, so the org
/// owning the project decides, not a grantee org whose agent happens to run there. A run without
/// a member belongs to nobody.
fn runOrg(db: sqlite.Db, a: Allocator, run_id: []const u8) !?[]const u8 {
    const run = try limits.runLinkOf(db, a, run_id) orelse return null;
    const member_id = run.member_id orelse return null;
    if (member_id.len == 0) return null;
    if (run.project_id) |project_id| if (try limits.projectOrg(db, a, project_id)) |org| return org;
    return limits.memberOrg(db, a, member_id);
}

/// The instance admin sees everything; an org owner or admin sees the runs of its own members.
fn mayDecide(db: sqlite.Db, a: Allocator, actor: policy.Actor, run_id: []const u8) !bool {
    if (actor.instance_admin) return true;
    const org = try runOrg(db, a, run_id) orelse return false;
    return contains(try administeredOrgs(db, a, actor.user_id), org);
}

// ---- GET /api/approvals ----

/// `c.req.query("status")`: the first pair whose decoded name is `status`; `+` is a space and an
/// undecodable `%` run stays as written.
fn queryStatus(arena: Allocator, raw: []const u8) Allocator.Error!?[]const u8 {
    var pairs = std.mem.splitScalar(u8, raw, '&');
    while (pairs.next()) |pair| {
        const eq = std.mem.findScalar(u8, pair, '=');
        const key = try decodeComponent(arena, pair[0 .. eq orelse pair.len]);
        if (!std.mem.eql(u8, key, "status")) continue;
        return if (eq) |at| try decodeComponent(arena, pair[at + 1 ..]) else "";
    }
    return null;
}

fn decodeComponent(arena: Allocator, raw: []const u8) Allocator.Error![]const u8 {
    const spaced = try arena.dupe(u8, raw);
    std.mem.replaceScalar(u8, spaced, '+', ' ');
    return middleware.percentDecode(arena, spaced);
}

const ListArgs = struct { arena: Allocator, actor: policy.Actor, status: ?approvals.Status };

fn listLocked(args: ListArgs, state: *State) LockedError![]const approvals.View {
    const db = try dbOf(state);
    const a = args.arena;
    const orgs: ?[]const []const u8 = if (args.actor.instance_admin) null else try administeredOrgs(db, a, args.actor.user_id);
    var views: std.ArrayList(approvals.View) = .empty;
    for (try approvals.list(db, a, args.status)) |row| {
        if (orgs) |own| {
            const org = try runOrg(db, a, row.run_id) orelse continue;
            if (!contains(own, org)) continue;
        }
        try views.append(a, try approvals.view(a, row));
    }
    return views.items;
}

pub fn list(call: *routes.Call) anyerror!void {
    const actor = call.actor orelse return error.Unauthorized;
    const app = call.services.app;
    if (!try middleware.requireOrgAdmin(app, call.res, actor)) return;
    const arena = call.res.arena;
    var status: ?approvals.Status = null;
    if (try queryStatus(arena, call.req.url.query)) |raw| {
        status = std.meta.stringToEnum(approvals.Status, raw) orelse return headers.sendError(call.res, 400, "invalid status");
    }
    const views = try app.withLock(ListArgs{ .arena = arena, .actor = actor, .status = status }, listLocked);
    try headers.sendJson(call.res, views);
}

// ---- POST /api/approvals/:id ----

/// A string field of a parsed body, or null when the body is no object or the field is missing or
/// not a string. Bodies are read as `std.json.Value` and not into a struct: std.json fills an enum
/// from the number 1 and a `[]const u8` from an array of byte values, zod accepts neither.
fn textField(body: std.json.Value, key: []const u8) ?[]const u8 {
    if (body != .object) return null;
    const field = body.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn decisionOf(text: []const u8) ?approvals.Decision {
    return std.meta.stringToEnum(approvals.Decision, text);
}

const DecideArgs = struct {
    arena: Allocator,
    io: std.Io,
    actor: policy.Actor,
    id: []const u8,
    decision: approvals.Decision,
    home: []const u8,
};

const Outcome = union(enum) {
    unknown,
    forbidden,
    /// `orgAdminRefusal`: what only the instance admin may wave through.
    refused: []const u8,
    not_pending,
    done: approvals.View,
};

fn decideLocked(args: DecideArgs, state: *State) !Outcome {
    const db = try dbOf(state);
    const a = args.arena;
    const row = try approvals.get(db, a, args.id) orelse return .unknown;
    if (!try mayDecide(db, a, args.actor, row.run_id)) return .forbidden;
    if (!args.actor.instance_admin) {
        if (try limits.orgAdminRefusal(a, args.io, row, args.home)) |reason| return .{ .refused = reason };
    }
    const by = try std.fmt.allocPrint(a, "user:{s}", .{args.actor.user_id});
    // One UPDATE decides: a second caller, or the expiry, finds the row no longer pending.
    if (!try approvals.decide(db, args.id, args.decision, by, ids.nowMs(args.io))) return .not_pending;
    const fresh = try approvals.get(db, a, args.id) orelse return .unknown;
    return .{ .done = try approvals.view(a, fresh) };
}

const Refusal = struct { @"error": []const u8 = "instance_admin_required", reason: []const u8 };

pub fn decide(call: *routes.Call) anyerror!void {
    const actor = call.actor orelse return error.Unauthorized;
    const app = call.services.app;
    if (!try middleware.requireOrgAdmin(app, call.res, actor)) return;
    if (!try middleware.requireStepUp(call.res, actor, ids.nowMs(app.io))) return;
    const body = headers.parseBody(std.json.Value, call.req) catch return headers.sendError(call.res, 400, "invalid body");
    const decision = decisionOf(textField(body, "decision") orelse "") orelse return headers.sendError(call.res, 400, "invalid body");
    const id = call.req.param("id") orelse return headers.sendError(call.res, 404, "unknown approval");
    const outcome = try app.withLock(DecideArgs{
        .arena = call.res.arena,
        .io = app.io,
        .actor = actor,
        .id = id,
        .decision = decision,
        .home = call.services.home,
    }, decideLocked);
    switch (outcome) {
        .unknown => try headers.sendError(call.res, 404, "unknown approval"),
        .forbidden => try headers.sendError(call.res, 403, "forbidden"),
        .refused => |reason| {
            call.res.status = 403;
            try headers.sendJson(call.res, Refusal{ .reason = reason });
        },
        .not_pending => try headers.sendError(call.res, 409, "not pending"),
        .done => |view| try headers.sendJson(call.res, view),
    }
}

// ---- POST /api/guard/hook ----

/// `hookBody`: `runId` at least one character, `rule` at most 200 and `command` at most 20000.
/// Characters are code points: zod 4 counts them, not UTF-16 units (checked against the installed
/// zod 4.6.7: five emoji pass `max(5)`, six fail).
const HookBody = struct {
    runId: []const u8,
    /// `allow`, `ask` or `deny`.
    verdict: []const u8,
    rule: []const u8,
    command: []const u8,
};
const max_rule_chars = 200;
const max_command_chars = 20000;

/// `^Bearer (\S+)$`.
fn bearer(header: ?[]const u8) ?[]const u8 {
    const value = header orelse return null;
    const prefix = "Bearer ";
    if (!std.mem.startsWith(u8, value, prefix)) return null;
    const token = value[prefix.len..];
    if (token.len == 0) return null;
    for (token) |ch| if (std.ascii.isWhitespace(ch)) return null;
    return token;
}

fn hookBody(parsed: std.json.Value) ?HookBody {
    return .{
        .runId = textField(parsed, "runId") orelse return null,
        .verdict = textField(parsed, "verdict") orelse return null,
        .rule = textField(parsed, "rule") orelse return null,
        .command = textField(parsed, "command") orelse return null,
    };
}

fn verdictOf(text: []const u8) ?types.GuardVerdict {
    return std.meta.stringToEnum(types.GuardVerdict, text);
}

fn validHook(body: HookBody) bool {
    if (body.runId.len == 0 or verdictOf(body.verdict) == null) return false;
    const rule = std.unicode.utf8CountCodepoints(body.rule) catch return false;
    const command = std.unicode.utf8CountCodepoints(body.command) catch return false;
    return rule <= max_rule_chars and command <= max_command_chars;
}

const AppendArgs = struct { io: std.Io, gpa: Allocator, body: HookBody };

fn appendLocked(args: AppendArgs, state: *State) !void {
    const db = try dbOf(state);
    const now = ids.nowMs(args.io);
    const id = ids.uuidV7(args.io);
    _ = try logs.appendEvent(args.gpa, db, &id, now, .{
        .run_id = args.body.runId,
        .kind = .guard,
        .source = "hook",
        .command = args.body.command,
        .guard_verdict = verdictOf(args.body.verdict),
        .guard_rule = args.body.rule,
    });
}

/// The one `/api` route an agent may call: needs a run token scoped `guard_hook`, for its own run.
pub fn hook(call: *routes.Call) anyerror!void {
    const app = call.services.app;
    const res = call.res;
    const token = bearer(call.req.header("authorization")) orelse return headers.sendError(res, 401, "unauthorized");
    const identity = try tokens.verify(app, res.arena, token) orelse return headers.sendError(res, 401, "unauthorized");
    if (!identity.hasScope("guard_hook")) return headers.sendError(res, 403, "forbidden");
    const parsed = headers.parseBody(std.json.Value, call.req) catch return headers.sendError(res, 400, "invalid body");
    const body = hookBody(parsed) orelse return headers.sendError(res, 400, "invalid body");
    if (!validHook(body)) return headers.sendError(res, 400, "invalid body");
    if (!std.mem.eql(u8, body.runId, identity.run_id)) return headers.sendError(res, 403, "forbidden");
    try app.withLock(AppendArgs{ .io = app.io, .gpa = app.gpa, .body = body }, appendLocked);
    try headers.sendJson(res, .{ .ok = true });
}

test {
    _ = @import("routes_test.zig");
}
