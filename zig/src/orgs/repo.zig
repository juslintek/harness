//! The orgs tables, a port of orgs/repo.ts, positions.ts and projects.ts. Every function takes the
//! database handle of a caller that holds the state lock; writes also expect the caller's
//! transaction, so a handler can check and write in one step. Strings are copied into `arena`.
//! The TS in-process hooks (onOrgCreated, onMemberRemoved, onMemberDemoted, onGrantChanged) feed
//! chat channels, approvals and the heartbeat and are not ported with this slice.
const std = @import("std");
const codes = @import("../auth/codes.zig");
const ids = @import("../ids.zig");
const parity = @import("../parity.zig");
const sqlite = @import("../db/sqlite.zig");

const Allocator = std.mem.Allocator;
const Param = codes.Param;
pub const Error = codes.Error || error{ NotFound, Invalid, ReportsToForeign, ReportsToCycle };

pub const Role = enum(u8) {
    viewer,
    member,
    admin,
    owner,

    pub fn atLeast(role: Role, min: Role) bool {
        return @backingInt(role) >= @backingInt(min);
    }
};

pub const Kind = enum { human, agent };
pub const Permission = enum { read, write };

/// A patch field of the JSON body: absent keeps the stored value, null clears it.
pub fn Opt(comptime T: type) type {
    return union(enum) { unset, clear, set: T };
}

pub const OrgView = struct { id: []const u8, slug: []const u8, name: []const u8, createdAt: i64 };

pub const MemberRow = struct {
    id: []const u8,
    orgId: []const u8,
    kind: Kind,
    userId: ?[]const u8,
    agentId: ?[]const u8,
    model: ?[]const u8,
    handle: []const u8,
    displayName: []const u8,
    role: Role,
    specialties: []const []const u8,
    heartbeatMinutes: ?i64,
    paused: bool,
    createdAt: i64,
};

pub const TeamRow = struct { id: []const u8, orgId: []const u8, name: []const u8, createdAt: i64 };

pub const PositionRow = struct {
    id: []const u8,
    orgId: []const u8,
    teamId: ?[]const u8,
    title: []const u8,
    memberId: ?[]const u8,
    reportsTo: ?[]const u8,
    isManager: bool,
    createdAt: i64,
};

pub const ProjectRow = struct {
    id: []const u8,
    orgId: []const u8,
    teamId: ?[]const u8,
    key: []const u8,
    name: []const u8,
    repo: ?[]const u8,
    createdAt: i64,
};

// ---- reading rows ----

fn str(stmt: sqlite.Stmt, arena: Allocator, column: c_int) Error![]const u8 {
    return try stmt.textAlloc(arena, column) orelse error.CorruptRow;
}

fn optStr(stmt: sqlite.Stmt, arena: Allocator, column: c_int) Error!?[]const u8 {
    return try stmt.textAlloc(arena, column);
}

fn optInt(stmt: sqlite.Stmt, column: c_int) ?i64 {
    return if (stmt.isNull(column)) null else stmt.int(column);
}

fn all(comptime T: type, db: sqlite.Db, arena: Allocator, sql: []const u8, params: []const Param, comptime read: anytype) Error![]T {
    const stmt = try codes.prepared(db, sql, params);
    defer stmt.finalize();
    var list: std.ArrayList(T) = .empty;
    while (try stmt.step()) try list.append(arena, try read(stmt, arena));
    return list.items;
}

fn first(comptime T: type, db: sqlite.Db, arena: Allocator, sql: []const u8, params: []const Param, comptime read: anytype) Error!?T {
    const stmt = try codes.prepared(db, sql, params);
    defer stmt.finalize();
    if (!try stmt.step()) return null;
    return try read(stmt, arena);
}

fn readOrg(stmt: sqlite.Stmt, arena: Allocator) Error!OrgView {
    return .{ .id = try str(stmt, arena, 0), .slug = try str(stmt, arena, 1), .name = try str(stmt, arena, 2), .createdAt = stmt.int(3) };
}

const member_columns = "id, org_id, kind, user_id, agent_id, model, handle, display_name, role, specialties, heartbeat_minutes, paused, created_at";

fn readMember(stmt: sqlite.Stmt, arena: Allocator) Error!MemberRow {
    const specialties = std.json.parseFromSliceLeaky([]const []const u8, arena, try str(stmt, arena, 9), .{}) catch return error.CorruptRow;
    return .{
        .id = try str(stmt, arena, 0),
        .orgId = try str(stmt, arena, 1),
        .kind = std.meta.stringToEnum(Kind, try str(stmt, arena, 2)) orelse return error.CorruptRow,
        .userId = try optStr(stmt, arena, 3),
        .agentId = try optStr(stmt, arena, 4),
        .model = try optStr(stmt, arena, 5),
        .handle = try str(stmt, arena, 6),
        .displayName = try str(stmt, arena, 7),
        .role = std.meta.stringToEnum(Role, try str(stmt, arena, 8)) orelse return error.CorruptRow,
        .specialties = specialties,
        .heartbeatMinutes = optInt(stmt, 10),
        .paused = stmt.int(11) == 1,
        .createdAt = stmt.int(12),
    };
}

fn readTeam(stmt: sqlite.Stmt, arena: Allocator) Error!TeamRow {
    return .{ .id = try str(stmt, arena, 0), .orgId = try str(stmt, arena, 1), .name = try str(stmt, arena, 2), .createdAt = stmt.int(3) };
}

const position_columns = "id, org_id, team_id, title, member_id, reports_to, is_manager, created_at";

fn readPosition(stmt: sqlite.Stmt, arena: Allocator) Error!PositionRow {
    return .{
        .id = try str(stmt, arena, 0),
        .orgId = try str(stmt, arena, 1),
        .teamId = try optStr(stmt, arena, 2),
        .title = try str(stmt, arena, 3),
        .memberId = try optStr(stmt, arena, 4),
        .reportsTo = try optStr(stmt, arena, 5),
        .isManager = stmt.int(6) == 1,
        .createdAt = stmt.int(7),
    };
}

const project_columns = "id, org_id, team_id, key, name, repo, created_at";

fn readProject(stmt: sqlite.Stmt, arena: Allocator) Error!ProjectRow {
    return .{
        .id = try str(stmt, arena, 0),
        .orgId = try str(stmt, arena, 1),
        .teamId = try optStr(stmt, arena, 2),
        .key = try str(stmt, arena, 3),
        .name = try str(stmt, arena, 4),
        .repo = try optStr(stmt, arena, 5),
        .createdAt = stmt.int(6),
    };
}

// ---- queries ----

pub fn orgsForUser(db: sqlite.Db, arena: Allocator, user_id: []const u8) Error![]OrgView {
    return all(OrgView, db, arena, "SELECT o.id, o.slug, o.name, o.created_at FROM orgs o JOIN members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at, o.id", &.{.{ .text = user_id }}, readOrg);
}

pub fn orgBySlug(db: sqlite.Db, arena: Allocator, slug: []const u8) Error!?OrgView {
    return first(OrgView, db, arena, "SELECT id, slug, name, created_at FROM orgs WHERE slug = ?", &.{.{ .text = slug }}, readOrg);
}

pub fn orgById(db: sqlite.Db, arena: Allocator, id: []const u8) Error!?OrgView {
    return first(OrgView, db, arena, "SELECT id, slug, name, created_at FROM orgs WHERE id = ?", &.{.{ .text = id }}, readOrg);
}

pub fn memberById(db: sqlite.Db, arena: Allocator, id: []const u8) Error!?MemberRow {
    return first(MemberRow, db, arena, "SELECT " ++ member_columns ++ " FROM members WHERE id = ?", &.{.{ .text = id }}, readMember);
}

pub fn memberForUser(db: sqlite.Db, arena: Allocator, org_id: []const u8, user_id: []const u8) Error!?MemberRow {
    return first(MemberRow, db, arena, "SELECT " ++ member_columns ++ " FROM members WHERE org_id = ? AND user_id = ?", &.{ .{ .text = org_id }, .{ .text = user_id } }, readMember);
}

pub fn members(db: sqlite.Db, arena: Allocator, org_id: []const u8) Error![]MemberRow {
    return all(MemberRow, db, arena, "SELECT " ++ member_columns ++ " FROM members WHERE org_id = ? ORDER BY created_at, id", &.{.{ .text = org_id }}, readMember);
}

pub fn teams(db: sqlite.Db, arena: Allocator, org_id: []const u8) Error![]TeamRow {
    return all(TeamRow, db, arena, "SELECT id, org_id, name, created_at FROM teams WHERE org_id = ? ORDER BY created_at, id", &.{.{ .text = org_id }}, readTeam);
}

pub fn positions(db: sqlite.Db, arena: Allocator, org_id: []const u8) Error![]PositionRow {
    return all(PositionRow, db, arena, "SELECT " ++ position_columns ++ " FROM positions WHERE org_id = ? ORDER BY created_at, id", &.{.{ .text = org_id }}, readPosition);
}

pub fn positionById(db: sqlite.Db, arena: Allocator, id: []const u8) Error!?PositionRow {
    return first(PositionRow, db, arena, "SELECT " ++ position_columns ++ " FROM positions WHERE id = ?", &.{.{ .text = id }}, readPosition);
}

pub fn projectById(db: sqlite.Db, arena: Allocator, id: []const u8) Error!?ProjectRow {
    return first(ProjectRow, db, arena, "SELECT " ++ project_columns ++ " FROM projects WHERE id = ?", &.{.{ .text = id }}, readProject);
}

/// The projects the org owns and the ones granted to it.
pub fn projects(db: sqlite.Db, arena: Allocator, org_id: []const u8) Error![]ProjectRow {
    return all(ProjectRow, db, arena,
        \\SELECT id, org_id, team_id, key, name, repo, created_at FROM projects WHERE org_id = ?
        \\ UNION SELECT p.id, p.org_id, p.team_id, p.key, p.name, p.repo, p.created_at
        \\ FROM projects p JOIN grants g ON g.project_id = p.id WHERE g.org_id = ?
        \\ ORDER BY created_at, id
    , &.{ .{ .text = org_id }, .{ .text = org_id } }, readProject);
}

pub fn ownedOrgNamed(db: sqlite.Db, user_id: []const u8, name: []const u8) Error!bool {
    return codes.exists(db, "SELECT 1 FROM orgs o JOIN members m ON m.org_id = o.id WHERE m.user_id = ? AND m.role = 'owner' AND o.name = ?", &.{ .{ .text = user_id }, .{ .text = name } });
}

// ---- handles ----

/// `handleSchema`: `^[a-z0-9][a-z0-9_-]{1,31}$`.
pub fn isHandle(text: []const u8) bool {
    if (text.len < 2 or text.len > 32) return false;
    for (text, 0..) |ch, i| {
        const lead = std.ascii.isLower(ch) or std.ascii.isDigit(ch);
        if (!lead and (i == 0 or (ch != '_' and ch != '-'))) return false;
    }
    return true;
}

/// `handleFromEmail`: the local part lowercased, every run of characters outside `[a-z0-9_-]`
/// becomes one dash, leading dashes and underscores go, 32 characters at most, "user" if under 2.
pub fn handleFromEmail(arena: Allocator, email: []const u8) Allocator.Error![]const u8 {
    const at = std.mem.findScalar(u8, email, '@') orelse email.len;
    const local = parity.jsLowerEmail(arena, email[0..at]) catch |err| switch (err) {
        error.InvalidUtf8 => return "user",
        error.OutOfMemory => return error.OutOfMemory,
    };
    var out: std.ArrayList(u8) = .empty;
    var in_run = false;
    for (local) |ch| {
        const keep = std.ascii.isLower(ch) or std.ascii.isDigit(ch) or ch == '_' or ch == '-';
        if (keep) {
            try out.append(arena, ch);
            in_run = false;
        } else if (!in_run) {
            try out.append(arena, '-');
            in_run = true;
        }
    }
    var start: usize = 0;
    while (start < out.items.len and !(std.ascii.isLower(out.items[start]) or std.ascii.isDigit(out.items[start]))) start += 1;
    const handle = out.items[start..@min(out.items.len, start + 32)];
    return if (handle.len >= 2) handle else "user";
}

// ---- writes ----

fn newId(arena: Allocator, io: std.Io) Allocator.Error![]const u8 {
    return arena.dupe(u8, &ids.uuidV7(io));
}

pub const NewOrg = struct { name: []const u8, slug: []const u8, owner_user_id: []const u8, owner_name: []const u8, owner_handle: []const u8 };

/// `createOrg`: the org, its "Core" team and the owner member. The caller's transaction makes the
/// three rows one step.
pub fn createOrg(db: sqlite.Db, io: std.Io, arena: Allocator, new: NewOrg) Error!OrgView {
    if (!isHandle(new.slug)) return error.Invalid;
    const id = try newId(arena, io);
    const now = ids.nowMs(io);
    try codes.execute(db, "INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)", &.{ .{ .text = id }, .{ .text = new.slug }, .{ .text = new.name }, .{ .int = now } });
    _ = try createTeam(db, io, arena, id, "Core");
    _ = try addHuman(db, io, arena, id, .{ .user_id = new.owner_user_id, .handle = new.owner_handle, .display_name = new.owner_name, .role = .owner });
    return .{ .id = id, .slug = new.slug, .name = new.name, .createdAt = now };
}

pub const NewHuman = struct { user_id: []const u8, handle: []const u8, display_name: []const u8, role: Role };

pub fn addHuman(db: sqlite.Db, io: std.Io, arena: Allocator, org_id: []const u8, new: NewHuman) Error!MemberRow {
    return insertMember(db, io, arena, org_id, .{
        .kind = .human,
        .user_id = new.user_id,
        .handle = new.handle,
        .display_name = new.display_name,
        .role = new.role,
    });
}

pub const NewAgent = struct {
    agent_id: []const u8,
    handle: []const u8,
    display_name: []const u8,
    model: ?[]const u8 = null,
    specialties: []const []const u8 = &.{},
    heartbeat_minutes: ?i64 = null,
};

pub fn addAgent(db: sqlite.Db, io: std.Io, arena: Allocator, org_id: []const u8, new: NewAgent) Error!MemberRow {
    return insertMember(db, io, arena, org_id, .{
        .kind = .agent,
        .agent_id = new.agent_id,
        .handle = new.handle,
        .display_name = new.display_name,
        .role = .member,
        .model = new.model,
        .specialties = new.specialties,
        .heartbeat_minutes = new.heartbeat_minutes,
    });
}

const MemberFields = struct {
    kind: Kind,
    user_id: ?[]const u8 = null,
    agent_id: ?[]const u8 = null,
    model: ?[]const u8 = null,
    handle: []const u8,
    display_name: []const u8,
    role: Role,
    specialties: []const []const u8 = &.{},
    heartbeat_minutes: ?i64 = null,
};

fn specialtiesJson(arena: Allocator, list: []const []const u8) Allocator.Error![]const u8 {
    var out: std.Io.Writer.Allocating = .init(arena);
    std.json.Stringify.value(list, .{}, &out.writer) catch return error.OutOfMemory;
    return out.written();
}

fn insertMember(db: sqlite.Db, io: std.Io, arena: Allocator, org_id: []const u8, f: MemberFields) Error!MemberRow {
    if (!isHandle(f.handle)) return error.Invalid;
    const id = try newId(arena, io);
    try codes.execute(db,
        \\INSERT INTO members (id, org_id, kind, user_id, agent_id, model, handle, display_name, role, specialties, heartbeat_minutes, created_at)
        \\ VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    , &.{
        .{ .text = id },
        .{ .text = org_id },
        .{ .text = @tagName(f.kind) },
        Param.opt(f.user_id),
        Param.opt(f.agent_id),
        Param.opt(f.model),
        .{ .text = f.handle },
        .{ .text = f.display_name },
        .{ .text = @tagName(f.role) },
        .{ .text = try specialtiesJson(arena, f.specialties) },
        if (f.heartbeat_minutes) |n| .{ .int = n } else .none,
        .{ .int = ids.nowMs(io) },
    });
    return (try memberById(db, arena, id)) orelse error.CorruptRow;
}

pub const MemberPatch = struct {
    display_name: ?[]const u8 = null,
    role: ?Role = null,
    model: Opt([]const u8) = .unset,
    specialties: ?[]const []const u8 = null,
    heartbeat_minutes: Opt(i64) = .unset,
    paused: ?bool = null,
};

fn optText(field: Opt([]const u8), current: ?[]const u8) Param {
    return switch (field) {
        .unset => Param.opt(current),
        .clear => .none,
        .set => |text| .{ .text = text },
    };
}

/// `updateMember`: the stored row with the patch laid over it.
pub fn updateMember(db: sqlite.Db, arena: Allocator, id: []const u8, patch: MemberPatch) Error!MemberRow {
    const cur = (try memberById(db, arena, id)) orelse return error.NotFound;
    const heartbeat: Param = switch (patch.heartbeat_minutes) {
        .unset => if (cur.heartbeatMinutes) |n| .{ .int = n } else .none,
        .clear => .none,
        .set => |n| .{ .int = n },
    };
    try codes.execute(db, "UPDATE members SET display_name = ?, role = ?, model = ?, specialties = ?, heartbeat_minutes = ?, paused = ? WHERE id = ?", &.{
        .{ .text = patch.display_name orelse cur.displayName },
        .{ .text = @tagName(patch.role orelse cur.role) },
        optText(patch.model, cur.model),
        .{ .text = try specialtiesJson(arena, patch.specialties orelse cur.specialties) },
        heartbeat,
        .{ .int = @intFromBool(patch.paused orelse cur.paused) },
        .{ .text = id },
    });
    return (try memberById(db, arena, id)) orelse error.CorruptRow;
}

pub fn removeMember(db: sqlite.Db, id: []const u8) Error!void {
    try codes.execute(db, "DELETE FROM members WHERE id = ?", &.{.{ .text = id }});
}

pub fn createTeam(db: sqlite.Db, io: std.Io, arena: Allocator, org_id: []const u8, name: []const u8) Error!TeamRow {
    const id = try newId(arena, io);
    const now = ids.nowMs(io);
    try codes.execute(db, "INSERT INTO teams (id, org_id, name, created_at) VALUES (?, ?, ?, ?)", &.{ .{ .text = id }, .{ .text = org_id }, .{ .text = name }, .{ .int = now } });
    return .{ .id = id, .orgId = org_id, .name = name, .createdAt = now };
}

pub fn addToTeam(db: sqlite.Db, team_id: []const u8, member_id: []const u8) Error!void {
    try codes.execute(db, "INSERT OR IGNORE INTO team_members (team_id, member_id) VALUES (?, ?)", &.{ .{ .text = team_id }, .{ .text = member_id } });
}

// ---- positions ----

/// TS walks the chain without a limit. This only stops a walk over stored data that already loops,
/// and is far above any chain a person builds, so a long chain still finds the position it ends in.
const depth_cap = 1 << 20;

fn checkReportsTo(db: sqlite.Db, arena: Allocator, org_id: []const u8, self_id: []const u8, reports_to: ?[]const u8) Error!void {
    const target_id = reports_to orelse return;
    var at = (try positionById(db, arena, target_id)) orelse return error.ReportsToForeign;
    if (!std.mem.eql(u8, at.orgId, org_id)) return error.ReportsToForeign;
    for (0..depth_cap) |_| {
        if (std.mem.eql(u8, at.id, self_id)) return error.ReportsToCycle;
        at = (try positionById(db, arena, at.reportsTo orelse return)) orelse return;
    }
    return error.ReportsToCycle;
}

pub const NewPosition = struct {
    org_id: []const u8,
    title: []const u8,
    team_id: ?[]const u8 = null,
    member_id: ?[]const u8 = null,
    reports_to: ?[]const u8 = null,
    is_manager: bool = false,
};

pub fn createPosition(db: sqlite.Db, io: std.Io, arena: Allocator, new: NewPosition) Error!PositionRow {
    const id = try newId(arena, io);
    try checkReportsTo(db, arena, new.org_id, id, new.reports_to);
    try codes.execute(db, "INSERT INTO positions (id, org_id, team_id, title, member_id, reports_to, is_manager, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", &.{
        .{ .text = id },
        .{ .text = new.org_id },
        Param.opt(new.team_id),
        .{ .text = new.title },
        Param.opt(new.member_id),
        Param.opt(new.reports_to),
        .{ .int = @intFromBool(new.is_manager) },
        .{ .int = ids.nowMs(io) },
    });
    return (try positionById(db, arena, id)) orelse error.CorruptRow;
}

pub const PositionPatch = struct {
    title: ?[]const u8 = null,
    team_id: Opt([]const u8) = .unset,
    member_id: Opt([]const u8) = .unset,
    reports_to: Opt([]const u8) = .unset,
    is_manager: ?bool = null,
};

fn applied(field: Opt([]const u8), current: ?[]const u8) ?[]const u8 {
    return switch (field) {
        .unset => current,
        .clear => null,
        .set => |text| text,
    };
}

pub fn updatePosition(db: sqlite.Db, arena: Allocator, id: []const u8, patch: PositionPatch) Error!PositionRow {
    const cur = (try positionById(db, arena, id)) orelse return error.NotFound;
    const reports_to = applied(patch.reports_to, cur.reportsTo);
    try checkReportsTo(db, arena, cur.orgId, id, reports_to);
    try codes.execute(db, "UPDATE positions SET title = ?, team_id = ?, member_id = ?, reports_to = ?, is_manager = ? WHERE id = ?", &.{
        .{ .text = patch.title orelse cur.title },
        Param.opt(applied(patch.team_id, cur.teamId)),
        Param.opt(applied(patch.member_id, cur.memberId)),
        Param.opt(reports_to),
        .{ .int = @intFromBool(patch.is_manager orelse cur.isManager) },
        .{ .text = id },
    });
    return (try positionById(db, arena, id)) orelse error.CorruptRow;
}

// ---- projects and grants ----

pub const NewProject = struct { org_id: []const u8, team_id: ?[]const u8, key: []const u8, name: []const u8, repo: ?[]const u8 };

pub fn createProject(db: sqlite.Db, io: std.Io, arena: Allocator, new: NewProject) Error!ProjectRow {
    const id = try newId(arena, io);
    try codes.execute(db, "INSERT INTO projects (id, org_id, team_id, key, name, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", &.{
        .{ .text = id },
        .{ .text = new.org_id },
        Param.opt(new.team_id),
        .{ .text = new.key },
        .{ .text = new.name },
        Param.opt(new.repo),
        .{ .int = ids.nowMs(io) },
    });
    return (try projectById(db, arena, id)) orelse error.CorruptRow;
}

/// One grant per project and org: a second call replaces the permission and the granter.
pub fn grantProject(db: sqlite.Db, io: std.Io, project_id: []const u8, grantee_org_id: []const u8, permission: Permission, granted_by: []const u8) Error!void {
    const grant_id = ids.uuidV7(io);
    try codes.execute(db,
        \\INSERT INTO grants (id, project_id, org_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
        \\ ON CONFLICT (project_id, org_id) DO UPDATE SET permission = excluded.permission, granted_by = excluded.granted_by
    , &.{
        .{ .text = &grant_id },
        .{ .text = project_id },
        .{ .text = grantee_org_id },
        .{ .text = @tagName(permission) },
        .{ .text = granted_by },
        .{ .int = ids.nowMs(io) },
    });
}

pub fn revokeGrant(db: sqlite.Db, project_id: []const u8, grantee_org_id: []const u8) Error!void {
    try codes.execute(db, "DELETE FROM grants WHERE project_id = ? AND org_id = ?", &.{ .{ .text = project_id }, .{ .text = grantee_org_id } });
}

// ---- personal org ----

/// `ensurePersonalOrg`, installed as `codes.personal_org_hook`: runs inside the sign-in
/// transaction with the lock held, so a failure takes the sign-in back with it.
pub fn personalOrgHook(db: sqlite.Db, io: std.Io, alloc: Allocator, user: codes.User) codes.Error!void {
    return ensurePersonalOrg(db, io, alloc, user) catch |err| switch (err) {
        error.Invalid => error.Constraint,
        error.NotFound, error.ReportsToForeign, error.ReportsToCycle => error.CorruptRow,
        else => |other| other,
    };
}

fn ensurePersonalOrg(db: sqlite.Db, io: std.Io, alloc: Allocator, user: codes.User) Error!void {
    var arena: std.heap.ArenaAllocator = .init(alloc);
    defer arena.deinit();
    const a = arena.allocator();
    if (try ownedOrgNamed(db, user.id, "Personal")) return;
    const taken = try codes.exists(db, "SELECT 1 FROM orgs WHERE slug = 'personal'", &.{});
    const slug = if (taken) try personalSlug(a, user.id) else "personal";
    _ = try createOrg(db, io, a, .{
        .name = "Personal",
        .slug = slug,
        .owner_user_id = user.id,
        .owner_name = user.name,
        .owner_handle = try handleFromEmail(a, user.email),
    });
}

fn personalSlug(arena: Allocator, user_id: []const u8) Allocator.Error![]const u8 {
    const tail = user_id[user_id.len -| 8..];
    return std.fmt.allocPrint(arena, "personal-{s}", .{try std.ascii.allocLowerString(arena, tail)});
}

test {
    _ = @import("repo_test.zig");
    _ = @import("access.zig");
    _ = @import("body.zig");
}
