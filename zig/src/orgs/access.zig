//! Who can do what with an org or a project, a port of orgs/roles.ts.
const std = @import("std");
const codes = @import("../auth/codes.zig");
const sqlite = @import("../db/sqlite.zig");
const repo = @import("repo.zig");

const Allocator = std.mem.Allocator;
const Role = repo.Role;

pub const Access = enum(u8) { none, read, write, admin };

/// Whose memberships count: every membership of a user, or the one of a single member.
pub const Who = union(enum) { user: []const u8, member: []const u8 };

fn byRole(role: Role) Access {
    return switch (role) {
        .viewer => .read,
        .member => .write,
        .admin, .owner => .admin,
    };
}

fn lower(a: Access, b: Access) Access {
    return if (@backingInt(a) <= @backingInt(b)) a else b;
}

fn grantedAccess(permission: []const u8) Access {
    return if (std.mem.eql(u8, permission, "write")) .write else .read;
}

/// `orgAccess`: the user's role in the org, null for a stranger.
pub fn orgAccess(db: sqlite.Db, arena: Allocator, user_id: []const u8, org_id: []const u8) repo.Error!?Role {
    const member = try repo.memberForUser(db, arena, org_id, user_id) orelse return null;
    return member.role;
}

const Seat = struct { member_id: []const u8, org_id: []const u8, role: Role };

fn seats(db: sqlite.Db, arena: Allocator, who: Who) repo.Error![]Seat {
    const sql, const key = switch (who) {
        .user => |id| .{ "SELECT id, org_id, role FROM members WHERE user_id = ?", id },
        .member => |id| .{ "SELECT id, org_id, role FROM members WHERE id = ?", id },
    };
    const stmt = try codes.prepared(db, sql, &.{.{ .text = key }});
    defer stmt.finalize();
    var list: std.ArrayList(Seat) = .empty;
    while (try stmt.step()) try list.append(arena, .{
        .member_id = try stmt.textAlloc(arena, 0) orelse return error.CorruptRow,
        .org_id = try stmt.textAlloc(arena, 1) orelse return error.CorruptRow,
        .role = std.meta.stringToEnum(Role, try stmt.textAlloc(arena, 2) orelse return error.CorruptRow) orelse return error.CorruptRow,
    });
    return list.items;
}

/// What one membership gives on a project: the role's access in the owning org, a grant capped by
/// the role everywhere else.
fn seatAccess(db: sqlite.Db, arena: Allocator, project: repo.ProjectRow, seat: Seat) repo.Error!Access {
    if (std.mem.eql(u8, seat.org_id, project.orgId)) return byRole(seat.role);
    const granted = try codes.prepared(db, "SELECT permission FROM grants WHERE project_id = ? AND org_id = ?", &.{ .{ .text = project.id }, .{ .text = seat.org_id } });
    defer granted.finalize();
    if (!try granted.step()) return .none;
    const permission = try granted.textAlloc(arena, 0) orelse return error.CorruptRow;
    return lower(grantedAccess(permission), byRole(seat.role));
}

/// `projectAccess`: the best access across all memberships; none for an unknown project.
pub fn projectAccess(db: sqlite.Db, arena: Allocator, who: Who, project_id: []const u8) repo.Error!Access {
    const project = try repo.projectById(db, arena, project_id) orelse return .none;
    var best: Access = .none;
    for (try seats(db, arena, who)) |seat| {
        const got = try seatAccess(db, arena, project, seat);
        if (@backingInt(got) > @backingInt(best)) best = got;
    }
    return best;
}

pub const ProjectMember = struct { member: repo.MemberRow, access: Access };

/// `projectMember`: a person can sit in several orgs; the membership with the most access to the
/// project acts for them, the first one on a tie.
pub fn projectMember(db: sqlite.Db, arena: Allocator, user_id: []const u8, project_id: []const u8) repo.Error!?ProjectMember {
    const project = try repo.projectById(db, arena, project_id) orelse return null;
    var best: ?Seat = null;
    var best_access: Access = .none;
    for (try seats(db, arena, .{ .user = user_id })) |seat| {
        const got = try seatAccess(db, arena, project, seat);
        if (@backingInt(got) > @backingInt(best_access)) {
            best = seat;
            best_access = got;
        }
    }
    const seat = best orelse return null;
    const member = try repo.memberById(db, arena, seat.member_id) orelse return null;
    return .{ .member = member, .access = best_access };
}
