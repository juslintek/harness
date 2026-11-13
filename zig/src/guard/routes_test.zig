//! Tests of the guard routes, routes.test.ts and the guard hook cases of http.test.ts, run against
//! an in-memory database with the real schema. Each test builds the same small world: two orgs,
//! their members and agent runs, and one approval per situation.
const std = @import("std");
const httpz = @import("httpz");
const Fixture = @import("../auth/fixture.zig").Fixture;
const headers = @import("../http/headers.zig");
const ids = @import("../ids.zig");
const policy = @import("../http/policy.zig");
const routes = @import("../http/routes.zig");
const tokens = @import("../mcp/tokens.zig");
const guard_routes = @import("routes.zig");

const testing = std.testing;

const far: []const u8 = "99999999999999";

const world =
    \\INSERT INTO users (id, email, name, instance_admin, created_at) VALUES
    \\  ('admin', 'a@x.test', 'A', 1, 1), ('owner_a', 'oa@x.test', 'OA', 0, 1), ('admin_a', 'aa@x.test', 'AA', 0, 1),
    \\  ('member_a', 'ma@x.test', 'MA', 0, 1), ('owner_b', 'ob@x.test', 'OB', 0, 1), ('plain', 'p@x.test', 'P', 0, 1);
    \\INSERT INTO orgs (id, slug, name, created_at) VALUES ('org_a', 'a', 'A', 1), ('org_b', 'b', 'B', 1);
    \\INSERT INTO members (id, org_id, kind, user_id, agent_id, handle, display_name, role, created_at) VALUES
    \\  ('m_owner_a', 'org_a', 'human', 'owner_a', NULL, 'owner-a', 'OA', 'owner', 1),
    \\  ('m_admin_a', 'org_a', 'human', 'admin_a', NULL, 'admin-a', 'AA', 'admin', 1),
    \\  ('m_member_a', 'org_a', 'human', 'member_a', NULL, 'member-a', 'MA', 'member', 1),
    \\  ('m_agent_a', 'org_a', 'agent', NULL, 'claude', 'agent-a', 'Agent A', 'member', 1),
    \\  ('m_owner_b', 'org_b', 'human', 'owner_b', NULL, 'owner-b', 'OB', 'owner', 1),
    \\  ('m_agent_b', 'org_b', 'agent', NULL, 'claude', 'agent-b', 'Agent B', 'member', 1);
    \\INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('proj_b', 'org_b', 'PB', 'PB', 1);
    \\INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id, project_id) VALUES
    \\  ('run_a', 'claude', '/r', 'p', 'running', 1, 'm_agent_a', NULL),
    \\  ('run_b', 'claude', '/r', 'p', 'running', 1, 'm_agent_b', NULL),
    \\  ('run_a_in_b', 'claude', '/r', 'p', 'running', 1, 'm_agent_a', 'proj_b'),
    \\  ('run_none', 'claude', '/r', 'p', 'running', 1, NULL, NULL);
    \\INSERT INTO approvals (id, run_id, action, l1, l2, status, decided_by, created_at, expires_at, decided_at) VALUES
    \\  ('ap_a', 'run_a', '{"kind":"execute","command":"npm test","paths":[]}', '{"verdict":"ask","rule":"shell.unknown","reason":"needs ok","category":"shell"}', NULL, 'pending', NULL, 10, 99999999999999, NULL),
    \\  ('ap_a_done', 'run_a', '{"kind":"edit","paths":["a.txt","b.txt"]}', '{"verdict":"ask","rule":"edit.x","category":"write"}', NULL, 'approved', 'user:admin', 11, 99999999999999, 12),
    \\  ('ap_b', 'run_b', '{"kind":"execute","command":"make","paths":[]}', '{"verdict":"ask","rule":"shell.unknown","reason":"r","category":"shell"}', NULL, 'pending', NULL, 12, 99999999999999, NULL),
    \\  ('ap_a_in_b', 'run_a_in_b', '{"kind":"execute","command":"make","paths":[]}', '{"verdict":"ask","rule":"shell.unknown","reason":"r","category":"shell"}', NULL, 'pending', NULL, 13, 99999999999999, NULL),
    \\  ('ap_a_net', 'run_a', '{"kind":"execute","command":"curl example.test","paths":[]}', '{"verdict":"ask","rule":"net.curl","reason":"network","category":"network"}', NULL, 'pending', NULL, 14, 99999999999999, NULL),
    \\  ('ap_a_old', 'run_a', '{"kind":"execute","command":"npm test","paths":[]}', '{"verdict":"ask","rule":"shell.unknown","reason":"old","category":"shell"}', NULL, 'pending', NULL, 15, 1000, NULL),
    \\  ('ap_none', 'run_none', '{"kind":"execute","command":"ls","paths":[]}', '{"verdict":"ask","rule":"shell.unknown","reason":"r","category":"shell"}', NULL, 'pending', NULL, 16, 99999999999999, NULL);
;

const Who = enum { admin, owner_a, admin_a, member_a, owner_b, plain };

const Rig = struct {
    fx: *Fixture,
    services: routes.Services,

    fn create() !*Rig {
        const self = try testing.allocator.create(Rig);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, testing.io);
        errdefer self.fx.destroy();
        try self.fx.db.exec(world);
        self.services = .{ .app = &self.fx.app, .health = .{ .instance_id = @splat('a') }, .home = "/srv/harness-home" };
        return self;
    }

    fn destroy(self: *Rig) void {
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn actor(who: Who, stepped_up: bool) policy.Actor {
        return .{
            .instance_admin = who == .admin,
            .user_id = @tagName(who),
            .step_up_at = if (stepped_up) ids.nowMs(testing.io) else null,
        };
    }

    const Request = struct {
        id: ?[]const u8 = null,
        query: ?[]const u8 = null,
        body: ?[]const u8 = null,
        who: Who = .admin,
        stepped_up: bool = true,
        authorization: ?[]const u8 = null,
    };

    fn call(self: *Rig, handler: routes.HandlerFn, request: Request) !httpz.testing.Testing {
        var web = httpz.testing.init(.{});
        errdefer web.deinit();
        if (request.id) |id| web.param("id", id);
        if (request.query) |query| web.url(query);
        if (request.body) |body| web.body(body);
        if (request.authorization) |value| web.header("authorization", value);
        var routed: routes.Call = .{ .services = &self.services, .req = web.req, .res = web.res, .actor = actor(request.who, request.stepped_up) };
        handler(&routed) catch |err| {
            const mapped = headers.mapError(err);
            web.res.clearWriter();
            try headers.sendError(web.res, mapped.status, mapped.message);
        };
        return web;
    }

    fn statusOf(self: *Rig, id: []const u8) ![]const u8 {
        const stmt = try self.fx.db.prepare("SELECT status FROM approvals WHERE id = ?");
        defer stmt.finalize();
        try stmt.bindText(1, id);
        try testing.expect(try stmt.step());
        return (try stmt.textAlloc(testing.allocator, 0)).?;
    }

    fn expectStatus(self: *Rig, id: []const u8, expected: []const u8) !void {
        const got = try self.statusOf(id);
        defer testing.allocator.free(got);
        try testing.expectEqualStrings(expected, got);
    }
};

/// The ids of a list answer, comma separated, in the order served.
fn listedIds(web: *httpz.testing.Testing) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, web.res.buffer.written(), .{});
    defer parsed.deinit();
    var out: std.ArrayList(u8) = .empty;
    for (parsed.value.array.items, 0..) |item, i| {
        if (i > 0) try out.append(testing.allocator, ',');
        try out.appendSlice(testing.allocator, item.object.get("id").?.string);
    }
    return out.toOwnedSlice(testing.allocator);
}

fn expectListed(rig: *Rig, request: Rig.Request, expected: []const u8) !void {
    var web = try rig.call(guard_routes.list, request);
    defer web.deinit();
    try web.expectStatus(200);
    const got = try listedIds(&web);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(expected, got);
}

fn expectJsonBody(web: *httpz.testing.Testing, status: u16, body: []const u8) !void {
    try web.expectStatus(status);
    try web.expectBody(body);
}

test "guard routes: the instance admin lists every approval in creation order" {
    const rig = try Rig.create();
    defer rig.destroy();
    try expectListed(rig, .{}, "ap_a,ap_a_done,ap_b,ap_a_in_b,ap_a_net,ap_a_old,ap_none");
}

test "guard routes: a list row is the approval view in wire order" {
    const rig = try Rig.create();
    defer rig.destroy();
    var web = try rig.call(guard_routes.list, .{ .query = "/api/approvals?status=approved" });
    defer web.deinit();
    try expectJsonBody(&web, 200, "[{\"id\":\"ap_a_done\",\"runId\":\"run_a\",\"command\":\"a.txt b.txt\",\"reason\":null,\"status\":\"approved\"," ++
        "\"decidedBy\":\"user:admin\",\"createdAt\":11,\"expiresAt\":99999999999999,\"decidedAt\":12}]");
    var pending = try rig.call(guard_routes.list, .{ .query = "/api/approvals?status=pending", .id = null });
    defer pending.deinit();
    const got = try listedIds(&pending);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings("ap_a,ap_b,ap_a_in_b,ap_a_net,ap_a_old,ap_none", got);
}

test "guard routes: an unknown status is 400, also an empty or upper-case one" {
    const rig = try Rig.create();
    defer rig.destroy();
    for ([_][]const u8{ "/api/approvals?status=nope", "/api/approvals?status=", "/api/approvals?status=PENDING", "/api/approvals?status=pending%00" }) |url| {
        var web = try rig.call(guard_routes.list, .{ .query = url });
        defer web.deinit();
        try expectJsonBody(&web, 400, "{\"error\":\"invalid status\"}");
    }
    // The first `status` wins, and other parameters are ignored.
    try expectListed(rig, .{ .query = "/api/approvals?x=1&status=denied&status=bogus" }, "");
}

test "guard routes: an org owner or admin lists only the runs of the orgs it administers" {
    const rig = try Rig.create();
    defer rig.destroy();
    try expectListed(rig, .{ .who = .owner_a }, "ap_a,ap_a_done,ap_a_net,ap_a_old");
    try expectListed(rig, .{ .who = .admin_a }, "ap_a,ap_a_done,ap_a_net,ap_a_old");
    // The run of org A's agent in a project of org B is B's to decide.
    try expectListed(rig, .{ .who = .owner_b }, "ap_b,ap_a_in_b");
    try expectListed(rig, .{ .who = .owner_b, .query = "/api/approvals?status=pending" }, "ap_b,ap_a_in_b");
}

test "guard routes: someone who administers no org gets 403 on the list, whatever the query" {
    const rig = try Rig.create();
    defer rig.destroy();
    for ([_]Who{ .member_a, .plain }) |who| {
        var web = try rig.call(guard_routes.list, .{ .who = who });
        defer web.deinit();
        try expectJsonBody(&web, 403, "{\"error\":\"forbidden\"}");
        var bad = try rig.call(guard_routes.list, .{ .who = who, .query = "/api/approvals?status=nope" });
        defer bad.deinit();
        try expectJsonBody(&bad, 403, "{\"error\":\"forbidden\"}");
    }
}

test "guard routes: approve answers the refreshed view and records who decided" {
    const rig = try Rig.create();
    defer rig.destroy();
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = "{\"decision\":\"approve\"}" });
    defer web.deinit();
    try web.expectStatus(200);
    const parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, web.res.buffer.written(), .{});
    defer parsed.deinit();
    const view = parsed.value.object;
    try testing.expectEqualStrings("ap_a", view.get("id").?.string);
    try testing.expectEqualStrings("npm test", view.get("command").?.string);
    try testing.expectEqualStrings("approved", view.get("status").?.string);
    try testing.expectEqualStrings("user:admin", view.get("decidedBy").?.string);
    try testing.expect(view.get("decidedAt").? == .integer);
    try rig.expectStatus("ap_a", "approved");
}

test "guard routes: an org owner denies a request of its own agent" {
    const rig = try Rig.create();
    defer rig.destroy();
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a", .who = .owner_a, .body = "{\"decision\":\"deny\"}" });
    defer web.deinit();
    try web.expectStatus(200);
    try testing.expect(std.mem.find(u8, web.res.buffer.written(), "\"status\":\"denied\",\"decidedBy\":\"user:owner_a\"") != null);
    try rig.expectStatus("ap_a", "denied");
}

test "guard routes: a second decision is 409 and keeps the first" {
    const rig = try Rig.create();
    defer rig.destroy();
    var first = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = "{\"decision\":\"deny\"}" });
    defer first.deinit();
    try first.expectStatus(200);
    var second = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = "{\"decision\":\"approve\"}" });
    defer second.deinit();
    try expectJsonBody(&second, 409, "{\"error\":\"not pending\"}");
    try rig.expectStatus("ap_a", "denied");
    var decided = try rig.call(guard_routes.decide, .{ .id = "ap_a_done", .body = "{\"decision\":\"deny\"}" });
    defer decided.deinit();
    try expectJsonBody(&decided, 409, "{\"error\":\"not pending\"}");
}

test "guard routes: an unknown id is 404 for the instance admin and for an org owner" {
    const rig = try Rig.create();
    defer rig.destroy();
    for ([_]Who{ .admin, .owner_a }) |who| {
        var web = try rig.call(guard_routes.decide, .{ .id = "nope", .who = who, .body = "{\"decision\":\"approve\"}" });
        defer web.deinit();
        try expectJsonBody(&web, 404, "{\"error\":\"unknown approval\"}");
    }
}

test "guard routes: a pending approval past its expiry is 409 and the row becomes expired" {
    const rig = try Rig.create();
    defer rig.destroy();
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a_old", .body = "{\"decision\":\"approve\"}" });
    defer web.deinit();
    try expectJsonBody(&web, 409, "{\"error\":\"not pending\"}");
    try rig.expectStatus("ap_a_old", "expired");
}

test "guard routes: a plain member is refused before anything else" {
    const rig = try Rig.create();
    defer rig.destroy();
    for ([_]Who{ .member_a, .plain }) |who| {
        // Not stepped up, with a bad body and an unknown id: the org gate still answers first.
        var web = try rig.call(guard_routes.decide, .{ .id = "nope", .who = who, .stepped_up = false, .body = "x" });
        defer web.deinit();
        try expectJsonBody(&web, 403, "{\"error\":\"forbidden\"}");
        var known = try rig.call(guard_routes.decide, .{ .id = "ap_a", .who = who, .body = "{\"decision\":\"approve\"}" });
        defer known.deinit();
        try expectJsonBody(&known, 403, "{\"error\":\"forbidden\"}");
    }
    try rig.expectStatus("ap_a", "pending");
}

test "guard routes: the admin of another org cannot decide, and nothing changes" {
    const rig = try Rig.create();
    defer rig.destroy();
    var other = try rig.call(guard_routes.decide, .{ .id = "ap_a", .who = .owner_b, .body = "{\"decision\":\"approve\"}" });
    defer other.deinit();
    try expectJsonBody(&other, 403, "{\"error\":\"forbidden\"}");
    // A run in a project of org B is not org A's, even though its agent belongs to A.
    var grantee = try rig.call(guard_routes.decide, .{ .id = "ap_a_in_b", .who = .owner_a, .body = "{\"decision\":\"approve\"}" });
    defer grantee.deinit();
    try expectJsonBody(&grantee, 403, "{\"error\":\"forbidden\"}");
    // A run without a member belongs to nobody, so only the instance admin may decide it.
    var orphan = try rig.call(guard_routes.decide, .{ .id = "ap_none", .who = .owner_a, .body = "{\"decision\":\"approve\"}" });
    defer orphan.deinit();
    try expectJsonBody(&orphan, 403, "{\"error\":\"forbidden\"}");
    try rig.expectStatus("ap_a", "pending");
    try rig.expectStatus("ap_a_in_b", "pending");
    try rig.expectStatus("ap_none", "pending");
    var owner = try rig.call(guard_routes.decide, .{ .id = "ap_a_in_b", .who = .owner_b, .body = "{\"decision\":\"approve\"}" });
    defer owner.deinit();
    try owner.expectStatus(200);
}

test "guard routes: an org owner cannot approve a network action, the instance admin can" {
    const rig = try Rig.create();
    defer rig.destroy();
    var refused = try rig.call(guard_routes.decide, .{ .id = "ap_a_net", .who = .owner_a, .body = "{\"decision\":\"approve\"}" });
    defer refused.deinit();
    try expectJsonBody(&refused, 403, "{\"error\":\"instance_admin_required\",\"reason\":\"network and secret actions need a human\"}");
    try rig.expectStatus("ap_a_net", "pending");
    // Denying is refused the same way: the limit is on who may decide, not on the direction.
    var deny = try rig.call(guard_routes.decide, .{ .id = "ap_a_net", .who = .admin_a, .body = "{\"decision\":\"deny\"}" });
    defer deny.deinit();
    try web403(&deny);
    var admin = try rig.call(guard_routes.decide, .{ .id = "ap_a_net", .body = "{\"decision\":\"approve\"}" });
    defer admin.deinit();
    try admin.expectStatus(200);
    try rig.expectStatus("ap_a_net", "approved");
}

fn web403(web: *httpz.testing.Testing) !void {
    try web.expectStatus(403);
    try testing.expect(std.mem.startsWith(u8, web.res.buffer.written(), "{\"error\":\"instance_admin_required\""));
}

test "guard routes: an action that names the harness home is for the instance admin only" {
    const rig = try Rig.create();
    defer rig.destroy();
    try rig.fx.db.exec("UPDATE approvals SET action = '{\"kind\":\"execute\",\"command\":\"cat /srv/harness-home/harness.db\",\"paths\":[]}' WHERE id = 'ap_a'");
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a", .who = .owner_a, .body = "{\"decision\":\"approve\"}" });
    defer web.deinit();
    try expectJsonBody(&web, 403, "{\"error\":\"instance_admin_required\",\"reason\":\"the action touches the harness home\"}");
    try rig.expectStatus("ap_a", "pending");
}

test "guard routes: an unreadable stored action is for the instance admin only" {
    const rig = try Rig.create();
    defer rig.destroy();
    // A lone surrogate escape is valid for JSON.parse in the TS server that wrote the row.
    try rig.fx.db.exec("UPDATE approvals SET action = '{\"kind\":\"execute\",\"command\":\"curl \\ud800\",\"paths\":[]}' WHERE id = 'ap_a'");
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a", .who = .owner_a, .body = "{\"decision\":\"approve\"}" });
    defer web.deinit();
    try expectJsonBody(&web, 403, "{\"error\":\"instance_admin_required\",\"reason\":\"the stored action cannot be read; a human must decide\"}");
    try rig.expectStatus("ap_a", "pending");
    var admin = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = "{\"decision\":\"approve\"}" });
    defer admin.deinit();
    try admin.expectStatus(200);
    try rig.expectStatus("ap_a", "approved");
}

test "guard routes: the decision body must be exactly one of approve or deny" {
    const rig = try Rig.create();
    defer rig.destroy();
    const bodies = [_]?[]const u8{ null, "", "nope", "null", "[]", "{}", "{\"decision\":\"maybe\"}", "{\"decision\":1}", "{\"decision\":[97,112,112,114,111,118,101]}", "{\"decision\":\"APPROVE\"}", "{\"decision\":\"approve\"" };
    for (bodies) |body| {
        var web = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = body });
        defer web.deinit();
        if (web.res.status != 400) std.debug.print("accepted body: {?s}\n", .{body});
        try expectJsonBody(&web, 400, "{\"error\":\"invalid body\"}");
    }
    // Invalid UTF-8 and a huge body are 400 as well, and a bad body wins over an unknown id.
    var binary = try rig.call(guard_routes.decide, .{ .id = "nope", .body = "{\"decision\":\"approve\xff\"}" });
    defer binary.deinit();
    try expectJsonBody(&binary, 400, "{\"error\":\"invalid body\"}");
    const huge = try testing.allocator.alloc(u8, 2 * 1024 * 1024);
    defer testing.allocator.free(huge);
    @memset(huge, '[');
    var deep = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = huge });
    defer deep.deinit();
    try expectJsonBody(&deep, 400, "{\"error\":\"invalid body\"}");
    try rig.expectStatus("ap_a", "pending");
    // Extra keys are ignored and the last duplicate wins, as `JSON.parse` does.
    var extra = try rig.call(guard_routes.decide, .{ .id = "ap_a", .body = "{\"decision\":\"approve\",\"decision\":\"deny\",\"by\":\"root\"}" });
    defer extra.deinit();
    try extra.expectStatus(200);
    try rig.expectStatus("ap_a", "denied");
}

test "guard routes: a decision needs a fresh step-up, and nothing is read before it" {
    const rig = try Rig.create();
    defer rig.destroy();
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a", .stepped_up = false, .body = "{\"decision\":\"approve\"}" });
    defer web.deinit();
    try expectJsonBody(&web, 403, "{\"error\":\"step_up_required\"}");
    var unknown = try rig.call(guard_routes.decide, .{ .id = "nope", .stepped_up = false, .body = "bad" });
    defer unknown.deinit();
    try expectJsonBody(&unknown, 403, "{\"error\":\"step_up_required\"}");
    var owner = try rig.call(guard_routes.decide, .{ .id = "ap_a", .who = .owner_a, .stepped_up = false, .body = "{\"decision\":\"approve\"}" });
    defer owner.deinit();
    try expectJsonBody(&owner, 403, "{\"error\":\"step_up_required\"}");
    try rig.expectStatus("ap_a", "pending");
}

test "guard routes: a decision text with a hostile id or a quote cannot change other rows" {
    const rig = try Rig.create();
    defer rig.destroy();
    var web = try rig.call(guard_routes.decide, .{ .id = "ap_a' OR '1'='1", .body = "{\"decision\":\"approve\"}" });
    defer web.deinit();
    try expectJsonBody(&web, 404, "{\"error\":\"unknown approval\"}");
    try rig.expectStatus("ap_b", "pending");
    try rig.expectStatus("ap_a", "pending");
}

// ---- POST /api/guard/hook ----

const hook_ok = "{\"runId\":\"run_a\",\"verdict\":\"deny\",\"rule\":\"git.push\",\"command\":\"git push origin main\"}";

fn mintFor(rig: *Rig, run_id: []const u8, scopes: []const tokens.Scope) ![tokens.token_len]u8 {
    return tokens.mint(&rig.fx.app, run_id, scopes, .none, ids.nowMs(testing.io));
}

fn repeated(arena: std.mem.Allocator, text: []const u8, count: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    for (0..count) |_| try out.appendSlice(arena, text);
    return out.items;
}

fn hookJson(arena: std.mem.Allocator, rule: []const u8, command: []const u8) ![]u8 {
    return std.fmt.allocPrint(arena, "{{\"runId\":\"run_a\",\"verdict\":\"ask\",\"rule\":\"{s}\",\"command\":\"{s}\"}}", .{ rule, command });
}

fn bearerFor(token: []const u8) ![]u8 {
    return std.fmt.allocPrint(testing.allocator, "Bearer {s}", .{token});
}

fn countHookEvents(rig: *Rig) !i64 {
    const stmt = try rig.fx.db.prepare("SELECT count(*) FROM events WHERE kind = 'guard' AND source = 'hook'");
    defer stmt.finalize();
    _ = try stmt.step();
    return stmt.int(0);
}

test "guard routes: the hook refuses a missing, malformed or unknown token with 401" {
    const rig = try Rig.create();
    defer rig.destroy();
    const unknown_header = "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for ([_]?[]const u8{ null, "", "Bearer", "Bearer ", "bearer abc", "Basic abc", "Bearer a b", unknown_header }) |value| {
        var web = try rig.call(guard_routes.hook, .{ .authorization = value, .body = hook_ok });
        defer web.deinit();
        try expectJsonBody(&web, 401, "{\"error\":\"unauthorized\"}");
    }
    try testing.expectEqual(@as(i64, 0), try countHookEvents(rig));
}

test "guard routes: the hook needs the guard_hook scope, and checks it before the body" {
    const rig = try Rig.create();
    defer rig.destroy();
    const token = try mintFor(rig, "run_a", &.{ .report, .board });
    const header = try bearerFor(&token);
    defer testing.allocator.free(header);
    var web = try rig.call(guard_routes.hook, .{ .authorization = header, .body = hook_ok });
    defer web.deinit();
    try expectJsonBody(&web, 403, "{\"error\":\"forbidden\"}");
    var bad = try rig.call(guard_routes.hook, .{ .authorization = header, .body = "nope" });
    defer bad.deinit();
    try expectJsonBody(&bad, 403, "{\"error\":\"forbidden\"}");
    try testing.expectEqual(@as(i64, 0), try countHookEvents(rig));
}

test "guard routes: the hook rejects an invalid body with 400" {
    const rig = try Rig.create();
    defer rig.destroy();
    const token = try mintFor(rig, "run_a", &.{.guard_hook});
    const header = try bearerFor(&token);
    defer testing.allocator.free(header);
    var scratch: std.heap.ArenaAllocator = .init(testing.allocator);
    defer scratch.deinit();
    const arena = scratch.allocator();
    const bodies = [_][]const u8{
        "",
        "nope",
        "[]",
        "{}",
        "{\"runId\":\"\",\"verdict\":\"allow\",\"rule\":\"r\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":\"block\",\"rule\":\"r\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":\"allow\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":\"allow\",\"rule\":\"r\"}",
        "{\"runId\":7,\"verdict\":\"allow\",\"rule\":\"r\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":0,\"rule\":\"r\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":\"Allow\",\"rule\":\"r\",\"command\":\"x\"}",
        // std.json reads a text field from an array of byte values, zod does not.
        "{\"runId\":[114,117,110,95,97],\"verdict\":\"allow\",\"rule\":\"r\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":[100,101,110,121],\"rule\":\"r\",\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":\"allow\",\"rule\":[114],\"command\":\"x\"}",
        "{\"runId\":\"run_a\",\"verdict\":\"allow\",\"rule\":\"r\",\"command\":[120]}",
        "{\"runId\":\"run_a\",\"verdict\":\"allow\",\"rule\":\"r\",\"command\":\"x\xff\"}",
        try hookJson(arena, try repeated(arena, "r", 201), "x"),
        try hookJson(arena, "r", try repeated(arena, "c", 20001)),
        // zod counts code points: 20001 emoji are one too many.
        try hookJson(arena, "r", try repeated(arena, "\u{1F600}", 20001)),
    };
    for (bodies) |body| {
        var web = try rig.call(guard_routes.hook, .{ .authorization = header, .body = body });
        defer web.deinit();
        try expectJsonBody(&web, 400, "{\"error\":\"invalid body\"}");
    }
    try testing.expectEqual(@as(i64, 0), try countHookEvents(rig));
}

test "guard routes: the hook limits count code points, 200 for the rule and 20000 for the command" {
    const rig = try Rig.create();
    defer rig.destroy();
    const token = try mintFor(rig, "run_a", &.{.guard_hook});
    const header = try bearerFor(&token);
    defer testing.allocator.free(header);
    var scratch: std.heap.ArenaAllocator = .init(testing.allocator);
    defer scratch.deinit();
    const arena = scratch.allocator();
    const edge = try hookJson(arena, try repeated(arena, "r", 200), try repeated(arena, "\u{1F600}", 20000));
    var web = try rig.call(guard_routes.hook, .{ .authorization = header, .body = edge });
    defer web.deinit();
    try expectJsonBody(&web, 200, "{\"ok\":true}");
}

test "guard routes: a token cannot report for another run" {
    const rig = try Rig.create();
    defer rig.destroy();
    const token = try mintFor(rig, "run_b", &.{.guard_hook});
    const header = try bearerFor(&token);
    defer testing.allocator.free(header);
    var web = try rig.call(guard_routes.hook, .{ .authorization = header, .body = hook_ok });
    defer web.deinit();
    try expectJsonBody(&web, 403, "{\"error\":\"forbidden\"}");
    try testing.expectEqual(@as(i64, 0), try countHookEvents(rig));
}

test "guard routes: a valid hook report becomes a guard event of source hook" {
    const rig = try Rig.create();
    defer rig.destroy();
    const token = try mintFor(rig, "run_a", &.{.guard_hook});
    const header = try bearerFor(&token);
    defer testing.allocator.free(header);
    var web = try rig.call(guard_routes.hook, .{ .authorization = header, .body = hook_ok });
    defer web.deinit();
    try expectJsonBody(&web, 200, "{\"ok\":true}");
    const stmt = try rig.fx.db.prepare("SELECT run_id, command, guard_verdict, guard_rule, guard_layer FROM events WHERE source = 'hook'");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqualStrings("run_a", (try stmt.text(0)).?);
    try testing.expectEqualStrings("git push origin main", (try stmt.text(1)).?);
    try testing.expectEqualStrings("deny", (try stmt.text(2)).?);
    try testing.expectEqualStrings("git.push", (try stmt.text(3)).?);
    try testing.expect(stmt.isNull(4));
    try testing.expect(!try stmt.step());
}

test "guard routes: a revoked token no longer reports" {
    const rig = try Rig.create();
    defer rig.destroy();
    const token = try mintFor(rig, "run_a", &.{.guard_hook});
    try tokens.revoke(&rig.fx.app, "run_a");
    const header = try bearerFor(&token);
    defer testing.allocator.free(header);
    var web = try rig.call(guard_routes.hook, .{ .authorization = header, .body = hook_ok });
    defer web.deinit();
    try expectJsonBody(&web, 401, "{\"error\":\"unauthorized\"}");
}
