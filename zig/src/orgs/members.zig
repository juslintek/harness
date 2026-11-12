//! The member operations of routes-members.ts: invite a human, add an agent, change a role or
//! other fields, remove. The ownership rules are the security-critical part: only an owner hands
//! out or takes away ownership, an org never ends up with none, and promoting or removing an
//! admin needs a fresh step-up.
const std = @import("std");
const body_mod = @import("body.zig");
const codes = @import("../auth/codes.zig");
const guard = @import("guard.zig");
const repo = @import("repo.zig");
const sqlite = @import("../db/sqlite.zig");

const Args = guard.Args;
const Error = guard.Error;
const bodyOf = guard.bodyOf;
const needStepUp = guard.needStepUp;
const resolveOrg = guard.resolveOrg;

const enrollment_ttl_ms: i64 = 24 * 60 * 60 * 1000;
const base32 = "abcdefghijklmnopqrstuvwxyz234567";

/// Four groups of four base32 symbols; 32 symbols divide 256 evenly, so masking has no bias.
fn enrollmentCode(io: std.Io) error{EntropyUnavailable}!codes.EnrollmentCode {
    var bytes: [codes.enrollment_groups * 4]u8 = undefined;
    io.randomSecure(&bytes) catch return error.EntropyUnavailable;
    var out: codes.EnrollmentCode = undefined;
    for (0..codes.enrollment_groups) |group| {
        for (0..4) |i| out[group * 5 + i] = base32[bytes[group * 4 + i] & 31];
        if (group + 1 < codes.enrollment_groups) out[group * 5 + 4] = '-';
    }
    return out;
}

/// The members of an org holding the owner role, `lastOwner` of TS.
fn lastOwner(db: sqlite.Db, ctx: guard.Ctx, org_id: []const u8) Error!bool {
    var owners: usize = 0;
    for (try repo.members(db, ctx.arena, org_id)) |m| owners += @intFromBool(m.role == .owner);
    return owners <= 1;
}

/// Owners are the only ones who can hand out or take away ownership; an org never ends up with
/// none. `next` is null when the member is being removed.
fn ownershipGuard(db: sqlite.Db, ctx: guard.Ctx, c: guard.OrgCtx, target: repo.MemberRow, next: ?repo.Role) Error!void {
    const touches_owner = target.role == .owner or next == repo.Role.owner;
    if (touches_owner and c.member.role != .owner) return error.Forbidden;
    if (target.role == .owner and next != repo.Role.owner and try lastOwner(db, ctx, c.org.id)) return error.LastOwner;
}

fn roleChangeGuard(db: sqlite.Db, ctx: guard.Ctx, c: guard.OrgCtx, target: repo.MemberRow, role: repo.Role) Error!void {
    if (role == target.role) return;
    try ownershipGuard(db, ctx, c, target, role);
    try needStepUp(ctx);
    if (target.kind == .agent and role.atLeast(.admin)) return error.AgentsCannotBeAdmins;
}

const Target = struct { ctx: guard.OrgCtx, member: repo.MemberRow };

fn memberTarget(db: sqlite.Db, ctx: guard.Ctx, slug: []const u8, member_id: []const u8) Error!Target {
    const c = try resolveOrg(db, ctx, slug, .admin);
    const member = try guard.memberInOrg(db, ctx, c.org.id, member_id) orelse return error.NotFound;
    return .{ .ctx = c, .member = member };
}

// ---- invite a human ----

pub const Fresh = struct { member: repo.MemberRow, enrollmentLink: []const u8 };
pub const Existing = struct { member: repo.MemberRow, enrollmentLink: ?[]const u8 = null };
pub const Pending = struct { member: repo.MemberRow, enrollmentLink: ?[]const u8 = null, pendingEnrollment: bool = true };
pub const Invited = union(enum) { fresh: Fresh, existing: Existing, pending: Pending };

fn hasPasskey(db: sqlite.Db, user_id: []const u8) Error!bool {
    return codes.exists(db, "SELECT 1 FROM passkeys WHERE user_id = ?", &.{.{ .text = user_id }});
}

/// Only a brand-new address gets an enrollment link back: handing one out for an existing user
/// would let any org admin take over that account. An existing user is just added; reissuing
/// their link is the instance admin's CLI.
pub fn addHuman(db: sqlite.Db, a: Args(body_mod.AddHuman)) Error!Invited {
    const ctx = a.ctx;
    const c = try resolveOrg(db, ctx, a.slug, .admin);
    const b = try bodyOf(body_mod.AddHuman, a);
    if (b.role == .owner and c.member.role != .owner) return error.Forbidden;
    if (b.role.atLeast(.admin)) try needStepUp(ctx);

    const existing = try codes.userByEmail(db, ctx.arena, b.email);
    const local = b.email[0 .. std.mem.findScalar(u8, b.email, '@') orelse b.email.len];
    const name = if (existing) |user| user.name else b.name orelse local;
    const user_id = if (existing) |user| user.id else try ctx.arena.dupe(u8, &try codes.insertUser(db, ctx.io, .{ .email = b.email, .name = name, .instance_admin = false }));
    const handle = b.handle orelse try repo.handleFromEmail(ctx.arena, b.email);
    const member = try repo.addHuman(db, ctx.io, ctx.arena, c.org.id, .{ .user_id = user_id, .handle = handle, .display_name = name, .role = b.role });
    if (existing != null) {
        return if (try hasPasskey(db, user_id)) .{ .existing = .{ .member = member } } else .{ .pending = .{ .member = member } };
    }
    const code = try enrollmentCode(ctx.io);
    try codes.insertEnrollment(db, .{ .opts = .{ .user_id = user_id, .email = b.email, .ttl_ms = enrollment_ttl_ms }, .code = code, .now = ctx.now });
    return .{ .fresh = .{ .member = member, .enrollmentLink = try std.fmt.allocPrint(ctx.arena, "{s}/#/enroll/{s}", .{ ctx.origin, code }) } };
}

// ---- add an agent ----

pub fn addAgent(db: sqlite.Db, a: Args(body_mod.AddAgent)) Error!repo.MemberRow {
    const ctx = a.ctx;
    const c = try resolveOrg(db, ctx, a.slug, .admin);
    // An agent member runs on this host with the instance's agent logins, so only the instance
    // admin may create one; org admins then manage its schedule and wakes.
    if (!ctx.actor.instance_admin) return error.Forbidden;
    try needStepUp(ctx);
    const b = try bodyOf(body_mod.AddAgent, a);
    if (!a.agent_known) return error.UnknownAgent;
    return repo.addAgent(db, ctx.io, ctx.arena, c.org.id, .{
        .agent_id = b.agent_id,
        .handle = b.handle,
        .display_name = b.display_name,
        .model = b.model,
        .specialties = b.specialties orelse &.{},
        .heartbeat_minutes = b.heartbeat_minutes,
    });
}

// ---- change and remove ----

pub fn patch(db: sqlite.Db, a: Args(repo.MemberPatch)) Error!repo.MemberRow {
    const t = try memberTarget(db, a.ctx, a.slug, a.id);
    const b = try bodyOf(repo.MemberPatch, a);
    if (b.role) |role| try roleChangeGuard(db, a.ctx, t.ctx, t.member, role);
    return repo.updateMember(db, a.ctx.arena, t.member.id, b);
}

pub fn remove(db: sqlite.Db, a: Args(guard.Empty)) Error!guard.Ok {
    const t = try memberTarget(db, a.ctx, a.slug, a.id);
    if (t.member.role == .owner) try ownershipGuard(db, a.ctx, t.ctx, t.member, null);
    if (t.member.role.atLeast(.admin)) try needStepUp(a.ctx);
    try repo.removeMember(db, t.member.id);
    return .{};
}
