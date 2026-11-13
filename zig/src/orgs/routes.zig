//! The orgs HTTP routes of routes.ts, routes-members.ts and routes-positions.ts. A handler parses
//! the body without answering, so the org lookup and role checks of the operation still come
//! first, then hands everything to one operation under the state lock.
const std = @import("std");
const agent_specs = @import("../agents/specs.zig");
const body_mod = @import("body.zig");
const codes = @import("../auth/codes.zig");
const fail = @import("fail.zig");
const gitcheck = @import("gitcheck.zig");
const guard = @import("guard.zig");
const headers = @import("../http/headers.zig");
const ids = @import("../ids.zig");
const members = @import("members.zig");
const ops = @import("ops.zig");
const repo = @import("repo.zig");
const routes = @import("../http/routes.zig");

const Args = guard.Args;

fn ctxOf(call: *routes.Call) error{Unauthorized}!guard.Ctx {
    const io = call.services.app.io;
    return .{
        .arena = call.req.arena,
        .io = io,
        .actor = call.actor orelse return error.Unauthorized,
        .now = ids.nowMs(io),
        .origin = call.origin,
    };
}

fn param(call: *routes.Call, name: []const u8) []const u8 {
    return call.req.param(name) orelse "";
}

fn argsFor(comptime Body: type, call: *routes.Call, parsed: ?Body) error{Unauthorized}!Args(Body) {
    return .{ .ctx = try ctxOf(call), .slug = param(call, "org"), .id = param(call, "id"), .body = parsed };
}

/// Sends `result` with `status`, or the answer its error maps to.
fn respond(call: *routes.Call, status: u16, result: anytype) !void {
    const value = result catch |err| return fail.send(call.res, err);
    call.res.status = status;
    try headers.sendJson(call.res, value);
}

fn bodyText(call: *routes.Call) ?[]const u8 {
    return call.req.body();
}

pub fn list(call: *routes.Call) anyerror!void {
    const args = try argsFor(guard.Empty, call, null);
    try respond(call, 200, codes.run(call.services.app, args, ops.list));
}

pub fn create(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.CreateOrg, call, try body_mod.createOrg(call.req.arena, bodyText(call)));
    try respond(call, 201, fail.inTx(call.services.app, args, ops.create));
}

pub fn detail(call: *routes.Call) anyerror!void {
    const args = try argsFor(guard.Empty, call, null);
    try respond(call, 200, codes.run(call.services.app, args, ops.detail));
}

pub fn createTeam(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.Name, call, try body_mod.name(call.req.arena, bodyText(call)));
    try respond(call, 201, fail.inTx(call.services.app, args, ops.createTeam));
}

pub fn addTeamMember(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.MemberId, call, try body_mod.memberId(call.req.arena, bodyText(call)));
    try respond(call, 200, fail.inTx(call.services.app, args, ops.addTeamMember));
}

pub fn createProject(call: *routes.Call) anyerror!void {
    const app = call.services.app;
    var args = try argsFor(body_mod.Project, call, try body_mod.project(call.req.arena, bodyText(call)));
    if (args.body) |parsed| if (parsed.repo) |path| {
        // The path is looked at outside the lock, after the checks that come before it in TS.
        args.dry = true;
        _ = fail.inTx(app, args, ops.createProject) catch |err| return fail.send(call.res, err);
        const env = if (call.services.agents) |agents| agents.env else null;
        if (try gitcheck.refusal(app.gpa, app.io, call.req.arena, env, path)) |message| return headers.sendError(call.res, 400, message);
        args.dry = false;
    };
    const created = fail.inTx(app, args, ops.createProject) catch |err| return fail.send(call.res, err);
    const row = created orelse return error.Unexpected;
    call.res.status = 201;
    try headers.sendJson(call.res, row);
}

pub fn grant(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.Grant, call, try body_mod.grant(call.req.arena, bodyText(call)));
    try respond(call, 200, fail.inTx(call.services.app, args, ops.grant));
}

pub fn revoke(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.Revoke, call, try body_mod.revoke(call.req.arena, bodyText(call)));
    try respond(call, 200, fail.inTx(call.services.app, args, ops.revoke));
}

pub fn addHuman(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.AddHuman, call, try body_mod.addHuman(call.req.arena, bodyText(call)));
    const invited = fail.inTx(call.services.app, args, members.addHuman) catch |err| return fail.send(call.res, err);
    call.res.status = 201;
    switch (invited) {
        inline else => |answer| try headers.sendJson(call.res, answer),
    }
}

pub fn addAgent(call: *routes.Call) anyerror!void {
    const parsed = try body_mod.addAgent(call.req.arena, bodyText(call));
    var args = try argsFor(body_mod.AddAgent, call, parsed);
    if (parsed) |agent| if (call.services.agents) |agents| {
        args.agent_known = agent_specs.find(agents.specs, agent.agent_id) != null;
    };
    try respond(call, 201, fail.inTx(call.services.app, args, members.addAgent));
}

pub fn patchMember(call: *routes.Call) anyerror!void {
    const args = try argsFor(repo.MemberPatch, call, try body_mod.memberPatch(call.req.arena, bodyText(call)));
    try respond(call, 200, fail.inTx(call.services.app, args, members.patch));
}

pub fn removeMember(call: *routes.Call) anyerror!void {
    const args = try argsFor(guard.Empty, call, null);
    try respond(call, 200, fail.inTx(call.services.app, args, members.remove));
}

pub fn createPosition(call: *routes.Call) anyerror!void {
    const args = try argsFor(body_mod.Position, call, try body_mod.position(call.req.arena, bodyText(call)));
    try respond(call, 201, fail.inTx(call.services.app, args, ops.createPosition));
}

pub fn patchPosition(call: *routes.Call) anyerror!void {
    const args = try argsFor(repo.PositionPatch, call, try body_mod.positionPatch(call.req.arena, bodyText(call)));
    try respond(call, 200, fail.inTx(call.services.app, args, ops.patchPosition));
}

test {
    _ = @import("routes_test.zig");
}
