//! The flat route table: one row per endpoint, so a later slice replaces `notImplemented` in its
//! rows and adds nothing else. The first rows are `contract/routes.json` as dumped from the TS app;
//! the last three are the paths `contract/routes-extra.json` lists beside Hono. The policy flags
//! here, not the dump's, are the authorization source: the dump only sees named middleware, and
//! handlers such as `POST /api/orgs/:org/members/agents` check admin and step-up inline, so those
//! rows must be corrected by the slice that ports them.
const std = @import("std");
const httpz = @import("httpz");
const App = @import("../app.zig").App;
const ids = @import("../ids.zig");
const health_body = @import("../health.zig");
const headers = @import("headers.zig");
const policy = @import("policy.zig");
const session_endpoints = @import("../auth/middleware.zig");
const auth_routes = @import("../auth/routes.zig");
const agents = @import("../agents/routes.zig");
const orgs = @import("../orgs/routes.zig");
const guard_routes = @import("../guard/routes.zig");
const mcp = @import("../mcp/server.zig");
const logs_api = @import("../logs/api.zig");
const usage_routes = @import("../usage/routes.zig");
const runtime_routes = @import("../runtimes/routes.zig");
const runtimes = @import("../runtimes/manager.zig");
const ws = @import("ws.zig");
const Hub = @import("../realtime/hub.zig").Hub;

pub const Method = policy.Method;
pub const Policy = policy.Policy;
pub const Actor = policy.Actor;

/// Instance facts `GET /api/health` reports (`healthSchema` in code/src/shared/health.ts); the
/// version is `health.version`.
pub const Health = struct {
    instance_id: [ids.uuid_len]u8,
};

/// What every handler can reach. Built once at startup and read-only afterwards; anything mutable
/// belongs in `app` and is touched only through `App.withLock`.
pub const Services = struct {
    app: *App,
    health: Health,
    /// The agents slice's state; null in tests that never reach its routes.
    agents: ?*agents.Ctx = null,
    mcp: mcp.Deps = .{},
    /// The realtime hub; null where no WebSocket is served (the `/ws` row then answers 501).
    hub: ?*Hub = null,
    /// The run manager; null in tests and server modes that do not start runtimes.
    manager: ?*runtimes.Manager = null,
    /// HARNESS_HOME as expanded by the configuration; the approval routes refuse what touches it.
    home: []const u8 = "",
};

/// One request as a handler sees it. `actor` is set for every row that went through the session
/// gate and null for public and loopback rows.
pub const Call = struct {
    services: *const Services,
    req: *httpz.Request,
    res: *httpz.Response,
    actor: ?Actor,
    /// `deps.rp.origin`: HARNESS_ORIGIN, or `http://localhost:<port>`. Valid while the handler runs.
    origin: []const u8 = "",
    /// The port the listener is bound to; `/mcp` accepts only Hosts that name it.
    port: u16 = 0,
};

pub const HandlerFn = *const fn (call: *Call) anyerror!void;

pub const Route = struct {
    method: Method,
    path: []const u8,
    handler: HandlerFn,
    policy: Policy,
};

fn row(method: Method, path: []const u8, flags: Policy) Route {
    return .{ .method = method, .path = path, .handler = notImplemented, .policy = flags };
}

/// Every route not ported yet. 501, not 404, so a client can tell "not here yet" from "no such path".
pub fn notImplemented(call: *Call) anyerror!void {
    try headers.sendError(call.res, 501, "not_implemented");
}

/// `GET /api/health`, http.ts:177-183; the body comes from health.zig.
pub fn health(call: *Call) anyerror!void {
    const body = try health_body.body(call.res.arena, &call.services.health.instance_id);
    call.res.body = body;
    call.res.header("content-type", "application/json");
}

pub fn getHalt(call: *Call) anyerror!void {
    const manager = call.services.manager orelse return notImplemented(call);
    try headers.sendJson(call.res, .{ .halted = try manager.isHalted() });
}

pub fn postHalt(call: *Call) anyerror!void {
    const manager = call.services.manager orelse return notImplemented(call);
    const actor = call.actor orelse return headers.sendError(call.res, 401, "unauthorized");
    if (!try session_endpoints.requireStepUp(call.res, actor, ids.nowMs(call.services.app.io))) return;
    const bytes = call.req.body() orelse return headers.sendError(call.res, 400, "invalid body");
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, call.res.arena, bytes, .{
        .duplicate_field_behavior = .use_last,
        .ignore_unknown_fields = true,
    }) catch return headers.sendError(call.res, 400, "invalid body");
    const halted = switch (parsed) {
        .object => |obj| switch (obj.get("halted") orelse return headers.sendError(call.res, 400, "invalid body")) {
            .bool => |value| value,
            else => return headers.sendError(call.res, 400, "invalid body"),
        },
        else => return headers.sendError(call.res, 400, "invalid body"),
    };
    try manager.setHalted(halted);
    try headers.sendJson(call.res, .{ .halted = halted });
}

pub const table = [_]Route{
    .{ .method = .GET, .path = "/api/health", .handler = health, .policy = .{ .public = true, .loopback = true } },
    .{ .method = .GET, .path = "/api/agents", .handler = agents.list, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/agents/:id/link", .handler = agents.link, .policy = .{ .session = true, .admin = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/agents/:id/login", .handler = agents.login, .policy = .{ .session = true, .admin = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/agents/:id/models", .handler = agents.refreshModels, .policy = .{ .session = true, .admin = true, .origin = true } },
    .{ .method = .GET, .path = "/api/agents/keys", .handler = agents.keyStatus, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/agents/keys/:provider", .handler = agents.keySave, .policy = .{ .session = true, .admin = true, .step_up = true, .origin = true } },
    .{ .method = .GET, .path = "/api/agents/ollaya", .handler = agents.ollayaStatus, .policy = .{ .session = true, .admin = true } },
    .{ .method = .GET, .path = "/api/approvals", .handler = guard_routes.list, .policy = .{ .session = true } },
    .{ .method = .POST, .path = "/api/approvals/:id", .handler = guard_routes.decide, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/email/request", .handler = auth_routes.emailRequest, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/email/verify", .handler = auth_routes.emailVerify, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/enroll/:code/options", .handler = auth_routes.enrollOptions, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/enroll/:code/verify", .handler = auth_routes.enrollVerify, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/login/options", .handler = auth_routes.loginOptions, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/login/verify", .handler = auth_routes.loginVerify, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/logout", .handler = session_endpoints.logout, .policy = .{ .session = true, .origin = true } },
    .{ .method = .GET, .path = "/api/auth/me", .handler = session_endpoints.me, .policy = .{ .session = true } },
    .{ .method = .GET, .path = "/api/auth/passkeys", .handler = auth_routes.passkeyList, .policy = .{ .session = true } },
    .{ .method = .DELETE, .path = "/api/auth/passkeys/:id", .handler = auth_routes.passkeyDelete, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/passkeys/options", .handler = auth_routes.passkeyOptions, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/passkeys/verify", .handler = auth_routes.passkeyVerify, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/recovery", .handler = auth_routes.recovery, .policy = .{ .public = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/recovery/regenerate", .handler = auth_routes.recoveryRegenerate, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .GET, .path = "/api/auth/sessions", .handler = auth_routes.sessionList, .policy = .{ .session = true } },
    .{ .method = .DELETE, .path = "/api/auth/sessions/:id", .handler = auth_routes.sessionDelete, .policy = .{ .session = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/step-up/options", .handler = auth_routes.stepUpOptions, .policy = .{ .session = true, .origin = true } },
    .{ .method = .POST, .path = "/api/auth/step-up/verify", .handler = auth_routes.stepUpVerify, .policy = .{ .session = true, .origin = true } },
    row(.GET, "/api/channels/:id/members", .{ .session = true }),
    row(.GET, "/api/channels/:id/messages", .{ .session = true }),
    row(.POST, "/api/channels/:id/messages", .{ .session = true, .origin = true }),
    row(.POST, "/api/channels/:id/read", .{ .session = true, .origin = true }),
    .{ .method = .GET, .path = "/api/halt", .handler = getHalt, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/halt", .handler = postHalt, .policy = .{ .session = true, .admin = true, .step_up = true, .origin = true } },
    row(.POST, "/api/members/:id/wake", .{ .session = true, .origin = true }),
    .{ .method = .GET, .path = "/api/orgs", .handler = orgs.list, .policy = .{ .session = true } },
    .{ .method = .POST, .path = "/api/orgs", .handler = orgs.create, .policy = .{ .session = true, .origin = true } },
    .{ .method = .GET, .path = "/api/orgs/:org", .handler = orgs.detail, .policy = .{ .session = true } },
    row(.GET, "/api/orgs/:org/budgets", .{ .session = true }),
    row(.PUT, "/api/orgs/:org/budgets", .{ .session = true, .step_up = true, .origin = true }),
    row(.DELETE, "/api/orgs/:org/budgets/:id", .{ .session = true, .step_up = true, .origin = true }),
    row(.GET, "/api/orgs/:org/channels", .{ .session = true }),
    row(.GET, "/api/orgs/:org/dashboard", .{ .session = true }),
    row(.POST, "/api/orgs/:org/dms", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/groups", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/hires", .{ .session = true }),
    row(.POST, "/api/orgs/:org/hires", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/hires/:id", .{ .session = true }),
    row(.POST, "/api/orgs/:org/hires/:id/decide", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/hires/:id/score/:candidate", .{ .session = true, .origin = true }),
    .{ .method = .DELETE, .path = "/api/orgs/:org/members/:id", .handler = orgs.removeMember, .policy = .{ .session = true, .origin = true } },
    .{ .method = .PATCH, .path = "/api/orgs/:org/members/:id", .handler = orgs.patchMember, .policy = .{ .session = true, .origin = true } },
    row(.GET, "/api/orgs/:org/members/:id/profile", .{ .session = true }),
    row(.PUT, "/api/orgs/:org/members/:id/profile", .{ .session = true, .step_up = true, .origin = true }),
    row(.PUT, "/api/orgs/:org/members/:id/profile/card", .{ .session = true, .origin = true }),
    .{ .method = .POST, .path = "/api/orgs/:org/members/agents", .handler = orgs.addAgent, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/orgs/:org/members/humans", .handler = orgs.addHuman, .policy = .{ .session = true, .origin = true } },
    row(.DELETE, "/api/orgs/:org/policies", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/policies", .{ .session = true }),
    row(.PUT, "/api/orgs/:org/policies", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/policy-proposals", .{ .session = true }),
    row(.POST, "/api/orgs/:org/policy-proposals/:id/decide", .{ .session = true, .origin = true }),
    .{ .method = .POST, .path = "/api/orgs/:org/positions", .handler = orgs.createPosition, .policy = .{ .session = true, .origin = true } },
    .{ .method = .PATCH, .path = "/api/orgs/:org/positions/:id", .handler = orgs.patchPosition, .policy = .{ .session = true, .origin = true } },
    .{ .method = .POST, .path = "/api/orgs/:org/projects", .handler = orgs.createProject, .policy = .{ .session = true, .origin = true } },
    .{ .method = .POST, .path = "/api/orgs/:org/teams", .handler = orgs.createTeam, .policy = .{ .session = true, .origin = true } },
    .{ .method = .POST, .path = "/api/orgs/:org/teams/:id/members", .handler = orgs.addTeamMember, .policy = .{ .session = true, .origin = true } },
    row(.GET, "/api/orgs/:org/wakeups", .{ .session = true }),
    row(.PUT, "/api/policies/harness", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.GET, "/api/projects/:id/deps", .{ .session = true }),
    .{ .method = .DELETE, .path = "/api/projects/:id/grants", .handler = orgs.revoke, .policy = .{ .session = true, .step_up = true, .origin = true } },
    .{ .method = .POST, .path = "/api/projects/:id/grants", .handler = orgs.grant, .policy = .{ .session = true, .step_up = true, .origin = true } },
    row(.GET, "/api/projects/:id/members", .{ .session = true }),
    row(.GET, "/api/projects/:id/tasks", .{ .session = true }),
    row(.POST, "/api/projects/:id/tasks", .{ .session = true, .origin = true }),
    .{ .method = .GET, .path = "/api/quota", .handler = usage_routes.getQuota, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/quota", .handler = usage_routes.postQuota, .policy = .{ .session = true, .admin = true, .origin = true } },
    row(.GET, "/api/router/registry", .{ .session = true, .admin = true }),
    row(.POST, "/api/router/registry/refresh", .{ .session = true, .admin = true, .origin = true }),
    row(.GET, "/api/router/route", .{ .session = true, .admin = true }),
    .{ .method = .GET, .path = "/api/runs", .handler = runtime_routes.list, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/runs", .handler = runtime_routes.start, .policy = .{ .session = true, .admin = true, .step_up = true, .origin = true } },
    .{ .method = .GET, .path = "/api/runs/:id", .handler = runtime_routes.detail, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/runs/:id/kill", .handler = runtime_routes.kill, .policy = .{ .session = true, .admin = true, .step_up = true, .origin = true } },
    .{ .method = .GET, .path = "/api/search", .handler = logs_api.search, .policy = .{ .session = true, .admin = true } },
    row(.GET, "/api/tasks/:id", .{ .session = true }),
    row(.PATCH, "/api/tasks/:id", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/checkout", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/comments", .{ .session = true, .origin = true }),
    row(.DELETE, "/api/tasks/:id/deps", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/deps", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/move", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/release", .{ .session = true, .origin = true }),
    .{ .method = .GET, .path = "/api/usage", .handler = usage_routes.getUsage, .policy = .{ .session = true, .admin = true } },
    .{ .method = .POST, .path = "/api/guard/hook", .handler = guard_routes.hook, .policy = .{ .public = true, .loopback = true } },
    .{ .method = .any, .path = "/mcp", .handler = mcp.handle, .policy = .{ .public = true, .loopback = true } },
    .{ .method = .GET, .path = "/ws", .handler = ws.upgrade, .policy = .{ .session = true, .origin = true } },
};
