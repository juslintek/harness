//! The agents HTTP routes, routes.ts and the state of api.ts: list, link, login, models, key
//! status and key save, and the Ollaya probe. `Ctx` holds what api.ts keeps in module variables
//! (discovery cache, logins in flight, probes in flight) plus the specs and the secrets store.
//! Everything behind `/api/agents` needs an instance admin; the session gate has checked that.
const std = @import("std");
const app_mod = @import("../app.zig");
const middleware = @import("../auth/middleware.zig");
const headers = @import("../http/headers.zig");
const routes = @import("../http/routes.zig");
const ids = @import("../ids.zig");
const process_mod = @import("../runtimes/process.zig");
const sqlite = @import("../db/sqlite.zig");
const discover = @import("discover.zig");
const keys = @import("keys.zig");
const models_mod = @import("models.zig");
const ollaya = @import("ollaya.zig");
const runner_mod = @import("runner.zig");
const specs_mod = @import("specs.zig");

const App = app_mod.App;
const State = app_mod.State;
const Io = std.Io;
const Spec = specs_mod.Spec;

/// `CACHE_MS`
const cache_ms: i64 = 60_000;
/// `LOGIN_TIMEOUT_MS`
const login_timeout_ms: i64 = 600_000;

pub const Ctx = struct {
    gpa: std.mem.Allocator,
    io: Io,
    /// The harness home (HARNESS_HOME, expanded); outlives the context.
    home: []const u8,
    /// The server's environment; outlives the context.
    env: *const std.process.Environ.Map,
    specs: []const Spec,
    specs_arena: std.heap.ArenaAllocator,
    process_runner: runner_mod.ProcessRunner,
    /// What discovery, models and the key store run commands through; tests swap it.
    runner: runner_mod.Runner,
    keys: keys.Store,
    flights: models_mod.Flights = .{},
    /// Hooked up by the runtimes slice; without it the ACP model probe answers 502.
    list_acp: ?models_mod.ListAcp = null,
    probe_timeout_ms: i64 = discover.probe_timeout_ms,
    login_timeout_ms: i64 = login_timeout_ms,
    /// SIGTERM to SIGKILL for a login that outlives its timeout.
    login_grace_ms: i64 = runner_mod.kill_grace_ms,
    ollaya_timeout_ms: i64 = ollaya.health_timeout_ms,
    /// Guards `cache` and `logins`.
    mutex: Io.Mutex = .init,
    cache: ?discover.Snapshot = null,
    /// Agent ids with a login command running; the keys are spec ids and live as long as the specs.
    logins: std.StringHashMapUnmanaged(void) = .empty,
    login_tasks: Io.Group = .init,

    /// On the heap: the pieces point at each other. `home` and `env` must outlive the result.
    pub fn create(gpa: std.mem.Allocator, io: Io, home: []const u8, env: *const std.process.Environ.Map) !*Ctx {
        const self = try gpa.create(Ctx);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .io = io,
            .home = home,
            .env = env,
            .specs = &.{},
            .specs_arena = .init(gpa),
            .process_runner = .{ .gpa = gpa, .io = io, .base_env = env },
            // `runner()` only takes the address, which is final: `self` is on the heap.
            .runner = runner_mod.ProcessRunner.runner(&self.process_runner),
            .keys = .{ .gpa = gpa, .io = io, .home = home, .env = env, .runner = runner_mod.ProcessRunner.runner(&self.process_runner) },
        };
        errdefer self.specs_arena.deinit();
        const arena = self.specs_arena.allocator();
        const paths: specs_mod.Paths = .{ .adapter_dir = try adapterDir(arena, io), .home = env.get("HOME") orelse "" };
        self.specs = try specs_mod.load(arena, env, try specs_mod.builtin(arena, paths));
        return self;
    }

    /// Where `code/node_modules/.bin` is, from the binary's place in the repo (`zig/zig-out/bin`).
    fn adapterDir(arena: std.mem.Allocator, io: Io) ![]const u8 {
        const exe_dir = std.process.executableDirPathAlloc(io, arena) catch return "node_modules/.bin";
        return std.fs.path.resolve(arena, &.{ exe_dir, "../../../code/node_modules/.bin" });
    }

    /// Commands of discovery, models and the key store go through this runner.
    pub fn setRunner(self: *Ctx, runner: runner_mod.Runner) void {
        self.runner = runner;
        self.keys.runner = runner;
    }

    pub fn destroy(self: *Ctx) void {
        self.login_tasks.cancel(self.io);
        if (self.cache) |*snapshot| snapshot.deinit();
        self.logins.deinit(self.gpa);
        self.flights.deinit(self.gpa);
        self.specs_arena.deinit();
        self.gpa.destroy(self);
    }

    fn probe(self: *const Ctx) discover.Probe {
        const key = self.env.get("GEMINI_API_KEY");
        return .{ .runner = self.runner, .timeout_ms = self.probe_timeout_ms, .gemini_key = key != null and key.?.len > 0 };
    }

    /// `discovered`: the cached pass while it is under a minute old, else a new one. The answer is a
    /// copy in `arena`, so a pass that replaces the cache meanwhile does not pull it away.
    fn discovered(self: *Ctx, arena: std.mem.Allocator) ![]discover.Discovered {
        const started = ids.nowMs(self.io);
        {
            self.mutex.lockUncancelable(self.io);
            defer self.mutex.unlock(self.io);
            if (self.cache) |*snapshot| if (started - snapshot.at <= cache_ms) return snapshot.cloneInto(arena);
        }
        var fresh = try discover.discoverAll(self.gpa, self.io, self.probe(), self.specs, started);
        errdefer fresh.deinit();
        const answer = try fresh.cloneInto(arena);
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.cache) |*old| old.deinit();
        self.cache = fresh;
        return answer;
    }

    fn invalidate(self: *Ctx) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.cache) |*snapshot| snapshot.deinit();
        self.cache = null;
    }
};

// ---- GET /api/agents ----

const View = struct {
    id: []const u8,
    name: []const u8,
    lane: []const u8,
    installed: bool,
    path: ?[]const u8,
    version: ?[]const u8,
    loggedIn: ?bool,
    @"error": ?[]const u8,
    canLogin: bool,
    enabled: bool,
    models: []const models_mod.Model,
};

const Link = struct { agent_id: []const u8, enabled: bool };
const ModelRow = struct { agent_id: []const u8, model: models_mod.Model };
const Stored = struct { links: []const Link, models: []const ModelRow };

const LoadError = sqlite.Error || std.mem.Allocator.Error || error{NoDatabase};

fn loadLocked(arena: *const std.mem.Allocator, state: *State) LoadError!Stored {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const a = arena.*;
    var links: std.ArrayList(Link) = .empty;
    {
        const stmt = try db.prepare("SELECT agent_id, enabled FROM agent_links");
        defer stmt.finalize();
        while (try stmt.step()) try links.append(a, .{
            .agent_id = try stmt.textAlloc(a, 0) orelse return error.Step,
            .enabled = stmt.int(1) == 1,
        });
    }
    var rows: std.ArrayList(ModelRow) = .empty;
    {
        const stmt = try db.prepare("SELECT agent_id, model_id, name FROM agent_models ORDER BY name");
        defer stmt.finalize();
        while (try stmt.step()) try rows.append(a, .{
            .agent_id = try stmt.textAlloc(a, 0) orelse return error.Step,
            .model = .{
                .id = try stmt.textAlloc(a, 1) orelse return error.Step,
                .name = try stmt.textAlloc(a, 2) orelse return error.Step,
            },
        });
    }
    return .{ .links = links.items, .models = rows.items };
}

/// `listAgents`
fn listViews(ctx: *Ctx, app: *App, arena: std.mem.Allocator) ![]const View {
    const found = try ctx.discovered(arena);
    const stored = try app.withLock(&arena, loadLocked);
    const views = try arena.alloc(View, ctx.specs.len);
    for (ctx.specs, views) |spec, *view| {
        var info: ?discover.Discovered = null;
        for (found) |item| if (std.mem.eql(u8, item.id, spec.id)) {
            info = item;
            break;
        };
        var enabled = false;
        for (stored.links) |stored_link| if (std.mem.eql(u8, stored_link.agent_id, spec.id)) {
            enabled = stored_link.enabled;
            break;
        };
        var own: std.ArrayList(models_mod.Model) = .empty;
        for (stored.models) |row| if (std.mem.eql(u8, row.agent_id, spec.id)) try own.append(arena, row.model);
        view.* = .{
            .id = spec.id,
            .name = spec.name,
            .lane = @tagName(spec.lane),
            .installed = if (info) |item| item.installed else false,
            .path = if (info) |item| item.path else null,
            .version = if (info) |item| item.version else null,
            .loggedIn = if (info) |item| item.logged_in else null,
            .@"error" = if (info) |item| item.err else null,
            .canLogin = spec.login_args != null,
            .enabled = enabled,
            .models = own.items,
        };
    }
    return views;
}

fn context(call: *routes.Call) ?*Ctx {
    return call.services.agents;
}

pub fn list(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    try headers.sendJson(call.res, try listViews(ctx, call.services.app, call.res.arena));
}

// ---- keys ----

const KeyStatusOut = struct { provider: []const u8, source: ?[]const u8, legacyLeft: bool };

pub fn keyStatus(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    const arena = call.res.arena;
    var diag: keys.Diag = .{};
    const status = ctx.keys.status(arena, &diag) catch |err| return keysFailure(call.res, err, diag);
    const out = try arena.alloc(KeyStatusOut, status.len);
    for (status, out) |entry, *slot| slot.* = .{
        .provider = @tagName(entry.provider),
        .source = if (entry.source) |source| @tagName(source) else null,
        .legacyLeft = entry.legacy_left,
    };
    try headers.sendJson(call.res, out);
}

/// A plain `Error` in TS is a 400 with its message (`routeError`); anything else is a 500.
fn keysFailure(res: *@import("httpz").Response, err: anyerror, diag: keys.Diag) anyerror!void {
    if (err == error.StoreRefused) return headers.sendError(res, 400, diag.message);
    return err;
}

/// `/^[\x20-\x7e]{20,400}$/`
fn validKey(key: []const u8) bool {
    if (key.len < 20 or key.len > 400) return false;
    for (key) |byte| if (byte < 0x20 or byte > 0x7e) return false;
    return true;
}

fn freshStepUp(call: *routes.Call) !bool {
    const actor = call.actor orelse return error.Unauthorized;
    return middleware.requireStepUp(call.res, actor, ids.nowMs(call.services.app.io));
}

pub fn keySave(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    if (!try freshStepUp(call)) return;
    const name = call.req.param("provider") orelse return headers.sendError(call.res, 404, "unknown provider");
    const provider = std.meta.stringToEnum(keys.Provider, name) orelse return headers.sendError(call.res, 404, "unknown provider");
    const Body = struct { key: []const u8 };
    const body = headers.parseBody(Body, call.req) catch return headers.sendError(call.res, 400, "invalid key");
    if (!validKey(body.key)) return headers.sendError(call.res, 400, "invalid key");
    var diag: keys.Diag = .{};
    ctx.keys.put(call.res.arena, &diag, provider, body.key) catch |err| return keysFailure(call.res, err, diag);
    try headers.sendJson(call.res, .{ .ok = true });
}

pub fn ollayaStatus(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    const base = ctx.env.get("OLLAYA_URL") orelse ollaya.default_url;
    const answer = try ollaya.status(ctx.gpa, call.res.arena, ctx.io, base, ctx.ollaya_timeout_ms);
    try headers.sendJson(call.res, .{ .up = answer.up, .version = answer.version });
}

// ---- link ----

const LinkArgs = struct { id: []const u8, enabled: bool, now: i64 };

fn linkLocked(args: *const LinkArgs, state: *State) LoadError!void {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    const stmt = try db.prepare(
        \\INSERT INTO agent_links (agent_id, enabled, updated_at) VALUES (?, ?, ?)
        \\ ON CONFLICT(agent_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    );
    defer stmt.finalize();
    try stmt.bindText(1, args.id);
    try stmt.bindInt(2, @intFromBool(args.enabled));
    try stmt.bindInt(3, args.now);
    _ = try stmt.step();
}

pub fn link(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    if (!try freshStepUp(call)) return;
    const spec = findSpec(ctx, call) orelse return headers.sendError(call.res, 404, "unknown agent");
    const Body = struct { enabled: bool };
    const body = try headers.parseBody(Body, call.req);
    const app = call.services.app;
    try app.withLock(&LinkArgs{ .id = spec.id, .enabled = body.enabled, .now = ids.nowMs(app.io) }, linkLocked);
    try headers.sendJson(call.res, .{ .ok = true });
}

fn findSpec(ctx: *const Ctx, call: *routes.Call) ?*const Spec {
    return specs_mod.find(ctx.specs, call.req.param("id") orelse return null);
}

// ---- models ----

pub fn refreshModels(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    const app = call.services.app;
    const id = call.req.param("id") orelse return headers.sendError(call.res, 404, "unknown agent");
    const deps: models_mod.Deps = .{ .app = app, .specs = ctx.specs, .runner = ctx.runner, .list_acp = ctx.list_acp };
    const outcome = try ctx.flights.refresh(ctx.gpa, ctx.io, call.res.arena, deps, id, ids.nowMs(ctx.io));
    switch (outcome) {
        .models => |found| try headers.sendJson(call.res, .{ .models = found }),
        .refused => |refused| try headers.sendError(call.res, refused.status, refused.message),
        .conflict => try headers.sendError(call.res, 409, "conflict"),
    }
}

// ---- login ----

const LoginStart = union(enum) {
    started: []const []const u8,
    failed: []const u8,
};

const LoginRun = struct {
    ctx: *Ctx,
    child: std.process.Child,
    /// The leader's pid, which is the id of its group. `child.id` is cleared by a finished wait.
    pgid: std.posix.pid_t,
    id: []const u8,
    timeout_ms: i64,
};

const LoginEvent = union(enum) {
    exited: std.process.Child.WaitError!std.process.Child.Term,
    timeout: Io.Cancelable!void,
    grace: Io.Cancelable!void,
};

fn waitChild(io: Io, child: *std.process.Child) std.process.Child.WaitError!std.process.Child.Term {
    return child.wait(io);
}

fn sleepMs(io: Io, ms: i64) Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

/// Waits for the login command, ends its group when it outlives the timeout, then forgets it.
fn watchLogin(run: *LoginRun) void {
    const ctx = run.ctx;
    const io = ctx.io;
    defer finishLogin(run);
    var buffer: [3]LoginEvent = undefined;
    var select: Io.Select(LoginEvent) = .init(io, &buffer);
    defer select.cancelDiscard();
    // The wait goes last: if it cannot start, the child is untouched and `finishLogin` ends it.
    // A cancelled wait would leave the child unreaped, so it is never cancelled while it runs.
    select.concurrent(.timeout, sleepMs, .{ io, run.timeout_ms }) catch return;
    select.concurrent(.exited, waitChild, .{ io, &run.child }) catch return;
    while (true) {
        const event = select.await() catch {
            // Shutdown: end the command and let the wait finish.
            const previous = io.swapCancelProtection(.blocked);
            defer _ = io.swapCancelProtection(previous);
            process_mod.signalGroup(run.pgid, .KILL);
            while (true) switch (select.await() catch return) {
                .exited => return,
                .timeout, .grace => {},
            };
        };
        switch (event) {
            .exited => return,
            .timeout => |result| {
                result catch return;
                // `proc.kill()` in TS; the whole group here, as the login CLIs spawn helpers.
                process_mod.signalGroup(run.pgid, .TERM);
                // TS stops at SIGTERM; a CLI that ignores it would live on, so the group is killed
                // after the grace, as `ProcessRunner` does. Never return with the wait running.
                select.concurrent(.grace, sleepMs, .{ io, ctx.login_grace_ms }) catch process_mod.signalGroup(run.pgid, .KILL);
            },
            .grace => |result| {
                result catch return;
                process_mod.signalGroup(run.pgid, .KILL);
            },
        }
    }
}

fn finishLogin(run: *LoginRun) void {
    const ctx = run.ctx;
    // Also the cleanup of a cancelled watcher: the command must be ended and reaped even then.
    const previous = ctx.io.swapCancelProtection(.blocked);
    defer _ = ctx.io.swapCancelProtection(previous);
    // Only a watcher that never started its wait gets here with a live child.
    if (run.child.id != null) {
        process_mod.signalGroup(run.pgid, .KILL);
        run.child.kill(ctx.io);
    }
    ctx.mutex.lockUncancelable(ctx.io);
    _ = ctx.logins.remove(run.id);
    if (ctx.cache) |*snapshot| snapshot.deinit();
    ctx.cache = null;
    ctx.mutex.unlock(ctx.io);
    ctx.gpa.destroy(run);
}

/// `startLogin`: a second request while one runs gets the same command back.
fn startLogin(ctx: *Ctx, arena: std.mem.Allocator, spec: *const Spec) !LoginStart {
    const command = spec.login_args.?;
    ctx.mutex.lockUncancelable(ctx.io);
    defer ctx.mutex.unlock(ctx.io);
    if (ctx.logins.contains(spec.id)) return .{ .started = command };
    var child = std.process.spawn(ctx.io, .{
        .argv = command,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = 0,
    }) catch return .{ .failed = try std.fmt.allocPrint(arena, "{s} could not be started, is it installed?", .{command[0]}) };
    errdefer {
        if (child.id) |pid| process_mod.signalGroup(pid, .KILL);
        child.kill(ctx.io);
    }
    const run = try ctx.gpa.create(LoginRun);
    errdefer ctx.gpa.destroy(run);
    run.* = .{ .ctx = ctx, .child = child, .pgid = child.id.?, .id = spec.id, .timeout_ms = ctx.login_timeout_ms };
    try ctx.logins.put(ctx.gpa, spec.id, {});
    errdefer _ = ctx.logins.remove(spec.id);
    try ctx.login_tasks.concurrent(ctx.io, watchLogin, .{run});
    return .{ .started = command };
}

pub fn login(call: *routes.Call) anyerror!void {
    const ctx = context(call) orelse return routes.notImplemented(call);
    if (!try freshStepUp(call)) return;
    const spec = findSpec(ctx, call) orelse return headers.sendError(call.res, 404, "no login command");
    if (spec.login_args == null) return headers.sendError(call.res, 404, "no login command");
    switch (try startLogin(ctx, call.res.arena, spec)) {
        .started => |command| try headers.sendJson(call.res, .{ .command = command }),
        .failed => |message| try headers.sendError(call.res, 409, message),
    }
}

test {
    _ = @import("routes_test.zig");
}
