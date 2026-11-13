const std = @import("std");
const codes = @import("../auth/codes.zig");
const Fixture = @import("../auth/fixture.zig").Fixture;
const access = @import("access.zig");
const repo = @import("repo.zig");

const testing = std.testing;

const Env = struct {
    fx: *Fixture,
    arena: std.heap.ArenaAllocator,

    fn create() !Env {
        return .{ .fx = try Fixture.create(testing.allocator, testing.io), .arena = .init(testing.allocator) };
    }

    fn destroy(self: *Env) void {
        self.arena.deinit();
        self.fx.destroy();
    }

    fn org(self: *Env, slug: []const u8, owner: []const u8) !repo.OrgView {
        try self.fx.addUser(owner, false);
        return repo.createOrg(self.fx.db, testing.io, self.arena.allocator(), .{
            .name = slug,
            .slug = slug,
            .owner_user_id = owner,
            .owner_name = "Owner",
            .owner_handle = owner,
        });
    }

    fn human(self: *Env, org_id: []const u8, user: []const u8, role: repo.Role) !repo.MemberRow {
        try self.fx.addUser(user, false);
        return repo.addHuman(self.fx.db, testing.io, self.arena.allocator(), org_id, .{ .user_id = user, .handle = user, .display_name = user, .role = role });
    }
};

test "orgs: createOrg makes the Core team and an owner member" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const org = try env.org("acme", "alice");
    try testing.expectEqualStrings("acme", org.slug);

    const teams = try repo.teams(env.fx.db, a, org.id);
    try testing.expectEqual(@as(usize, 1), teams.len);
    try testing.expectEqualStrings("Core", teams[0].name);
    const members = try repo.members(env.fx.db, a, org.id);
    try testing.expectEqual(@as(usize, 1), members.len);
    try testing.expectEqual(repo.Role.owner, members[0].role);
    try testing.expectEqual(repo.Kind.human, members[0].kind);
    try testing.expectEqualStrings("alice", members[0].userId.?);
    try testing.expectEqual(@as(usize, 0), members[0].specialties.len);
    try testing.expect(!members[0].paused);

    const mine = try repo.orgsForUser(env.fx.db, a, "alice");
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqual(@as(usize, 0), (try repo.orgsForUser(env.fx.db, a, "nobody")).len);
}

test "orgs: a duplicate slug is a constraint failure and a bad slug is refused" {
    var env = try Env.create();
    defer env.destroy();
    _ = try env.org("acme", "alice");
    try env.fx.addUser("bob", false);
    const dup: repo.NewOrg = .{ .name = "Other", .slug = "acme", .owner_user_id = "bob", .owner_name = "Bob", .owner_handle = "bob" };
    try testing.expectError(error.Constraint, repo.createOrg(env.fx.db, testing.io, env.arena.allocator(), dup));
    var bad = dup;
    bad.slug = "A";
    try testing.expectError(error.Invalid, repo.createOrg(env.fx.db, testing.io, env.arena.allocator(), bad));
}

test "orgs: handles follow the slug pattern" {
    try testing.expect(repo.isHandle("ab"));
    try testing.expect(repo.isHandle("a_b-9"));
    try testing.expect(!repo.isHandle("a"));
    try testing.expect(!repo.isHandle("-ab"));
    try testing.expect(!repo.isHandle("Ab"));
    try testing.expect(!repo.isHandle("ab\n"));
    try testing.expect(repo.isHandle(&@as([32]u8, @splat('a'))));
    try testing.expect(!repo.isHandle(&@as([33]u8, @splat('a'))));
}

test "orgs: handleFromEmail sanitises the local part" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_]struct { []const u8, []const u8 }{
        .{ "Alice.Smith@example.com", "alice-smith" },
        .{ "a@example.com", "user" },
        .{ "__x__y@example.com", "x__y" },
        .{ "ab+tag@example.com", "ab-tag" },
        .{ "a..b@x.io", "a-b" },
        .{ "ŠŠ@x.io", "user" },
        .{ "plain", "plain" },
        .{ "abcdefghijklmnopqrstuvwxyz0123456789@x.io", "abcdefghijklmnopqrstuvwxyz012345" },
    };
    for (cases) |case| {
        try testing.expectEqualStrings(case[1], try repo.handleFromEmail(arena.allocator(), case[0]));
    }
    // KELVIN SIGN lowercases to k in JS, so "kk" is a valid two-letter handle.
    try testing.expectEqualStrings("kk", try repo.handleFromEmail(arena.allocator(), "\u{212a}k@x.io"));
}

test "orgs: personal org hook is idempotent and avoids a taken slug" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    try env.fx.addUser("0190aaaa-1111-7222-8333-ABCDEF123456", false);
    try env.fx.addUser("0190bbbb-1111-7222-8333-abcdef654321", false);
    const first = (try codes.userById(env.fx.db, a, "0190aaaa-1111-7222-8333-ABCDEF123456")).?;
    const second = (try codes.userById(env.fx.db, a, "0190bbbb-1111-7222-8333-abcdef654321")).?;

    try repo.personalOrgHook(env.fx.db, testing.io, testing.allocator, first);
    try repo.personalOrgHook(env.fx.db, testing.io, testing.allocator, first);
    const mine = try repo.orgsForUser(env.fx.db, a, first.id);
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqualStrings("personal", mine[0].slug);
    try testing.expectEqualStrings("Personal", mine[0].name);
    const owner = (try repo.members(env.fx.db, a, mine[0].id))[0];
    try testing.expectEqualStrings("Test", owner.displayName);

    try repo.personalOrgHook(env.fx.db, testing.io, testing.allocator, second);
    const theirs = try repo.orgsForUser(env.fx.db, a, second.id);
    try testing.expectEqualStrings("personal-ef654321", theirs[0].slug);
}

test "orgs: member updates keep unset fields and clear on null" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const org = try env.org("acme", "alice");
    const agent = try repo.addAgent(env.fx.db, testing.io, a, org.id, .{
        .agent_id = "claude",
        .handle = "bot",
        .display_name = "Bot",
        .model = "opus",
        .specialties = &.{ "a", "b" },
        .heartbeat_minutes = 5,
    });
    try testing.expectEqual(repo.Kind.agent, agent.kind);
    try testing.expectEqual(repo.Role.member, agent.role);
    try testing.expectEqual(@as(?i64, 5), agent.heartbeatMinutes);

    const next = try repo.updateMember(env.fx.db, a, agent.id, .{ .model = .clear, .paused = true, .role = .viewer });
    try testing.expect(next.model == null);
    try testing.expect(next.paused);
    try testing.expectEqual(repo.Role.viewer, next.role);
    try testing.expectEqual(@as(?i64, 5), next.heartbeatMinutes);
    try testing.expectEqual(@as(usize, 2), next.specialties.len);
    try testing.expectEqualStrings("Bot", next.displayName);

    // The table allows agents only the member and viewer roles.
    try testing.expectError(error.Constraint, repo.updateMember(env.fx.db, a, agent.id, .{ .role = .admin }));
}

test "orgs: removing a member frees their position and a second owner is a separate row" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const org = try env.org("acme", "alice");
    const bob = try env.human(org.id, "bob", .member);
    const pos = try repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "Dev", .member_id = bob.id });
    try testing.expectEqualStrings(bob.id, pos.memberId.?);
    try repo.removeMember(env.fx.db, bob.id);
    const after = (try repo.positionById(env.fx.db, a, pos.id)).?;
    try testing.expect(after.memberId == null);
    try testing.expect((try repo.memberById(env.fx.db, a, bob.id)) == null);
}

test "orgs: positions refuse a foreign or cyclic reports_to" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const org = try env.org("acme", "alice");
    const other = try env.org("other", "carol");
    const boss = try repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "Boss", .is_manager = true });
    const dev = try repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "Dev", .reports_to = boss.id });
    const foreign = try repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = other.id, .title = "X" });

    try testing.expectError(error.ReportsToForeign, repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "Y", .reports_to = foreign.id }));
    try testing.expectError(error.ReportsToForeign, repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "Y", .reports_to = "ghost" }));
    try testing.expectError(error.ReportsToCycle, repo.updatePosition(env.fx.db, a, boss.id, .{ .reports_to = .{ .set = dev.id } }));
    try testing.expectError(error.ReportsToCycle, repo.updatePosition(env.fx.db, a, boss.id, .{ .reports_to = .{ .set = boss.id } }));

    const moved = try repo.updatePosition(env.fx.db, a, dev.id, .{ .reports_to = .clear, .title = "Engineer", .is_manager = true });
    try testing.expect(moved.reportsTo == null);
    try testing.expectEqualStrings("Engineer", moved.title);
    try testing.expect(moved.isManager);
}

test "orgs: project access for the owning org, a grantee and a stranger" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const home = try env.org("home", "alice");
    const guest = try env.org("guest", "gina");
    _ = try env.human(home.id, "vera", .viewer);
    _ = try env.human(home.id, "mia", .member);
    _ = try env.human(guest.id, "ada", .admin);
    try env.fx.addUser("sam", false);
    const project = try repo.createProject(env.fx.db, testing.io, a, .{ .org_id = home.id, .key = "APP", .name = "App", .repo = null, .team_id = null });
    const db = env.fx.db;

    try testing.expectEqual(access.Access.admin, try access.projectAccess(db, a, .{ .user = "alice" }, project.id));
    try testing.expectEqual(access.Access.read, try access.projectAccess(db, a, .{ .user = "vera" }, project.id));
    try testing.expectEqual(access.Access.write, try access.projectAccess(db, a, .{ .user = "mia" }, project.id));
    try testing.expectEqual(access.Access.none, try access.projectAccess(db, a, .{ .user = "gina" }, project.id));
    try testing.expectEqual(access.Access.none, try access.projectAccess(db, a, .{ .user = "sam" }, project.id));
    try testing.expectEqual(access.Access.none, try access.projectAccess(db, a, .{ .user = "alice" }, "ghost"));

    const owner = (try repo.memberForUser(db, a, home.id, "alice")).?;
    try repo.grantProject(db, testing.io, project.id, guest.id, .write, owner.id);
    // A grant is capped by the role in the grantee org: ada is admin there but gets write.
    try testing.expectEqual(access.Access.write, try access.projectAccess(db, a, .{ .user = "ada" }, project.id));
    try testing.expectEqual(access.Access.write, try access.projectAccess(db, a, .{ .user = "gina" }, project.id));
    // A grant is replaced in place, not duplicated.
    try repo.grantProject(db, testing.io, project.id, guest.id, .read, owner.id);
    try testing.expectEqual(access.Access.read, try access.projectAccess(db, a, .{ .user = "gina" }, project.id));
    const best = (try access.projectMember(db, a, "gina", project.id)).?;
    try testing.expectEqualStrings(guest.id, best.member.orgId);
    try testing.expect((try access.projectMember(db, a, "sam", project.id)) == null);

    try testing.expectEqual(@as(usize, 1), (try repo.projects(db, a, guest.id)).len);
    try repo.revokeGrant(db, project.id, guest.id);
    try testing.expectEqual(@as(usize, 0), (try repo.projects(db, a, guest.id)).len);
    try testing.expectEqual(access.Access.none, try access.projectAccess(db, a, .{ .user = "gina" }, project.id));

    try testing.expectError(error.Constraint, repo.createProject(db, testing.io, a, .{ .org_id = home.id, .key = "APP", .name = "Again", .repo = null, .team_id = null }));
}

test "orgs: a person in two orgs acts with the membership that gives most access" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const home = try env.org("home", "alice");
    const guest = try env.org("guest", "gina");
    const gina_home = try repo.addHuman(env.fx.db, testing.io, a, home.id, .{ .user_id = "gina", .handle = "gina", .display_name = "Gina", .role = .member });
    const project = try repo.createProject(env.fx.db, testing.io, a, .{ .org_id = home.id, .key = "APP", .name = "App", .repo = null, .team_id = null });
    const owner = (try repo.memberForUser(env.fx.db, a, home.id, "alice")).?;
    try repo.grantProject(env.fx.db, testing.io, project.id, guest.id, .read, owner.id);
    const best = (try access.projectMember(env.fx.db, a, "gina", project.id)).?;
    try testing.expectEqualStrings(gina_home.id, best.member.id);
    try testing.expectEqual(access.Access.write, best.access);
}

test "orgs: a reporting chain longer than the old walk cap still refuses a cycle" {
    var env = try Env.create();
    defer env.destroy();
    const a = env.arena.allocator();
    const org = try env.org("acme", "alice");
    const first = try repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "P0" });
    var last = first;
    for (0..1100) |_| last = try repo.createPosition(env.fx.db, testing.io, a, .{ .org_id = org.id, .title = "Pn", .reports_to = last.id });
    try testing.expectError(error.ReportsToCycle, repo.updatePosition(env.fx.db, a, first.id, .{ .reports_to = .{ .set = last.id } }));
}
