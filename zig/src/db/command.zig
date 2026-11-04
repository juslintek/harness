//! `harness migrate`: takes the home lock, applies the embedded migrations to
//! $HARNESS_HOME/harness.db and prints the resulting user_version.
const std = @import("std");
const config = @import("../config.zig");
const lock = @import("lock.zig");
const migrate = @import("migrate.zig");
const sqlite = @import("sqlite.zig");

pub fn run(init: std.process.Init) u8 {
    const settings = config.load(init.gpa, init.environ_map) catch |err| {
        std.debug.print("harness migrate: bad configuration: {t}\n", .{err});
        return 1;
    };
    defer settings.deinit(init.gpa);
    var held: lock.Held = .{};
    const version = migrateHome(init.gpa, init.io, settings.home, &held) catch |err| {
        if (err == error.AlreadyLocked) {
            std.debug.print("Another harness server (pid {d}) is already using {s}\n", .{ held.pid, settings.home });
        } else {
            std.debug.print("harness migrate: {t}\n", .{err});
        }
        return 1;
    };
    var buf: [32]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "{d}\n", .{version}) catch return 1;
    std.Io.File.stdout().writeStreamingAll(init.io, line) catch |err| {
        std.debug.print("harness migrate: cannot write the version: {t}\n", .{err});
        return 1;
    };
    return 0;
}

fn migrateHome(gpa: std.mem.Allocator, io: std.Io, home_path: []const u8, held: *lock.Held) !i64 {
    const cwd = std.Io.Dir.cwd();
    try cwd.createDirPath(io, home_path);
    var home = try cwd.openDir(io, home_path, .{});
    defer home.close(io);

    var home_lock = try lock.acquire(io, home, held);
    defer home_lock.release();

    const db_path = try std.fmt.allocPrint(gpa, "{s}/harness.db", .{home_path});
    defer gpa.free(db_path);
    const db = try sqlite.Db.open(gpa, db_path);
    defer db.close();
    return migrate.run(db, &migrate.embedded);
}

test "migrate command: a fresh home ends at the highest migration and a rerun agrees" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_len = try tmp.dir.realPath(io, &buf);
    const home = try std.fmt.allocPrint(gpa, "{s}/nested/home", .{buf[0..dir_len]});
    defer gpa.free(home);

    var held: lock.Held = .{};
    try std.testing.expectEqual(@as(i64, migrate.embedded.len), try migrateHome(gpa, io, home, &held));
    try std.testing.expectEqual(@as(i64, migrate.embedded.len), try migrateHome(gpa, io, home, &held));

    var home_dir = try std.Io.Dir.cwd().openDir(io, home, .{});
    defer home_dir.close(io);
    // The lock is released on the way out.
    try std.testing.expectError(error.FileNotFound, home_dir.access(io, lock.lock_name, .{}));
}
