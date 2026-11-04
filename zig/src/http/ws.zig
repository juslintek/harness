//! `/ws` wiring: the route handler and the three `Access` callbacks the realtime hub asks the rest
//! of the server for (realtime/hub.zig), backed by the session middleware and the database.
//! Org topics are opened to members already (`orgAccess`), but nothing publishes on them until the
//! slices that own those events are wired.
const std = @import("std");
const httpz = @import("httpz");
const app_mod = @import("../app.zig");
const middleware = @import("../auth/middleware.zig");
const sessions = @import("../auth/sessions.zig");
const sqlite = @import("../db/sqlite.zig");
const hub_mod = @import("../realtime/hub.zig");
const routes = @import("routes.zig");

const App = app_mod.App;
const State = app_mod.State;

/// Hands the request to the hub, which checks topic, access and session expiry, then upgrades.
/// A server built without a hub answers 501 like any row that is not ported.
pub fn upgrade(call: *routes.Call) anyerror!void {
    const hub = call.services.hub orelse return routes.notImplemented(call);
    try hub.handleUpgrade(call.req, call.res);
}

pub const Wiring = struct {
    app: *App,
    session_auth: *middleware.SessionAuth,

    pub fn init(app: *App, session_auth: *middleware.SessionAuth) Wiring {
        return .{ .app = app, .session_auth = session_auth };
    }

    pub fn access(self: *Wiring) hub_mod.Access {
        return .{
            .ctx = self,
            .identify = identify,
            .org_access = orgAccess,
            .session_expires_at = sessionExpiresAt,
        };
    }

    /// The chain already ran the session gate, so a failure here is a lookup error or a session
    /// revoked in between: both end as 401.
    fn identify(ctx: *anyopaque, req: *httpz.Request, arena: std.mem.Allocator) ?hub_mod.Identity {
        const self: *Wiring = @ptrCast(@alignCast(ctx));
        const found = self.session_auth.sessionOf(arena, req) catch |err| {
            std.log.warn("realtime: session lookup failed: {t}", .{err});
            return null;
        };
        const session = found orelse return null;
        return .{ .session_id = session.id, .user_id = session.user_id, .instance_admin = session.instance_admin };
    }

    /// `orgAccess(db, userId, orgId) !== null`. A failed query denies: the socket is never opened
    /// on a guess.
    fn orgAccess(ctx: *anyopaque, user_id: []const u8, org_id: []const u8) bool {
        const self: *Wiring = @ptrCast(@alignCast(ctx));
        return self.app.withLock(&MemberArgs{ .user_id = user_id, .org_id = org_id }, isMemberLocked) catch |err| {
            std.log.warn("realtime: membership lookup failed: {t}", .{err});
            return false;
        };
    }

    /// `sessionExpiresAt`. A failed read counts as ended; the client reconnects.
    fn sessionExpiresAt(ctx: *anyopaque, session_id: []const u8) ?i64 {
        const self: *Wiring = @ptrCast(@alignCast(ctx));
        const found = sessions.expiresAt(self.app, session_id, self.session_auth.clock(self.app.io)) catch |err| {
            std.log.warn("realtime: session expiry lookup failed: {t}", .{err});
            return null;
        };
        return found;
    }
};

const MemberArgs = struct { user_id: []const u8, org_id: []const u8 };

fn isMemberLocked(args: *const MemberArgs, state: *State) (sqlite.Error || error{NoDatabase})!bool {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const stmt = try db.prepare("SELECT 1 FROM members WHERE org_id = ? AND user_id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, args.org_id);
    try stmt.bindText(2, args.user_id);
    return try stmt.step();
}

const testing = std.testing;
const Fixture = @import("../auth/fixture.zig").Fixture;

test "ws: org access is membership of that org and nothing else" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try fx.addUser("u-member", false);
    try fx.addUser("u-other", false);
    try fx.run("INSERT INTO orgs (id, slug, name, created_at) VALUES ('org-a', 'a', 'A', 1), ('org-b', 'b', 'B', 1)");
    try fx.run("INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at) " ++
        "VALUES ('m1', 'org-a', 'human', 'u-member', 'member', 'Member', 'viewer', 1)");
    var auth = middleware.SessionAuth.init(&fx.app, null);
    var wiring = Wiring.init(&fx.app, &auth);
    const access = wiring.access();
    try testing.expect(access.org_access(access.ctx, "u-member", "org-a"));
    try testing.expect(!access.org_access(access.ctx, "u-member", "org-b"));
    try testing.expect(!access.org_access(access.ctx, "u-other", "org-a"));
}

test "ws: a session's expiry is read until it is revoked" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    try fx.addUser("u1", false);
    var auth = middleware.SessionAuth.init(&fx.app, null);
    var wiring = Wiring.init(&fx.app, &auth);
    const access = wiring.access();
    const now = auth.clock(testing.io);
    const created = try sessions.create(&fx.app, .{ .user_id = "u1", .method = .passkey, .user_agent = null }, now);
    const expiry = access.session_expires_at(access.ctx, &created.id);
    try testing.expect(expiry != null and expiry.? > now);
    try testing.expect(try sessions.revoke(&fx.app, "u1", &created.id, now));
    try testing.expect(access.session_expires_at(access.ctx, &created.id) == null);
}
