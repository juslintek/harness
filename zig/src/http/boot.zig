//! Boot of `harness serve`, in the order of main.ts: create the home, take the home lock, open the
//! database, run the migrations, make sure the instance row exists, and only then listen. Teardown
//! is the reverse: the listener stops first, then the database goes away, then the lock is released.
const std = @import("std");
const App = @import("../app.zig").App;
const State = @import("../app.zig").State;
const c = @import("../db/c.zig");
const config_mod = @import("../config.zig");
const health = @import("../health.zig");
const ids = @import("../ids.zig");
const lock = @import("../db/lock.zig");
const migrate = @import("../db/migrate.zig");
const sqlite = @import("../db/sqlite.zig");
const routes = @import("routes.zig");
const server = @import("server.zig");
const auth = @import("../auth/middleware.zig");
const enroll = @import("../auth/enroll.zig");
const auth_routes = @import("../auth/routes.zig");
const agents = @import("../agents/routes.zig");
const codes = @import("../auth/codes.zig");
const orgs_repo = @import("../orgs/repo.zig");
const hub_mod = @import("../realtime/hub.zig");
const runtime_manager = @import("../runtimes/manager.zig");
const runtime_routes = @import("../runtimes/routes.zig");
const runtime_types = @import("../runtimes/types.zig");
const logs_api = @import("../logs/api.zig");
const usage_summary = @import("../usage/summary.zig");
const usage_quota = @import("../usage/quota.zig");
const ws = @import("ws.zig");
const usage_boot = @import("../usage/boot.zig");
const approvals = @import("../guard/approvals.zig");

const RuntimeLinks = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    app: *App,
    hub: *hub_mod.Hub,
    event_mutex: std.Io.Mutex = .init,
};

fn publishRunEvent(ctx: ?*anyopaque, event: runtime_types.NewEvent) void {
    const links: *RuntimeLinks = @ptrCast(@alignCast(ctx orelse return));
    const id = event.run_id orelse return;
    links.event_mutex.lockUncancelable(links.io);
    defer links.event_mutex.unlock(links.io);
    var arena: std.heap.ArenaAllocator = .init(links.gpa);
    defer arena.deinit();
    const topic = std.fmt.allocPrint(arena.allocator(), "run:{s}", .{id}) catch |err| {
        std.log.warn("run {s}: realtime topic allocation failed: {t}", .{ id, err });
        return;
    };
    _ = links.hub.registry.publish(topic, .{ .event = .{ .run_id = id, .kind = @tagName(event.kind), .ts = event.ts } }) catch |err| {
        std.log.warn("run {s}: realtime event publish failed: {t}", .{ id, err });
    };
    if (runtime_routes.viewJson(arena.allocator(), links.app, id)) |json| {
        if (json) |view_json| _ = links.hub.registry.publish("runs", .{ .run = .{ .view_json = view_json } }) catch |err| {
            std.log.warn("run {s}: realtime view publish failed: {t}", .{ id, err });
        };
    } else |err| {
        std.log.warn("run {s}: realtime view query failed: {t}", .{ id, err });
    }
}

fn recordRunQuota(ctx: ?*anyopaque, db: sqlite.Db, agent: []const u8, quota: runtime_types.Quota) anyerror!void {
    const links: *RuntimeLinks = @ptrCast(@alignCast(ctx orelse return error.MissingRuntimeLinks));
    try usage_quota.insertSnapshot(db, links.io, .{
        .provider = agent,
        .window = @tagName(quota.window),
        .used_percent = quota.used_percent,
        .resets_at = quota.resets_at,
        .source = "acp",
    }, ids.nowMs(links.io));
}

fn recordRunUsage(ctx: ?*anyopaque, db: sqlite.Db, run_id: []const u8, agent: []const u8, conversation_id: ?[]const u8, usage: []const runtime_types.UsageRecord) anyerror!void {
    const links: *RuntimeLinks = @ptrCast(@alignCast(ctx orelse return error.MissingRuntimeLinks));
    try usage_summary.recordUsage(links.io, db, run_id, agent, conversation_id, "acp", usage, ids.nowMs(links.io));
}

/// What a running server owns on disk. On the heap because `app` holds a mutex that must not move.
pub const Home = struct {
    gpa: std.mem.Allocator,
    dir: std.Io.Dir,
    home_lock: lock.HomeLock,
    db: sqlite.Db,
    app: App,
    health: routes.Health,
    /// `PRAGMA user_version` after the migrations ran.
    schema_version: i64,

    pub fn open(gpa: std.mem.Allocator, io: std.Io, path: []const u8, held: *lock.Held) !*Home {
        const cwd = std.Io.Dir.cwd();
        try cwd.createDirPath(io, path);
        const self = try gpa.create(Home);
        errdefer gpa.destroy(self);
        self.gpa = gpa;
        self.dir = try cwd.openDir(io, path, .{});
        errdefer self.dir.close(io);
        self.home_lock = try lock.acquire(io, self.dir, held);
        errdefer self.home_lock.release();

        const db_path = try std.fmt.allocPrint(gpa, "{s}/harness.db", .{path});
        defer gpa.free(db_path);
        self.db = try sqlite.Db.open(gpa, db_path);
        errdefer self.db.close();
        self.schema_version = try migrate.run(self.db, &migrate.embedded);

        const instance_id = try health.ensureInstance(gpa, io, self.db);
        defer gpa.free(instance_id);
        if (instance_id.len != ids.uuid_len) return error.BadInstanceId;
        @memcpy(&self.health.instance_id, instance_id);

        self.app = App.init(gpa, io);
        self.app.withLock(self.db.handle, install);
        return self;
    }

    pub fn close(self: *Home) void {
        const io = self.app.io;
        self.app.withLock({}, uninstall);
        self.db.close();
        self.home_lock.release();
        self.dir.close(io);
        self.gpa.destroy(self);
    }

    fn install(handle: *c.Db, state: *State) void {
        state.db = handle;
    }

    fn uninstall(_: void, state: *State) void {
        state.db = null;
    }
};

/// Everything `harness serve` does after the configuration is read. Returns after the listener
/// has stopped and the lock is released.
pub fn serveHome(
    gpa: std.mem.Allocator,
    io: std.Io,
    home_path: []const u8,
    options: server.Options,
    held: *lock.Held,
    out: *std.Io.Writer,
) !void {
    const home = try Home.open(gpa, io, home_path, held);
    defer home.close();
    const usage = if (options.env) |env| try usage_boot.Lifecycle.start(gpa, io, &home.app, env, home_path) else null;
    defer if (usage) |lifecycle| lifecycle.stop();
    var session_auth = auth.SessionAuth.init(&home.app, options.origin);
    var limiter = auth.RateLimiter.init(gpa, &home.app, options.trust_proxy);
    defer limiter.deinit();
    var first_run: enroll.FirstRun = .{ .app = &home.app, .gpa = gpa, .configured_origin = options.origin };
    var wired = options;
    wired.on_listening = options.on_listening orelse first_run.hook();
    wired.authenticator = options.authenticator orelse session_auth.authenticator();
    wired.throttle = options.throttle orelse limiter.throttle();
    defer auth_routes.drainDeliveries(io);
    // Every way of signing in ends with the personal org; the hook is the orgs slice's.
    const previous_hook = codes.personal_org_hook;
    codes.personal_org_hook = orgs_repo.personalOrgHook;
    defer codes.personal_org_hook = previous_hook;
    var socket_access = ws.Wiring.init(&home.app, &session_auth);
    var hub = hub_mod.Hub.init(gpa, io, socket_access.access(), .{});
    defer hub.deinit();
    try hub.start();
    wired.hub = options.hub orelse &hub;
    wired.home = home_path;
    var sweeps: std.Io.Group = .init;
    defer sweeps.cancel(io);
    try sweeps.concurrent(io, approvals.sweepLoop, .{&home.app});
    var link_context: RuntimeLinks = .{ .gpa = gpa, .io = io, .app = &home.app, .hub = wired.hub.? };
    var owned_manager: ?runtime_manager.Manager = null;
    if (options.manager) |external| {
        wired.manager = external;
    } else if (options.agents) |agent_ctx| {
        const links: runtime_manager.Links = .{
            .ctx = &link_context,
            .append_event = logs_api.appendLinked,
            .on_event = publishRunEvent,
            .record_usage = recordRunUsage,
            .record_quota = recordRunQuota,
        };
        owned_manager = runtime_manager.Manager.init(&home.app, links, agent_ctx.env);
        wired.manager = &owned_manager.?;
    }
    var serve_error: ?anyerror = null;
    server.run(gpa, io, &home.app, home.health, wired, out) catch |err| {
        serve_error = err;
    };
    if (owned_manager) |*manager| {
        manager.shutdown(5000) catch |err| {
            std.log.err("runtime shutdown failed; exiting before freeing resources in use by live work: {t}", .{err});
            std.process.exit(1);
        };
        manager.waitIdle() catch |err| {
            std.log.err("runtime tasks did not join; exiting before freeing resources in use by live work: {t}", .{err});
            std.process.exit(1);
        };
        manager.deinit();
    }
    if (serve_error) |err| return err;
}

fn hasIndexHtml(io: std.Io, gpa: std.mem.Allocator, dir: []const u8) bool {
    const probe = std.fs.path.join(gpa, &.{ dir, "index.html" }) catch return false;
    defer gpa.free(probe);
    std.Io.Dir.cwd().access(io, probe, .{}) catch return false;
    return true;
}

fn resolveUiDistForDir(gpa: std.mem.Allocator, io: std.Io, base_dir: ?[]const u8, env: *const std.process.Environ.Map) !?[]u8 {
    if (env.get("HARNESS_UI_DIST")) |configured| {
        if (configured.len > 0) return try gpa.dupe(u8, configured);
    }
    const dir = base_dir orelse return null;
    const rels = [_][]const u8{
        "ui",
        "../Resources/ui",
        "../share/harness/ui",
        "../../../ui/dist",
    };
    for (rels) |rel| {
        const candidate = try std.fs.path.resolve(gpa, &.{ dir, rel });
        if (hasIndexHtml(io, gpa, candidate)) return candidate;
        gpa.free(candidate);
    }
    return null;
}

fn resolveUiDist(gpa: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map) !?[]u8 {
    const exe_dir = std.process.executableDirPathAlloc(io, gpa) catch null;
    defer if (exe_dir) |d| gpa.free(d);
    return resolveUiDistForDir(gpa, io, exe_dir, env);
}

pub fn serve(init: std.process.Init) u8 {
    const gpa = init.gpa;
    const settings = config_mod.load(gpa, init.environ_map) catch |err| {
        std.debug.print("harness: invalid configuration: {t}\n", .{err});
        return 1;
    };
    defer settings.deinit(gpa);
    const ui_dist = resolveUiDist(gpa, init.io, init.environ_map) catch |err| {
        std.debug.print("harness: ui dist lookup failed: {t}\n", .{err});
        return 1;
    };
    defer if (ui_dist) |d| gpa.free(d);
    var out_buffer: [256]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(init.io, &out_buffer);
    var held: lock.Held = .{};
    const agents_ctx = agents.Ctx.create(gpa, init.io, settings.home, init.environ_map) catch |err| {
        std.debug.print("harness: agents setup failed: {t}\n", .{err});
        return 1;
    };
    defer agents_ctx.destroy();
    serveHome(gpa, init.io, settings.home, .{
        .env = init.environ_map,
        .host = settings.host,
        .port = settings.port,
        .origin = settings.origin,
        .ui_dist = ui_dist,
        .trust_proxy = settings.trust_proxy,
        .agents = agents_ctx,
    }, &held, &stdout.interface) catch |err| {
        if (err == error.AlreadyLocked) {
            std.debug.print("Another harness server (pid {d}) is already using {s}\n", .{ held.pid, settings.home });
        } else {
            std.debug.print("harness: server failed: {t}\n", .{err});
        }
        return 1;
    };
    return 0;
}

fn tempHome(gpa: std.mem.Allocator, tmp: *std.testing.TmpDir) ![]u8 {
    var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const len = try tmp.dir.realPath(std.testing.io, &buf);
    return std.fmt.allocPrint(gpa, "{s}/home", .{buf[0..len]});
}

fn expectLockGone(io: std.Io, home_path: []const u8) !void {
    var dir = try std.Io.Dir.cwd().openDir(io, home_path, .{});
    defer dir.close(io);
    try std.testing.expectError(error.FileNotFound, dir.access(io, lock.lock_name, .{}));
}

test "boot: health reports the stored instance, the schema is migrated and the lock goes with the home" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tempHome(gpa, &tmp);
    defer gpa.free(path);

    var held: lock.Held = .{};
    const home = try Home.open(gpa, io, path, &held);
    try std.testing.expectEqual(@as(i64, migrate.embedded.len), home.schema_version);
    try std.testing.expectEqual(@as(i64, migrate.embedded.len), try home.db.userVersion());
    // A second server on the same home is refused while the first holds the lock.
    try std.testing.expectError(error.AlreadyLocked, Home.open(gpa, io, path, &held));

    const options: server.Options = .{ .host = "127.0.0.1", .port = 0, .threads = 2 };
    var handler = server.Server.init(.{ .app = &home.app, .health = home.health }, io, options);
    var running = try server.start(gpa, io, &handler, options);
    const url = try std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}/api/health", .{running.port});
    defer gpa.free(url);
    var client: std.http.Client = .{ .allocator = gpa, .io = io };
    defer client.deinit();
    var response: std.Io.Writer.Allocating = .init(gpa);
    defer response.deinit();
    const result = try client.fetch(.{ .location = .{ .url = url }, .response_writer = &response.writer });
    running.stop();
    running.deinit();

    try std.testing.expectEqual(std.http.Status.ok, result.status);
    const expected = try health.body(gpa, &home.health.instance_id);
    defer gpa.free(expected);
    try std.testing.expectEqualStrings(expected, response.written());

    home.close();
    try expectLockGone(io, path);
}

test "boot: a failing stdout stops the listener and releases the lock" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tempHome(gpa, &tmp);
    defer gpa.free(path);

    var held: lock.Held = .{};
    var out = std.Io.Writer.failing;
    try std.testing.expectError(error.WriteFailed, serveHome(gpa, io, path, .{ .host = "127.0.0.1", .port = 0, .threads = 2 }, &held, &out));
    try expectLockGone(io, path);
}

test "boot: supplied environment starts usage and cancels it on listener failure" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tempHome(gpa, &tmp);
    defer gpa.free(path);
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    var held: lock.Held = .{};
    var out = std.Io.Writer.failing;
    const options: server.Options = .{ .env = &env, .host = "127.0.0.1", .port = 0, .threads = 2 };
    try std.testing.expectError(error.NoHomeDir, serveHome(gpa, io, path, options, &held, &out));
    try expectLockGone(io, path);
    try env.put("HOME", path);
    const start = std.Io.Clock.awake.now(io);
    try std.testing.expectError(error.WriteFailed, serveHome(gpa, io, path, options, &held, &out));
    try std.testing.expect(start.durationTo(std.Io.Clock.awake.now(io)).toMilliseconds() < 5000);
    try expectLockGone(io, path);
    const reopened = try Home.open(gpa, io, path, &held);
    reopened.close();
}

test "boot: resolveUiDistForDir prefers HARNESS_UI_DIST and falls back to packaged locations" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "prefix/bin");
    try tmp.dir.createDirPath(io, "prefix/share/harness/ui");
    try tmp.dir.writeFile(io, .{ .sub_path = "prefix/share/harness/ui/index.html", .data = "<!doctype html>" });

    const root = try tmp.dir.realPathFileAlloc(io, ".", gpa);
    defer gpa.free(root);
    const bin_dir = try std.fs.path.join(gpa, &.{ root, "prefix/bin" });
    defer gpa.free(bin_dir);

    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();

    const share_ui = (try resolveUiDistForDir(gpa, io, bin_dir, &env)) orelse return error.TestExpectedNonNull;
    defer gpa.free(share_ui);
    try std.testing.expect(std.mem.endsWith(u8, share_ui, "/prefix/share/harness/ui"));

    try tmp.dir.createDirPath(io, "prefix/bin/ui");
    try tmp.dir.writeFile(io, .{ .sub_path = "prefix/bin/ui/index.html", .data = "<!doctype html>" });
    const local_ui = (try resolveUiDistForDir(gpa, io, bin_dir, &env)) orelse return error.TestExpectedNonNull;
    defer gpa.free(local_ui);
    try std.testing.expect(std.mem.endsWith(u8, local_ui, "/prefix/bin/ui"));

    try env.put("HARNESS_UI_DIST", "/custom/ui");
    const explicit = (try resolveUiDistForDir(gpa, io, bin_dir, &env)) orelse return error.TestExpectedNonNull;
    defer gpa.free(explicit);
    try std.testing.expectEqualStrings("/custom/ui", explicit);
}
