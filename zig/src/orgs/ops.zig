//! The org, team, project, grant and position operations of routes.ts and routes-positions.ts.
//! Each runs under the state lock (the writing ones in a transaction) and keeps TS's check order,
//! which decides whether a caller sees 404, 403, a step-up demand or 400. Each returns the value
//! the route sends.
const std = @import("std");
const access = @import("access.zig");
const body_mod = @import("body.zig");
const codes = @import("../auth/codes.zig");
const guard = @import("guard.zig");
const repo = @import("repo.zig");
const sqlite = @import("../db/sqlite.zig");

const Args = guard.Args;
const Error = guard.Error;
const Ok = guard.Ok;
const bodyOf = guard.bodyOf;
const needStepUp = guard.needStepUp;
const resolveOrg = guard.resolveOrg;

// ---- orgs ----

pub fn list(db: sqlite.Db, a: Args(guard.Empty)) Error![]repo.OrgView {
    return repo.orgsForUser(db, a.ctx.arena, a.ctx.actor.user_id);
}

pub fn create(db: sqlite.Db, a: Args(body_mod.CreateOrg)) Error!repo.OrgView {
    const b = try bodyOf(body_mod.CreateOrg, a);
    const user = try codes.userById(db, a.ctx.arena, a.ctx.actor.user_id) orelse return error.NotFound;
    return repo.createOrg(db, a.ctx.io, a.ctx.arena, .{
        .name = b.name,
        .slug = b.slug,
        .owner_user_id = user.id,
        .owner_name = user.name,
        .owner_handle = try repo.handleFromEmail(a.ctx.arena, user.email),
    });
}

pub const Detail = struct {
    org: repo.OrgView,
    me: repo.MemberRow,
    teams: []const repo.TeamRow,
    members: []const repo.MemberRow,
    positions: []const repo.PositionRow,
    projects: []const repo.ProjectRow,
};

pub fn detail(db: sqlite.Db, a: Args(guard.Empty)) Error!Detail {
    const c = try resolveOrg(db, a.ctx, a.slug, .viewer);
    const projects = try repo.projects(db, a.ctx.arena, c.org.id);
    // The repo path is a host path: only the instance admin sees it, and only for projects this org owns.
    for (projects) |*p| {
        if (!(a.ctx.actor.instance_admin and std.mem.eql(u8, p.orgId, c.org.id))) p.repo = null;
    }
    return .{
        .org = c.org,
        .me = c.member,
        .teams = try repo.teams(db, a.ctx.arena, c.org.id),
        .members = try repo.members(db, a.ctx.arena, c.org.id),
        .positions = try repo.positions(db, a.ctx.arena, c.org.id),
        .projects = projects,
    };
}

// ---- teams ----

pub fn createTeam(db: sqlite.Db, a: Args(body_mod.Name)) Error!repo.TeamRow {
    const c = try resolveOrg(db, a.ctx, a.slug, .admin);
    const b = try bodyOf(body_mod.Name, a);
    return repo.createTeam(db, a.ctx.io, a.ctx.arena, c.org.id, b.name);
}

pub fn addTeamMember(db: sqlite.Db, a: Args(body_mod.MemberId)) Error!Ok {
    const c = try resolveOrg(db, a.ctx, a.slug, .admin);
    const b = try bodyOf(body_mod.MemberId, a);
    const team = try guard.teamOf(db, a.ctx, c.org.id, a.id) orelse return error.NotFound;
    _ = try guard.memberInOrg(db, a.ctx, c.org.id, b.member_id) orelse return error.MemberNotInOrg;
    try repo.addToTeam(db, team.id, b.member_id);
    return .{};
}

// ---- projects and grants ----

/// With `dry` set, stops after the checks and answers null: the caller then looks at the repo
/// path outside the lock and runs the operation again to write.
pub fn createProject(db: sqlite.Db, a: Args(body_mod.Project)) Error!?repo.ProjectRow {
    const c = try resolveOrg(db, a.ctx, a.slug, .admin);
    const b = try bodyOf(body_mod.Project, a);
    // A repo path makes runs cut worktrees from that directory, so only the instance admin may set it, and only with a fresh step-up.
    if (b.repo != null) {
        if (!a.ctx.actor.instance_admin) return error.Forbidden;
        try needStepUp(a.ctx);
    }
    if (b.team_id) |team_id| if (try guard.teamOf(db, a.ctx, c.org.id, team_id) == null) return error.TeamNotInOrg;
    if (a.dry) return null;
    return try repo.createProject(db, a.ctx.io, a.ctx.arena, .{ .org_id = c.org.id, .team_id = b.team_id, .key = b.key, .name = b.name, .repo = b.repo });
}

const GrantTarget = struct { project: repo.ProjectRow, by: repo.MemberRow };

/// Only an admin of the owning org manages grants, and only with a fresh step-up.
fn grantTarget(db: sqlite.Db, ctx: guard.Ctx, project_id: []const u8) Error!GrantTarget {
    const project = try repo.projectById(db, ctx.arena, project_id) orelse return error.NotFound;
    const acting = try access.projectMember(db, ctx.arena, ctx.actor.user_id, project.id) orelse return error.NotFound;
    if (!std.mem.eql(u8, acting.member.orgId, project.orgId) or !acting.member.role.atLeast(.admin)) return error.Forbidden;
    try needStepUp(ctx);
    return .{ .project = project, .by = acting.member };
}

pub fn grant(db: sqlite.Db, a: Args(body_mod.Grant)) Error!Ok {
    const target = try grantTarget(db, a.ctx, a.id);
    const b = try bodyOf(body_mod.Grant, a);
    if (std.mem.eql(u8, b.org_id, target.project.orgId) or try repo.orgById(db, a.ctx.arena, b.org_id) == null) return error.InvalidOrg;
    try repo.grantProject(db, a.ctx.io, target.project.id, b.org_id, b.permission, target.by.id);
    return .{};
}

pub fn revoke(db: sqlite.Db, a: Args(body_mod.Revoke)) Error!Ok {
    const target = try grantTarget(db, a.ctx, a.id);
    const b = try bodyOf(body_mod.Revoke, a);
    try repo.revokeGrant(db, target.project.id, b.org_id);
    return .{};
}

// ---- positions ----

/// A position may only point at a team and a member of its own org.
fn foreignRef(db: sqlite.Db, ctx: guard.Ctx, org_id: []const u8, team_id: ?[]const u8, member_id: ?[]const u8) Error!bool {
    if (team_id) |id| if (try guard.teamOf(db, ctx, org_id, id) == null) return true;
    if (member_id) |id| if (try guard.memberInOrg(db, ctx, org_id, id) == null) return true;
    return false;
}

fn setValue(field: repo.Opt([]const u8)) ?[]const u8 {
    return switch (field) {
        .set => |text| text,
        else => null,
    };
}

/// `body[key] !== undefined && body[key] !== current[key]` for a nullable id.
fn idChanged(field: repo.Opt([]const u8), current: ?[]const u8) bool {
    return switch (field) {
        .unset => false,
        .clear => current != null,
        .set => |text| current == null or !std.mem.eql(u8, text, current.?),
    };
}

pub fn createPosition(db: sqlite.Db, a: Args(body_mod.Position)) Error!repo.PositionRow {
    const c = try resolveOrg(db, a.ctx, a.slug, .admin);
    const b = try bodyOf(body_mod.Position, a);
    if (try foreignRef(db, a.ctx, c.org.id, b.team_id, b.member_id)) return error.TeamOrMemberNotInOrg;
    // A new reporting edge widens a manager's authority just like the flag does.
    if ((b.is_manager orelse false) or (b.member_id != null and b.reports_to != null)) try needStepUp(a.ctx);
    return repo.createPosition(db, a.ctx.io, a.ctx.arena, .{
        .org_id = c.org.id,
        .title = b.title,
        .team_id = b.team_id,
        .member_id = b.member_id,
        .reports_to = b.reports_to,
        .is_manager = b.is_manager orelse false,
    });
}

pub fn patchPosition(db: sqlite.Db, a: Args(repo.PositionPatch)) Error!repo.PositionRow {
    const c = try resolveOrg(db, a.ctx, a.slug, .admin);
    const cur = for (try repo.positions(db, a.ctx.arena, c.org.id)) |p| {
        if (std.mem.eql(u8, p.id, a.id)) break p;
    } else return error.NotFound;
    const b = try bodyOf(repo.PositionPatch, a);
    if (try foreignRef(db, a.ctx, c.org.id, setValue(b.team_id), setValue(b.member_id))) return error.TeamOrMemberNotInOrg;
    // Manager authority comes from the flag, the holder and the reporting line, so all three count.
    const flag_changed = if (b.is_manager) |flag| flag != cur.isManager else false;
    if (flag_changed or idChanged(b.member_id, cur.memberId) or idChanged(b.reports_to, cur.reportsTo)) try needStepUp(a.ctx);
    return repo.updatePosition(db, a.ctx.arena, cur.id, b);
}
