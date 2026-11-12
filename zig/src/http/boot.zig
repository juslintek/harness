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
const ws = @import("ws.zig");
const usage_boot = @import("../usage/boot.zig");
const approvals = @import("../guard/approvals.zig");

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
    try server.run(gpa, io, &home.app, home.health, wired, out);
}

pub fn serve(init: std.process.Init) u8 {
    const gpa = init.gpa;
    const settings = config_mod.load(gpa, init.environ_map) catch |err| {
        std.debug.print("harness: invalid configuration: {t}\n", .{err});
        return 1;
    };
    defer settings.deinit(gpa);
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
        .ui_dist = init.environ_map.get("HARNESS_UI_DIST"),
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
