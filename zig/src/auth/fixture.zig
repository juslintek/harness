//! Test support for the auth slice: an `App` over an in-memory database with the real schema.
const std = @import("std");
const app_mod = @import("../app.zig");
const migrate = @import("../db/migrate.zig");
const sqlite = @import("../db/sqlite.zig");

const App = app_mod.App;
const State = app_mod.State;

pub const Fixture = struct {
    gpa: std.mem.Allocator,
    app: App,
    db: sqlite.Db,

    /// On the heap: the app holds a mutex that must not move.
    pub fn create(gpa: std.mem.Allocator, io: std.Io) !*Fixture {
        const self = try gpa.create(Fixture);
        errdefer gpa.destroy(self);
        self.gpa = gpa;
        self.db = try sqlite.Db.open(gpa, ":memory:");
        errdefer self.db.close();
        _ = try migrate.run(self.db, &migrate.embedded);
        self.app = App.init(gpa, io);
        self.app.withLock(self.db.handle, install);
        return self;
    }

    pub fn destroy(self: *Fixture) void {
        self.app.withLock({}, uninstall);
        self.db.close();
        self.gpa.destroy(self);
    }

    fn install(handle: *@import("../db/c.zig").Db, state: *State) void {
        state.db = handle;
    }

    fn uninstall(_: void, state: *State) void {
        state.db = null;
    }

    /// Inserts a user row, the way conformance/kit/seed.ts does.
    pub fn addUser(self: *Fixture, id: []const u8, instance_admin: bool) !void {
        const stmt = try self.db.prepare(
            "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, 'Test', ?, 1000)",
        );
        defer stmt.finalize();
        var email_buf: [64]u8 = undefined;
        try stmt.bindText(1, id);
        try stmt.bindText(2, try std.fmt.bufPrint(&email_buf, "{s}@example.test", .{id}));
        try stmt.bindInt(3, @intFromBool(instance_admin));
        _ = try stmt.step();
    }

    pub fn run(self: *Fixture, comptime sql: [:0]const u8) !void {
        try self.db.exec(sql);
    }
};
