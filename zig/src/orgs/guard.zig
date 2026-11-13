//! What every orgs operation shares: the caller, the org lookup with its 404 and 403 rules and
//! the step-up check. The operations run under the state lock and inside one transaction, so a
//! check and the write it guards cannot be separated by another request.
const std = @import("std");
const policy = @import("../http/policy.zig");
const sessions = @import("../auth/sessions.zig");
const sqlite = @import("../db/sqlite.zig");
const fail = @import("fail.zig");
const repo = @import("repo.zig");

const Allocator = std.mem.Allocator;
pub const Error = fail.Error;

pub const Ctx = struct {
    arena: Allocator,
    io: std.Io,
    actor: policy.Actor,
    now: i64,
    /// HARNESS_ORIGIN or `http://localhost:<port>`, for enrollment links.
    origin: []const u8 = "",
};

/// The parts of a request an operation may need. `body` is null when the request body did not
/// fit its schema: the operation reports that at the point TS parses it, after the checks before.
pub fn Args(comptime Body: type) type {
    return struct {
        ctx: Ctx,
        slug: []const u8 = "",
        id: []const u8 = "",
        body: ?Body = null,
        /// Stop after the checks, before anything is written (the git check sits between).
        dry: bool = false,
        /// The body's agent id names a configured agent.
        agent_known: bool = false,
    };
}

pub const Empty = struct {};

pub const OrgCtx = struct { org: repo.OrgView, member: repo.MemberRow };

pub fn needStepUp(ctx: Ctx) Error!void {
    if (!sessions.hasFreshStepUp(ctx.actor.step_up_at, ctx.now)) return error.StepUpRequired;
}

/// Strangers get 404 so slugs do not leak; a member below `min` gets 403.
pub fn resolveOrg(db: sqlite.Db, ctx: Ctx, slug: []const u8, min: repo.Role) Error!OrgCtx {
    const org = try repo.orgBySlug(db, ctx.arena, slug) orelse return error.NotFound;
    const member = try repo.memberForUser(db, ctx.arena, org.id, ctx.actor.user_id) orelse return error.NotFound;
    if (!member.role.atLeast(min)) return error.Forbidden;
    return .{ .org = org, .member = member };
}

pub fn bodyOf(comptime B: type, args: Args(B)) Error!B {
    return args.body orelse error.InvalidBody;
}

pub const Ok = struct { ok: bool = true };

/// The org's team with that id, `listTeams(...).find`.
pub fn teamOf(db: sqlite.Db, ctx: Ctx, org_id: []const u8, team_id: []const u8) Error!?repo.TeamRow {
    for (try repo.teams(db, ctx.arena, org_id)) |team| if (std.mem.eql(u8, team.id, team_id)) return team;
    return null;
}

/// `getMember(db, id)?.orgId === org.id`.
pub fn memberInOrg(db: sqlite.Db, ctx: Ctx, org_id: []const u8, member_id: []const u8) Error!?repo.MemberRow {
    const member = try repo.memberById(db, ctx.arena, member_id) orelse return null;
    return if (std.mem.eql(u8, member.orgId, org_id)) member else null;
}
