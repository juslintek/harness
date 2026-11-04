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
};

/// One request as a handler sees it. `actor` is set for every row that went through the session
/// gate and null for public and loopback rows.
pub const Call = struct {
    services: *const Services,
    req: *httpz.Request,
    res: *httpz.Response,
    actor: ?Actor,
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

pub const table = [_]Route{
    .{ .method = .GET, .path = "/api/health", .handler = health, .policy = .{ .public = true, .loopback = true } },
    row(.GET, "/api/agents", .{ .session = true, .admin = true }),
    row(.POST, "/api/agents/:id/link", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.POST, "/api/agents/:id/login", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.POST, "/api/agents/:id/models", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.GET, "/api/agents/keys", .{ .session = true, .admin = true }),
    row(.POST, "/api/agents/keys/:provider", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.GET, "/api/agents/ollaya", .{ .session = true, .admin = true }),
    row(.GET, "/api/approvals", .{ .session = true }),
    row(.POST, "/api/approvals/:id", .{ .session = true, .step_up = true, .origin = true }),
    row(.POST, "/api/auth/email/request", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/email/verify", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/enroll/:code/options", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/enroll/:code/verify", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/login/options", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/login/verify", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/logout", .{ .session = true, .origin = true }),
    row(.GET, "/api/auth/me", .{ .session = true }),
    row(.GET, "/api/auth/passkeys", .{ .session = true }),
    row(.DELETE, "/api/auth/passkeys/:id", .{ .session = true, .step_up = true, .origin = true }),
    row(.POST, "/api/auth/passkeys/options", .{ .session = true, .step_up = true, .origin = true }),
    row(.POST, "/api/auth/passkeys/verify", .{ .session = true, .step_up = true, .origin = true }),
    row(.POST, "/api/auth/recovery", .{ .public = true, .origin = true }),
    row(.POST, "/api/auth/recovery/regenerate", .{ .session = true, .step_up = true, .origin = true }),
    row(.GET, "/api/auth/sessions", .{ .session = true }),
    row(.DELETE, "/api/auth/sessions/:id", .{ .session = true, .origin = true }),
    row(.POST, "/api/auth/step-up/options", .{ .session = true, .origin = true }),
    row(.POST, "/api/auth/step-up/verify", .{ .session = true, .origin = true }),
    row(.GET, "/api/channels/:id/members", .{ .session = true }),
    row(.GET, "/api/channels/:id/messages", .{ .session = true }),
    row(.POST, "/api/channels/:id/messages", .{ .session = true, .origin = true }),
    row(.POST, "/api/channels/:id/read", .{ .session = true, .origin = true }),
    row(.GET, "/api/halt", .{ .session = true, .admin = true }),
    row(.POST, "/api/halt", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.POST, "/api/members/:id/wake", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs", .{ .session = true }),
    row(.POST, "/api/orgs", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org", .{ .session = true }),
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
    row(.DELETE, "/api/orgs/:org/members/:id", .{ .session = true, .origin = true }),
    row(.PATCH, "/api/orgs/:org/members/:id", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/members/:id/profile", .{ .session = true }),
    row(.PUT, "/api/orgs/:org/members/:id/profile", .{ .session = true, .step_up = true, .origin = true }),
    row(.PUT, "/api/orgs/:org/members/:id/profile/card", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/members/agents", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/members/humans", .{ .session = true, .origin = true }),
    row(.DELETE, "/api/orgs/:org/policies", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/policies", .{ .session = true }),
    row(.PUT, "/api/orgs/:org/policies", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/policy-proposals", .{ .session = true }),
    row(.POST, "/api/orgs/:org/policy-proposals/:id/decide", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/positions", .{ .session = true, .origin = true }),
    row(.PATCH, "/api/orgs/:org/positions/:id", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/projects", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/teams", .{ .session = true, .origin = true }),
    row(.POST, "/api/orgs/:org/teams/:id/members", .{ .session = true, .origin = true }),
    row(.GET, "/api/orgs/:org/wakeups", .{ .session = true }),
    row(.PUT, "/api/policies/harness", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.GET, "/api/projects/:id/deps", .{ .session = true }),
    row(.DELETE, "/api/projects/:id/grants", .{ .session = true, .origin = true }),
    row(.POST, "/api/projects/:id/grants", .{ .session = true, .origin = true }),
    row(.GET, "/api/projects/:id/members", .{ .session = true }),
    row(.GET, "/api/projects/:id/tasks", .{ .session = true }),
    row(.POST, "/api/projects/:id/tasks", .{ .session = true, .origin = true }),
    row(.GET, "/api/quota", .{ .session = true, .admin = true }),
    row(.POST, "/api/quota", .{ .session = true, .admin = true, .origin = true }),
    row(.GET, "/api/router/registry", .{ .session = true, .admin = true }),
    row(.POST, "/api/router/registry/refresh", .{ .session = true, .admin = true, .origin = true }),
    row(.GET, "/api/router/route", .{ .session = true, .admin = true }),
    row(.GET, "/api/runs", .{ .session = true, .admin = true }),
    row(.POST, "/api/runs", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.GET, "/api/runs/:id", .{ .session = true, .admin = true }),
    row(.POST, "/api/runs/:id/kill", .{ .session = true, .admin = true, .step_up = true, .origin = true }),
    row(.GET, "/api/search", .{ .session = true, .admin = true }),
    row(.GET, "/api/tasks/:id", .{ .session = true }),
    row(.PATCH, "/api/tasks/:id", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/checkout", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/comments", .{ .session = true, .origin = true }),
    row(.DELETE, "/api/tasks/:id/deps", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/deps", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/move", .{ .session = true, .origin = true }),
    row(.POST, "/api/tasks/:id/release", .{ .session = true, .origin = true }),
    row(.GET, "/api/usage", .{ .session = true, .admin = true }),
    row(.POST, "/api/guard/hook", .{ .public = true, .loopback = true }),
    row(.any, "/mcp", .{ .public = true, .loopback = true }),
    row(.GET, "/ws", .{ .session = true, .origin = true }),
};
