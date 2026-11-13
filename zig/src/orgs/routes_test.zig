const std = @import("std");
const httpz = @import("httpz");
const agents = @import("../agents/routes.zig");
const codes = @import("../auth/codes.zig");
const Fixture = @import("../auth/fixture.zig").Fixture;
const headers = @import("../http/headers.zig");
const ids = @import("../ids.zig");
const policy = @import("../http/policy.zig");
const repo = @import("repo.zig");
const routes = @import("../http/routes.zig");
const orgs = @import("routes.zig");

const testing = std.testing;

const origin = "http://localhost:4000";

const Request = struct {
    user: []const u8 = "alice",
    instance_admin: bool = false,
    stepped_up: bool = true,
    org: ?[]const u8 = null,
    id: ?[]const u8 = null,
    body: ?[]const u8 = null,
};

const Rig = struct {
    fx: *Fixture,
    arena: std.heap.ArenaAllocator,
    tmp: testing.TmpDir,
    home: []u8,
    env: std.process.Environ.Map,
    ctx: *agents.Ctx,
    services: routes.Services,

    fn create() !*Rig {
        const self = try testing.allocator.create(Rig);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, testing.io);
        errdefer self.fx.destroy();
        self.arena = .init(testing.allocator);
        errdefer self.arena.deinit();
        self.tmp = testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const real = buf[0..try self.tmp.dir.realPath(testing.io, &buf)];
        self.home = try std.fmt.allocPrint(testing.allocator, "{s}/home", .{real});
        errdefer testing.allocator.free(self.home);
        self.env = std.process.Environ.Map.init(testing.allocator);
        errdefer self.env.deinit();
        try self.env.put("HOME", "/home/alice");
        try self.env.put("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
        // A git hook exports this; the repo check must not let it point git elsewhere.
        try self.env.put("GIT_DIR", "/nonexistent/.git");
        self.ctx = try agents.Ctx.create(testing.allocator, testing.io, self.home, &self.env);
        errdefer self.ctx.destroy();
        self.services = .{ .app = &self.fx.app, .health = .{ .instance_id = @splat('a') }, .agents = self.ctx };
        return self;
    }

    fn destroy(self: *Rig) void {
        self.ctx.destroy();
        self.env.deinit();
        testing.allocator.free(self.home);
        self.tmp.cleanup();
        self.arena.deinit();
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn call(self: *Rig, handler: routes.HandlerFn, request: Request) !httpz.testing.Testing {
        var web = httpz.testing.init(.{});
        errdefer web.deinit();
        if (request.org) |slug| web.param("org", slug);
        if (request.id) |id| web.param("id", id);
        if (request.body) |body| web.body(body);
        const actor: policy.Actor = .{
            .instance_admin = request.instance_admin,
            .user_id = request.user,
            .step_up_at = if (request.stepped_up) ids.nowMs(testing.io) else null,
        };
        var routed: routes.Call = .{ .services = &self.services, .req = web.req, .res = web.res, .actor = actor, .origin = origin };
        handler(&routed) catch |err| {
            const mapped = headers.mapError(err);
            web.res.clearWriter();
            try headers.sendError(web.res, mapped.status, mapped.message);
        };
        return web;
    }

    /// Calls `handler` and checks the status and the whole body.
    fn expect(self: *Rig, handler: routes.HandlerFn, request: Request, status: u16, body: []const u8) !void {
        var web = try self.call(handler, request);
        defer web.deinit();
        try web.expectStatus(status);
        try web.expectBody(body);
    }

    /// Calls `handler`, checks the status and that the body contains every piece, and returns
    /// the body (owned by the rig's arena).
    fn expectHas(self: *Rig, handler: routes.HandlerFn, request: Request, status: u16, pieces: []const []const u8) ![]const u8 {
        var web = try self.call(handler, request);
        defer web.deinit();
        try web.expectStatus(status);
        const body = try self.arena.allocator().dupe(u8, try web.getBody());
        for (pieces) |piece| {
            if (std.mem.find(u8, body, piece) == null) {
                std.debug.print("missing {s} in {s}\n", .{ piece, body });
                return error.TestExpectedEqual;
            }
        }
        return body;
    }

    fn user(self: *Rig, id: []const u8) !void {
        try self.fx.addUser(id, false);
    }

    fn org(self: *Rig, slug: []const u8, owner: []const u8) !repo.OrgView {
        try self.user(owner);
        return repo.createOrg(self.fx.db, testing.io, self.arena.allocator(), .{ .name = slug, .slug = slug, .owner_user_id = owner, .owner_name = "Owner", .owner_handle = owner });
    }

    fn member(self: *Rig, org_id: []const u8, user_id: []const u8, role: repo.Role) !repo.MemberRow {
        try self.user(user_id);
        return repo.addHuman(self.fx.db, testing.io, self.arena.allocator(), org_id, .{ .user_id = user_id, .handle = user_id, .display_name = user_id, .role = role });
    }

    /// An org "acme" with one member per role: alice owner, adam admin, mia member, vera viewer.
    fn acme(self: *Rig) !repo.OrgView {
        const acme_org = try self.org("acme", "alice");
        _ = try self.member(acme_org.id, "adam", .admin);
        _ = try self.member(acme_org.id, "mia", .member);
        _ = try self.member(acme_org.id, "vera", .viewer);
        return acme_org;
    }
};

const not_found = "{\"error\":\"not_found\"}";
const forbidden = "{\"error\":\"forbidden\"}";
const step_up = "{\"error\":\"step_up_required\"}";
const invalid_body = "{\"error\":\"invalid body\"}";

test "orgs: creating an org makes Core and an owner, and the list and detail show it" {
    const rig = try Rig.create();
    defer rig.destroy();
    try rig.user("alice");

    const created = try rig.expectHas(orgs.create, .{ .body = "{\"name\":\" Acme \",\"slug\":\"acme\"}" }, 201, &.{"\"slug\":\"acme\",\"name\":\"Acme\",\"createdAt\":"});
    try testing.expect(std.mem.startsWith(u8, created, "{\"id\":\""));
    try rig.expect(orgs.create, .{ .body = "{\"name\":\"Other\",\"slug\":\"acme\"}" }, 409, "{\"error\":\"conflict\"}");
    try rig.expect(orgs.create, .{ .body = "{\"name\":\"Other\",\"slug\":\"other\",\"extra\":1}" }, 400, invalid_body);
    try rig.expect(orgs.create, .{ .body = "{\"name\":\"Other\",\"slug\":\"X\"}" }, 400, invalid_body);
    try rig.expect(orgs.create, .{ .user = "ghost", .body = "{\"name\":\"Other\",\"slug\":\"other\"}" }, 404, not_found);

    _ = try rig.expectHas(orgs.list, .{}, 200, &.{"\"name\":\"Acme\""});
    try rig.expect(orgs.list, .{ .user = "nobody" }, 200, "[]");
    const detail = try rig.expectHas(orgs.detail, .{ .org = "acme" }, 200, &.{
        "\"teams\":[{\"id\":\"",
        "\"name\":\"Core\"",
        "\"me\":{\"id\":\"",
        "\"kind\":\"human\",\"userId\":\"alice\",\"agentId\":null,\"model\":null,\"handle\":\"alice\",\"displayName\":\"Test\",\"role\":\"owner\",\"specialties\":[],\"heartbeatMinutes\":null,\"paused\":false,\"createdAt\":",
        "\"positions\":[],\"projects\":[]}",
    });
    try testing.expect(std.mem.startsWith(u8, detail, "{\"org\":{\"id\":\""));
}

test "orgs: a stranger gets 404 on every org route, never 403" {
    const rig = try Rig.create();
    defer rig.destroy();
    const acme_org = try rig.acme();
    _ = try rig.org("elsewhere", "eve");
    const bob = (try repo.members(rig.fx.db, rig.arena.allocator(), acme_org.id))[0];
    const project = try repo.createProject(rig.fx.db, testing.io, rig.arena.allocator(), .{ .org_id = acme_org.id, .team_id = null, .key = "APP", .name = "App", .repo = null });
    const by_eve: Request = .{ .user = "eve", .org = "acme", .id = bob.id, .body = "{}" };
    const handlers = [_]routes.HandlerFn{ orgs.detail, orgs.createTeam, orgs.addTeamMember, orgs.createProject, orgs.addHuman, orgs.addAgent, orgs.patchMember, orgs.removeMember, orgs.createPosition, orgs.patchPosition };
    for (handlers) |handler| try rig.expect(handler, by_eve, 404, not_found);
    for ([_]routes.HandlerFn{ orgs.grant, orgs.revoke }) |handler| {
        try rig.expect(handler, .{ .user = "eve", .id = project.id, .body = "{}" }, 404, not_found);
    }
    // An unknown org looks the same as someone else's.
    try rig.expect(orgs.detail, .{ .user = "eve", .org = "nope" }, 404, not_found);
}

test "orgs: members below admin cannot change the org, and the check comes before the body" {
    const rig = try Rig.create();
    defer rig.destroy();
    _ = try rig.acme();
    const team = "{\"name\":\"Ops\"}";
    for ([_][]const u8{ "mia", "vera" }) |who| {
        try rig.expect(orgs.createTeam, .{ .user = who, .org = "acme", .body = team }, 403, forbidden);
        try rig.expect(orgs.createTeam, .{ .user = who, .org = "acme", .body = "nonsense" }, 403, forbidden);
        try rig.expect(orgs.createPosition, .{ .user = who, .org = "acme", .body = "{\"title\":\"x\"}" }, 403, forbidden);
        try rig.expect(orgs.addHuman, .{ .user = who, .org = "acme", .body = "{\"email\":\"a@b.co\",\"role\":\"member\"}" }, 403, forbidden);
    }
    _ = try rig.expectHas(orgs.detail, .{ .user = "vera", .org = "acme" }, 200, &.{"\"role\":\"viewer\""});
    _ = try rig.expectHas(orgs.createTeam, .{ .user = "adam", .org = "acme", .body = team }, 201, &.{ "\"orgId\":\"", "\"name\":\"Ops\",\"createdAt\":" });
    try rig.expect(orgs.createTeam, .{ .user = "adam", .org = "acme", .body = team }, 409, "{\"error\":\"conflict\"}");
    try rig.expect(orgs.createTeam, .{ .user = "adam", .org = "acme", .body = "{\"name\":\"\"}" }, 400, invalid_body);
}

test "orgs: team members must belong to the org" {
    const rig = try Rig.create();
    defer rig.destroy();
    const acme_org = try rig.acme();
    const other = try rig.org("other", "olga");
    const a = rig.arena.allocator();
    const team = (try repo.teams(rig.fx.db, a, acme_org.id))[0];
    const mia = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "mia")).?;
    const olga = (try repo.memberForUser(rig.fx.db, a, other.id, "olga")).?;
    const add = try std.fmt.allocPrint(a, "{{\"memberId\":\"{s}\"}}", .{mia.id});
    try rig.expect(orgs.addTeamMember, .{ .org = "acme", .id = team.id, .body = add }, 200, "{\"ok\":true}");
    try rig.expect(orgs.addTeamMember, .{ .org = "acme", .id = team.id, .body = add }, 200, "{\"ok\":true}");
    const foreign = try std.fmt.allocPrint(a, "{{\"memberId\":\"{s}\"}}", .{olga.id});
    try rig.expect(orgs.addTeamMember, .{ .org = "acme", .id = team.id, .body = foreign }, 400, "{\"error\":\"member not in org\"}");
    try rig.expect(orgs.addTeamMember, .{ .org = "acme", .id = "nope", .body = add }, 404, not_found);
}

test "orgs: only an owner hands out or removes ownership and the last owner stays" {
    const rig = try Rig.create();
    defer rig.destroy();
    const acme_org = try rig.acme();
    const a = rig.arena.allocator();
    const alice = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "alice")).?;
    const mia = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "mia")).?;

    // An admin may change an owner's other fields, but not the role, and cannot remove an owner.
    _ = try rig.expectHas(orgs.patchMember, .{ .user = "adam", .org = "acme", .id = alice.id, .body = "{\"paused\":true}" }, 200, &.{"\"paused\":true"});
    try rig.expect(orgs.patchMember, .{ .user = "adam", .org = "acme", .id = alice.id, .body = "{\"role\":\"member\"}" }, 403, forbidden);
    try rig.expect(orgs.removeMember, .{ .user = "adam", .org = "acme", .id = alice.id }, 403, forbidden);
    const promote = try std.fmt.allocPrint(a, "{{\"role\":\"owner\"}}", .{});
    try rig.expect(orgs.patchMember, .{ .user = "adam", .org = "acme", .id = mia.id, .body = promote }, 403, forbidden);

    // The only owner can neither step down nor leave.
    try rig.expect(orgs.patchMember, .{ .org = "acme", .id = alice.id, .body = "{\"role\":\"admin\"}" }, 409, "{\"error\":\"last_owner\"}");
    try rig.expect(orgs.removeMember, .{ .org = "acme", .id = alice.id }, 409, "{\"error\":\"last_owner\"}");

    // With a second owner either may go.
    _ = try rig.expectHas(orgs.patchMember, .{ .org = "acme", .id = mia.id, .body = promote }, 200, &.{"\"role\":\"owner\""});
    _ = try rig.expectHas(orgs.patchMember, .{ .org = "acme", .id = alice.id, .body = "{\"role\":\"admin\"}" }, 200, &.{"\"role\":\"admin\""});
    try rig.expect(orgs.removeMember, .{ .user = "mia", .org = "acme", .id = alice.id }, 200, "{\"ok\":true}");
    try rig.expect(orgs.removeMember, .{ .user = "mia", .org = "acme", .id = alice.id }, 404, not_found);
}

test "orgs: admin-level role changes and removals need a fresh step-up" {
    const rig = try Rig.create();
    defer rig.destroy();
    const acme_org = try rig.acme();
    const a = rig.arena.allocator();
    const mia = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "mia")).?;
    const adam = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "adam")).?;
    const vera = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "vera")).?;

    try rig.expect(orgs.patchMember, .{ .stepped_up = false, .org = "acme", .id = mia.id, .body = "{\"role\":\"admin\"}" }, 403, step_up);
    // The same role again changes nothing, so it needs nothing.
    _ = try rig.expectHas(orgs.patchMember, .{ .stepped_up = false, .org = "acme", .id = mia.id, .body = "{\"role\":\"member\",\"displayName\":\"Mia\"}" }, 200, &.{"\"displayName\":\"Mia\""});
    try rig.expect(orgs.removeMember, .{ .stepped_up = false, .org = "acme", .id = adam.id }, 403, step_up);
    try rig.expect(orgs.removeMember, .{ .stepped_up = false, .org = "acme", .id = vera.id }, 200, "{\"ok\":true}");
    _ = try rig.expectHas(orgs.patchMember, .{ .org = "acme", .id = mia.id, .body = "{\"role\":\"admin\"}" }, 200, &.{"\"role\":\"admin\""});
}

test "orgs: inviting a human" {
    const rig = try Rig.create();
    defer rig.destroy();
    _ = try rig.acme();
    const invite = "{\"email\":\" New.Person+x@Example.com \",\"role\":\"member\"}";
    const fresh = try rig.expectHas(orgs.addHuman, .{ .org = "acme", .body = invite }, 201, &.{
        "\"userId\":\"",
        "\"handle\":\"new-person-x\",\"displayName\":\"new.person+x\",\"role\":\"member\"",
        "\"enrollmentLink\":\"" ++ origin ++ "/#/enroll/",
    });
    try testing.expect(std.mem.find(u8, fresh, "pendingEnrollment") == null);
    try rig.expect(orgs.addHuman, .{ .org = "acme", .body = invite }, 409, "{\"error\":\"conflict\"}");
    try rig.expect(orgs.addHuman, .{ .org = "acme", .body = "{\"email\":\"x@y.co\",\"role\":\"member\",\"handle\":\"mia\"}" }, 409, "{\"error\":\"conflict\"}");
    // The failed invite rolled its new user back.
    try testing.expect(!try codes.exists(rig.fx.db, "SELECT 1 FROM users WHERE email = 'x@y.co'", &.{}));

    // An existing user is only added, never handed a link; without a passkey the answer says pending.
    try rig.user("eli");
    _ = try rig.org("other", "olga");
    _ = try rig.expectHas(orgs.addHuman, .{ .user = "olga", .org = "other", .body = "{\"email\":\"eli@example.test\",\"role\":\"viewer\"}" }, 201, &.{
        "\"displayName\":\"Test\"",
        "\"enrollmentLink\":null,\"pendingEnrollment\":true}",
    });
    try rig.user("ivy");
    try rig.fx.run("INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('p1', 'ivy', x'00', 0, 'k', 1)");
    const with_key = try rig.expectHas(orgs.addHuman, .{ .org = "acme", .body = "{\"email\":\"ivy@example.test\",\"role\":\"viewer\"}" }, 201, &.{"\"enrollmentLink\":null}"});
    try testing.expect(std.mem.find(u8, with_key, "pendingEnrollment") == null);
}

test "orgs: owner and admin invites are guarded" {
    const rig = try Rig.create();
    defer rig.destroy();
    _ = try rig.acme();
    try rig.expect(orgs.addHuman, .{ .user = "adam", .org = "acme", .body = "{\"email\":\"o@x.co\",\"role\":\"owner\"}" }, 403, forbidden);
    try rig.expect(orgs.addHuman, .{ .stepped_up = false, .org = "acme", .body = "{\"email\":\"o@x.co\",\"role\":\"admin\"}" }, 403, step_up);
    _ = try rig.expectHas(orgs.addHuman, .{ .stepped_up = false, .org = "acme", .body = "{\"email\":\"o@x.co\",\"role\":\"member\"}" }, 201, &.{"\"enrollmentLink\":\""});
    _ = try rig.expectHas(orgs.addHuman, .{ .org = "acme", .body = "{\"email\":\"p@x.co\",\"role\":\"owner\",\"handle\":\"pat\"}" }, 201, &.{"\"role\":\"owner\""});
    try rig.expect(orgs.addHuman, .{ .org = "acme", .body = "{\"email\":\"bad\",\"role\":\"owner\"}" }, 400, invalid_body);
}

test "orgs: agent members are for the instance admin, with a step-up, a known agent and a valid body" {
    const rig = try Rig.create();
    defer rig.destroy();
    _ = try rig.acme();
    const known = rig.ctx.specs[0].id;
    const a = rig.arena.allocator();
    const body = try std.fmt.allocPrint(a, "{{\"agentId\":\"{s}\",\"handle\":\"bot\",\"displayName\":\"Bot\",\"specialties\":[\"a\"],\"heartbeatMinutes\":5}}", .{known});

    try rig.expect(orgs.addAgent, .{ .user = "adam", .org = "acme", .body = body }, 403, forbidden);
    try rig.expect(orgs.addAgent, .{ .user = "mia", .instance_admin = true, .org = "acme", .body = body }, 403, forbidden);
    try rig.expect(orgs.addAgent, .{ .instance_admin = true, .stepped_up = false, .org = "acme", .body = body }, 403, step_up);
    try rig.expect(orgs.addAgent, .{ .instance_admin = true, .org = "acme", .body = "{}" }, 400, invalid_body);
    try rig.expect(orgs.addAgent, .{ .instance_admin = true, .org = "acme", .body = "{\"agentId\":\"nope\",\"handle\":\"bot\",\"displayName\":\"Bot\"}" }, 400, "{\"error\":\"unknown agent\"}");
    const created = try rig.expectHas(orgs.addAgent, .{ .instance_admin = true, .org = "acme", .body = body }, 201, &.{
        "\"kind\":\"agent\",\"userId\":null,",
        "\"model\":null,\"handle\":\"bot\",\"displayName\":\"Bot\",\"role\":\"member\",\"specialties\":[\"a\"],\"heartbeatMinutes\":5,\"paused\":false",
    });
    try rig.expect(orgs.addAgent, .{ .instance_admin = true, .org = "acme", .body = body }, 409, "{\"error\":\"conflict\"}");

    // Agents never become admins, whoever asks.
    const id_start = std.mem.find(u8, created, "{\"id\":\"").? + 7;
    const agent_id = created[id_start .. id_start + 36];
    try rig.expect(orgs.patchMember, .{ .org = "acme", .id = agent_id, .body = "{\"role\":\"admin\"}" }, 400, "{\"error\":\"agents cannot be admins\"}");
    try rig.expect(orgs.patchMember, .{ .stepped_up = false, .org = "acme", .id = agent_id, .body = "{\"role\":\"admin\"}" }, 403, step_up);
    _ = try rig.expectHas(orgs.patchMember, .{ .org = "acme", .id = agent_id, .body = "{\"role\":\"viewer\",\"model\":\"m\",\"heartbeatMinutes\":null}" }, 200, &.{ "\"model\":\"m\"", "\"heartbeatMinutes\":null", "\"role\":\"viewer\"" });
}

test "orgs: positions guard their references and authority" {
    const rig = try Rig.create();
    defer rig.destroy();
    const acme_org = try rig.acme();
    const other = try rig.org("other", "olga");
    const a = rig.arena.allocator();
    const mia = (try repo.memberForUser(rig.fx.db, a, acme_org.id, "mia")).?;
    const olga = (try repo.memberForUser(rig.fx.db, a, other.id, "olga")).?;

    const plain = try rig.expectHas(orgs.createPosition, .{ .stepped_up = false, .org = "acme", .body = "{\"title\":\" Dev \"}" }, 201, &.{ "\"orgId\":\"", "\"teamId\":null,\"title\":\"Dev\",\"memberId\":null,\"reportsTo\":null,\"isManager\":false,\"createdAt\":" });
    const dev_id = plain[std.mem.find(u8, plain, "{\"id\":\"").? + 7 ..][0..36];
    try rig.expect(orgs.createPosition, .{ .stepped_up = false, .org = "acme", .body = "{\"title\":\"Boss\",\"isManager\":true}" }, 403, step_up);
    const edge = try std.fmt.allocPrint(a, "{{\"title\":\"X\",\"memberId\":\"{s}\",\"reportsTo\":\"{s}\"}}", .{ mia.id, dev_id });
    try rig.expect(orgs.createPosition, .{ .stepped_up = false, .org = "acme", .body = edge }, 403, step_up);
    _ = try rig.expectHas(orgs.createPosition, .{ .org = "acme", .body = edge }, 201, &.{"\"isManager\":false"});

    const foreign_member = try std.fmt.allocPrint(a, "{{\"title\":\"X\",\"memberId\":\"{s}\"}}", .{olga.id});
    try rig.expect(orgs.createPosition, .{ .org = "acme", .body = foreign_member }, 400, "{\"error\":\"team or member not in org\"}");
    try rig.expect(orgs.createPosition, .{ .org = "acme", .body = "{\"title\":\"X\",\"teamId\":\"ghost\"}" }, 400, "{\"error\":\"team or member not in org\"}");
    try rig.expect(orgs.createPosition, .{ .org = "acme", .body = "{\"title\":\"X\",\"reportsTo\":\"ghost\"}" }, 400, "{\"error\":\"reports_to must be a position in the same org\"}");

    // A patch needs a step-up only when the flag, the holder or the reporting line changes.
    const same = try std.fmt.allocPrint(a, "{{\"title\":\"Dev 2\",\"isManager\":false,\"memberId\":null,\"reportsTo\":null}}", .{});
    _ = try rig.expectHas(orgs.patchPosition, .{ .stepped_up = false, .org = "acme", .id = dev_id, .body = same }, 200, &.{"\"title\":\"Dev 2\""});
    try rig.expect(orgs.patchPosition, .{ .stepped_up = false, .org = "acme", .id = dev_id, .body = "{\"isManager\":true}" }, 403, step_up);
    const boss = try rig.expectHas(orgs.patchPosition, .{ .org = "acme", .id = dev_id, .body = "{\"isManager\":true}" }, 200, &.{"\"isManager\":true"});
    _ = boss;
    try rig.expect(orgs.patchPosition, .{ .org = "acme", .id = "ghost", .body = "{}" }, 404, not_found);
    try rig.expect(orgs.patchPosition, .{ .org = "acme", .id = dev_id, .body = "{\"title\":null}" }, 400, invalid_body);
    const cycle = try std.fmt.allocPrint(a, "{{\"reportsTo\":\"{s}\"}}", .{dev_id});
    try rig.expect(orgs.patchPosition, .{ .org = "acme", .id = dev_id, .body = cycle }, 400, "{\"error\":\"reports_to would create a cycle\"}");
}

test "orgs: a project repo needs the instance admin, a step-up and a git directory" {
    const rig = try Rig.create();
    defer rig.destroy();
    _ = try rig.acme();
    const a = rig.arena.allocator();
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const tmp_path = try a.dupe(u8, path_buf[0..try rig.tmp.dir.realPath(testing.io, &path_buf)]);
    const git_dir = try std.fmt.allocPrint(a, "{s}/repo", .{tmp_path});
    // The temp dir sits inside this repo's worktree, so the directory that is no repo is the root.
    const plain_dir = "/";
    const init = try std.process.run(testing.allocator, testing.io, .{ .argv = &.{ "git", "init", "-q", git_dir } });
    testing.allocator.free(init.stdout);
    testing.allocator.free(init.stderr);
    try testing.expectEqual(@as(u8, 0), init.term.exited);

    const with_repo = struct {
        fn body(arena: std.mem.Allocator, key: []const u8, path: []const u8) ![]const u8 {
            return std.fmt.allocPrint(arena, "{{\"key\":\"{s}\",\"name\":\"P\",\"repo\":\"{s}\"}}", .{ key, path });
        }
    }.body;

    _ = try rig.expectHas(orgs.createProject, .{ .org = "acme", .body = "{\"key\":\"A1\",\"name\":\" Alpha \"}" }, 201, &.{"\"teamId\":null,\"key\":\"A1\",\"name\":\"Alpha\",\"repo\":null,\"createdAt\":"});
    try rig.expect(orgs.createProject, .{ .org = "acme", .body = "{\"key\":\"A1\",\"name\":\"Again\"}" }, 409, "{\"error\":\"conflict\"}");
    try rig.expect(orgs.createProject, .{ .org = "acme", .body = "{\"key\":\"a b\",\"name\":\"x\"}" }, 400, invalid_body);
    try rig.expect(orgs.createProject, .{ .org = "acme", .body = "{\"key\":\"A2\",\"name\":\"x\",\"teamId\":\"ghost\"}" }, 400, "{\"error\":\"team not in org\"}");

    // A repo path: instance admin first, then step-up, then the path itself.
    const good = try with_repo(a, "B1", git_dir);
    try rig.expect(orgs.createProject, .{ .org = "acme", .body = good }, 403, forbidden);
    try rig.expect(orgs.createProject, .{ .instance_admin = true, .stepped_up = false, .org = "acme", .body = good }, 403, step_up);
    try rig.expect(orgs.createProject, .{ .instance_admin = true, .org = "acme", .body = try with_repo(a, "B2", "relative/x") }, 400, "{\"error\":\"repo must be an absolute path: relative/x\"}");
    const refused = try std.fmt.allocPrint(a, "{{\"error\":\"not a git repo: {s}\"}}", .{plain_dir});
    try rig.expect(orgs.createProject, .{ .instance_admin = true, .org = "acme", .body = try with_repo(a, "B3", plain_dir) }, 400, refused);
    const made = try std.fmt.allocPrint(a, "\"key\":\"B1\",\"name\":\"P\",\"repo\":\"{s}\"", .{git_dir});
    _ = try rig.expectHas(orgs.createProject, .{ .instance_admin = true, .org = "acme", .body = good }, 201, &.{made});

    // The path is a host path: only the instance admin sees it.
    _ = try rig.expectHas(orgs.detail, .{ .instance_admin = true, .org = "acme" }, 200, &.{made});
    const hidden = try rig.expectHas(orgs.detail, .{ .org = "acme" }, 200, &.{"\"key\":\"B1\",\"name\":\"P\",\"repo\":null"});
    try testing.expect(std.mem.find(u8, hidden, git_dir) == null);
}

test "orgs: grants are for admins of the owning org, with a step-up, and share a project read-only to the grantee" {
    const rig = try Rig.create();
    defer rig.destroy();
    const acme_org = try rig.acme();
    const guest = try rig.org("guest", "gina");
    _ = try rig.org("elsewhere", "eve");
    const a = rig.arena.allocator();
    const project = try repo.createProject(rig.fx.db, testing.io, a, .{ .org_id = acme_org.id, .team_id = null, .key = "APP", .name = "App", .repo = "/srv/app" });
    const grant_body = try std.fmt.allocPrint(a, "{{\"orgId\":\"{s}\",\"permission\":\"write\"}}", .{guest.id});

    try rig.expect(orgs.grant, .{ .stepped_up = false, .id = project.id, .body = grant_body }, 403, step_up);
    for ([_][]const u8{ "mia", "vera" }) |who| try rig.expect(orgs.grant, .{ .user = who, .id = project.id, .body = grant_body }, 403, forbidden);
    try rig.expect(orgs.grant, .{ .user = "eve", .id = project.id, .body = grant_body }, 404, not_found);
    try rig.expect(orgs.grant, .{ .id = "ghost", .body = grant_body }, 404, not_found);
    try rig.expect(orgs.grant, .{ .id = project.id, .body = "{\"orgId\":\"x\",\"permission\":\"admin\"}" }, 400, invalid_body);
    try rig.expect(orgs.grant, .{ .id = project.id, .body = "{\"orgId\":\"ghost\",\"permission\":\"read\"}" }, 400, "{\"error\":\"invalid org\"}");
    const own = try std.fmt.allocPrint(a, "{{\"orgId\":\"{s}\",\"permission\":\"read\"}}", .{acme_org.id});
    try rig.expect(orgs.grant, .{ .id = project.id, .body = own }, 400, "{\"error\":\"invalid org\"}");

    try rig.expect(orgs.grant, .{ .id = project.id, .body = grant_body }, 200, "{\"ok\":true}");
    try rig.expect(orgs.grant, .{ .id = project.id, .body = grant_body }, 200, "{\"ok\":true}");
    // A grantee org's owner can use the project but not manage its grants.
    try rig.expect(orgs.grant, .{ .user = "gina", .id = project.id, .body = grant_body }, 403, forbidden);
    // The grantee sees the project in its own detail, and never the repo path, even as instance admin.
    _ = try rig.expectHas(orgs.detail, .{ .user = "gina", .instance_admin = true, .org = "guest" }, 200, &.{"\"key\":\"APP\",\"name\":\"App\",\"repo\":null"});
    _ = try rig.expectHas(orgs.detail, .{ .instance_admin = true, .org = "acme" }, 200, &.{"\"repo\":\"/srv/app\""});

    const revoke_body = try std.fmt.allocPrint(a, "{{\"orgId\":\"{s}\"}}", .{guest.id});
    try rig.expect(orgs.revoke, .{ .user = "mia", .id = project.id, .body = revoke_body }, 403, forbidden);
    try rig.expect(orgs.revoke, .{ .stepped_up = false, .id = project.id, .body = revoke_body }, 403, step_up);
    try rig.expect(orgs.revoke, .{ .id = project.id, .body = revoke_body }, 200, "{\"ok\":true}");
    _ = try rig.expectHas(orgs.detail, .{ .user = "gina", .org = "guest" }, 200, &.{"\"projects\":[]"});
}
