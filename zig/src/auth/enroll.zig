//! Enrollment links on the command line and at boot: `harness enroll` (code/scripts/enroll.ts) and
//! the first-run line of main.ts. Both end in a link `<origin>/#/enroll/<code>`.
const std = @import("std");
const app_mod = @import("../app.zig");
const c = @import("../db/c.zig");
const config_mod = @import("../config.zig");
const ids = @import("../ids.zig");
const migrate = @import("../db/migrate.zig");
const server = @import("../http/server.zig");
const sqlite = @import("../db/sqlite.zig");
const codes = @import("codes.zig");

const App = app_mod.App;
const State = app_mod.State;
const Allocator = std.mem.Allocator;

/// ENROLLMENT_TTL_MS of main.ts and TTL_MS of enroll.ts.
pub const ttl_ms: i64 = 24 * 60 * 60 * 1000;

pub const usage = "usage: harness enroll --email <email> [--name <name>]\n";
pub const fixed_origin_message = "HARNESS_PORT=0 has no fixed origin: set HARNESS_ORIGIN or a real HARNESS_PORT\n";

// ---- the link ----

/// `rp.origin`: HARNESS_ORIGIN, or `http://localhost:<port>`.
pub fn originOf(arena: Allocator, configured: ?[]const u8, port: u16) Allocator.Error![]const u8 {
    return configured orelse try std.fmt.allocPrint(arena, "http://localhost:{d}", .{port});
}

pub fn linkFor(arena: Allocator, origin: []const u8, code: *const codes.EnrollmentCode) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "{s}/#/enroll/{s}", .{ origin, code });
}

pub const Who = struct { email: []const u8, name: ?[]const u8 = null };

const UserArgs = struct { alloc: Allocator, io: std.Io, who: Who };

/// An existing user keeps their account and only adds a passkey; an unknown email gets an account
/// first so the name given here is the one that is kept.
fn ensureUser(db: sqlite.Db, a: UserArgs) codes.Error![]const u8 {
    if (try codes.userByEmail(db, a.alloc, a.who.email)) |existing| return existing.id;
    const fallback = a.who.email[0 .. std.mem.findScalar(u8, a.who.email, '@') orelse a.who.email.len];
    const id = try codes.insertUser(db, a.io, .{ .email = a.who.email, .name = a.who.name orelse fallback, .instance_admin = false });
    return a.alloc.dupe(u8, &id);
}

/// `enrollLink`.
pub fn enrollLink(app: *App, arena: Allocator, origin: []const u8, who: Who) ![]const u8 {
    const user_id = try codes.runTx(app, UserArgs{ .alloc = arena, .io = app.io, .who = who }, ensureUser);
    const code = try codes.createEnrollment(app, .{ .user_id = user_id, .ttl_ms = ttl_ms }, ids.nowMs(app.io));
    return linkFor(arena, origin, &code);
}

// ---- first run ----

/// Prints `first-run enrollment: <link>` when the instance has no admin with a passkey. Installed
/// as the listener's `on_listening` hook, so it comes right after the listening line.
pub const FirstRun = struct {
    app: *App,
    gpa: Allocator,
    configured_origin: ?[]const u8,

    pub fn hook(self: *FirstRun) server.OnListening {
        return .{ .ctx = self, .call = announce };
    }

    fn announce(ctx: *anyopaque, port: u16, out: *std.Io.Writer) anyerror!void {
        const self: *FirstRun = @ptrCast(@alignCast(ctx));
        var arena: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena.deinit();
        try self.print(arena.allocator(), port, out);
    }

    pub fn print(self: *FirstRun, arena: Allocator, port: u16, out: *std.Io.Writer) !void {
        const code = try codes.firstRunEnrollment(self.app, arena, ttl_ms, ids.nowMs(self.app.io)) orelse return;
        const link = try linkFor(arena, try originOf(arena, self.configured_origin, port), &code);
        try out.print("first-run enrollment: {s}\n", .{link});
    }
};

// ---- harness enroll ----

pub const Parsed = struct { email: ?[]const u8 = null, name: ?[]const u8 = null };

/// `parseArgs` of node:util with `--email` and `--name` as string options, in both the
/// `--name value` and `--name=value` spellings. Anything else is refused, as in strict mode.
pub fn parseArgs(args: []const [:0]const u8) error{BadArguments}!Parsed {
    var parsed: Parsed = .{};
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg: []const u8 = args[i];
        if (!std.mem.startsWith(u8, arg, "--")) return error.BadArguments;
        const eq = std.mem.findScalar(u8, arg, '=');
        const key = arg[2 .. eq orelse arg.len];
        const value: []const u8 = if (eq) |at| arg[at + 1 ..] else blk: {
            i += 1;
            if (i >= args.len) return error.BadArguments;
            // node refuses a separate value that starts with a dash (ERR_PARSE_ARGS_INVALID_OPTION_VALUE).
            if (std.mem.startsWith(u8, args[i], "-")) return error.BadArguments;
            break :blk args[i];
        };
        if (std.mem.eql(u8, key, "email")) parsed.email = value else if (std.mem.eql(u8, key, "name")) parsed.name = value else return error.BadArguments;
    }
    return parsed;
}

fn installDb(handle: *c.Db, state: *State) void {
    state.db = handle;
}

fn uninstallDb(_: void, state: *State) void {
    state.db = null;
}

pub fn run(init: std.process.Init) u8 {
    const gpa = init.gpa;
    const arena = init.arena.allocator();
    const args = init.minimal.args.toSlice(arena) catch return 1;
    const parsed = parseArgs(args[2..]) catch {
        std.debug.print("harness: invalid arguments (an option value may not start with a dash; use --name=value)\n", .{});
        std.debug.print(usage, .{});
        return 1;
    };
    const email = parsed.email orelse {
        std.debug.print(usage, .{});
        return 1;
    };
    if (email.len == 0) {
        std.debug.print(usage, .{});
        return 1;
    }
    const settings = config_mod.load(gpa, init.environ_map) catch |err| {
        std.debug.print("harness: invalid configuration: {t}\n", .{err});
        return 1;
    };
    defer settings.deinit(gpa);
    if (settings.port == 0 and settings.origin == null) {
        std.debug.print("{s}", .{fixed_origin_message});
        return 1;
    }
    var out_buffer: [512]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(init.io, &out_buffer);
    printLink(gpa, init.io, settings, .{ .email = email, .name = parsed.name }, &stdout.interface) catch |err| {
        std.debug.print("harness: enroll failed: {t}\n", .{err});
        return 1;
    };
    return 0;
}

/// Opens the home's database without the home lock, as enroll.ts does, so a running server can be
/// enrolled against.
fn printLink(gpa: Allocator, io: std.Io, settings: config_mod.Config, who: Who, out: *std.Io.Writer) !void {
    try std.Io.Dir.cwd().createDirPath(io, settings.home);
    const db_path = try std.fmt.allocPrint(gpa, "{s}/harness.db", .{settings.home});
    defer gpa.free(db_path);
    const db = try sqlite.Db.open(gpa, db_path);
    defer db.close();
    _ = try migrate.run(db, &migrate.embedded);
    var app = App.init(gpa, io);
    app.withLock(db.handle, installDb);
    defer app.withLock({}, uninstallDb);
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const origin = try originOf(arena.allocator(), settings.origin, settings.port);
    try out.print("{s}\n", .{try enrollLink(&app, arena.allocator(), origin, who)});
    try out.flush();
}

test {
    _ = @import("enroll_test.zig");
}
