//! Port of migrate() in code/src/server/db/db.ts. The SQL files come from
//! code/src/server/db/migrations, embedded unchanged by build.zig.
const std = @import("std");
const build_options = @import("build_options");
const sqlite = @import("sqlite.zig");

pub const Migration = struct {
    version: u32,
    sql: [:0]const u8,
};

/// File number n is version n; build.zig refuses a gap or a duplicate, so the list is dense.
pub const embedded: [build_options.migration_count]Migration = blk: {
    var list: [build_options.migration_count]Migration = undefined;
    for (&list, 1..) |*migration, version| {
        migration.* = .{
            .version = version,
            .sql = @embedFile(std.fmt.comptimePrint("migration_{d:0>3}", .{version})),
        };
    }
    break :blk list;
};

pub const Error = sqlite.Error || error{
    /// The database was written by a newer build; it is never downgraded.
    SchemaNewer,
    MigrationGap,
};

/// Applies every migration above the database's user_version, one transaction each, and returns
/// the resulting version.
pub fn run(db: sqlite.Db, migrations: []const Migration) Error!i64 {
    var version = try db.userVersion();
    const known: i64 = if (migrations.len > 0) migrations[migrations.len - 1].version else 0;
    // An older build must not run against a schema it does not know, and never moves user_version down.
    if (version > known) {
        std.log.warn("database is at schema {d}, this build only knows up to {d}", .{ version, known });
        return error.SchemaNewer;
    }
    for (migrations) |migration| {
        if (migration.version <= version) continue;
        if (migration.version != version + 1) {
            std.log.warn("migration gap: database is at {d}, next is {d}", .{ version, migration.version });
            return error.MigrationGap;
        }
        // user_version is part of the same transaction, so a failed migration leaves it untouched.
        try db.transaction(migration, apply);
        version = migration.version;
    }
    return version;
}

fn apply(migration: Migration, db: sqlite.Db) sqlite.Error!void {
    db.exec(migration.sql) catch |err| {
        std.log.warn("migration {d} failed: {s}", .{ migration.version, db.errmsg() });
        return err;
    };
    var buf: [48]u8 = undefined;
    const pragma = std.fmt.bufPrintSentinel(&buf, "PRAGMA user_version = {d}", .{migration.version}, 0) catch
        return error.Exec;
    try db.exec(pragma);
}

fn openMemory() !sqlite.Db {
    return sqlite.Db.open(std.testing.allocator, ":memory:");
}

fn tableNames(db: sqlite.Db, gpa: std.mem.Allocator) !std.StringArrayHashMapUnmanaged(void) {
    var names: std.StringArrayHashMapUnmanaged(void) = .empty;
    errdefer freeNames(&names, gpa);
    const stmt = try db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    defer stmt.finalize();
    while (try stmt.step()) {
        const name = (try stmt.textAlloc(gpa, 0)).?;
        errdefer gpa.free(name);
        try names.put(gpa, name, {});
    }
    return names;
}

fn freeNames(names: *std.StringArrayHashMapUnmanaged(void), gpa: std.mem.Allocator) void {
    for (names.keys()) |name| gpa.free(name);
    names.deinit(gpa);
}

/// Every `CREATE [VIRTUAL] TABLE name` at the start of a line in the migrations. Two migrations
/// rebuild `wakeups` through a `wakeups_new` table and rename it, so names ending in `_new` are
/// skipped and the final name is already in the list.
fn expectedTables(gpa: std.mem.Allocator) !std.StringArrayHashMapUnmanaged(void) {
    var names: std.StringArrayHashMapUnmanaged(void) = .empty;
    errdefer names.deinit(gpa);
    for (embedded) |migration| {
        var lines = std.mem.splitScalar(u8, migration.sql, '\n');
        while (lines.next()) |line| {
            const virtual = "CREATE VIRTUAL TABLE ";
            const plain = "CREATE TABLE ";
            var rest = std.mem.trimStart(u8, line, " \t");
            if (std.mem.startsWith(u8, rest, virtual)) {
                rest = rest[virtual.len..];
            } else if (std.mem.startsWith(u8, rest, plain)) {
                rest = rest[plain.len..];
            } else continue;
            const end = std.mem.findAny(u8, rest, " (") orelse rest.len;
            if (std.mem.endsWith(u8, rest[0..end], "_new")) continue;
            try names.put(gpa, rest[0..end], {});
        }
    }
    return names;
}

test "migrate: an empty in-memory database reaches the highest migration file number" {
    const db = try openMemory();
    defer db.close();
    try std.testing.expect(embedded.len > 0);
    const version = try run(db, &embedded);
    try std.testing.expectEqual(@as(i64, embedded.len), version);
    try std.testing.expectEqual(version, try db.userVersion());
    for (embedded, 1..) |migration, number| try std.testing.expectEqual(@as(u32, @intCast(number)), migration.version);
}

test "migrate: a rerun is a no-op" {
    const db = try openMemory();
    defer db.close();
    const first = try run(db, &embedded);
    try std.testing.expectEqual(first, try run(db, &embedded));
}

test "migrate: every table named in the SQL exists after all migrations" {
    const gpa = std.testing.allocator;
    const db = try openMemory();
    defer db.close();
    _ = try run(db, &embedded);

    var actual = try tableNames(db, gpa);
    defer freeNames(&actual, gpa);
    var expected = try expectedTables(gpa);
    defer expected.deinit(gpa);
    try std.testing.expect(expected.count() > 30);
    for (expected.keys()) |name| {
        if (!actual.contains(name)) {
            std.debug.print("missing table {s}\n", .{name});
            return error.TestExpectedEqual;
        }
    }
    try std.testing.expect(actual.contains("instance"));
    try std.testing.expect(actual.contains("events"));
}

test "migrate: a temp-file database persists its version across reopen" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_len = try tmp.dir.realPath(std.testing.io, &buf);
    const path = try std.fmt.allocPrint(std.testing.allocator, "{s}/harness.db", .{buf[0..dir_len]});
    defer std.testing.allocator.free(path);

    {
        const db = try sqlite.Db.open(std.testing.allocator, path);
        defer db.close();
        // Stop partway, as a database written by an older build would be.
        try std.testing.expectEqual(@as(i64, 6), try run(db, embedded[0..6]));
    }
    const db = try sqlite.Db.open(std.testing.allocator, path);
    defer db.close();
    try std.testing.expectEqual(@as(i64, 6), try db.userVersion());
    try std.testing.expectEqual(@as(i64, embedded.len), try run(db, &embedded));
}

test "migrate: a database newer than this build is refused and left alone" {
    const db = try openMemory();
    defer db.close();
    try db.exec("PRAGMA user_version = 999");
    try std.testing.expectError(error.SchemaNewer, run(db, &embedded));
    try std.testing.expectEqual(@as(i64, 999), try db.userVersion());
}

test "migrate: a gap is refused and the database is untouched" {
    const db = try openMemory();
    defer db.close();
    const gappy = [_]Migration{.{ .version = 2, .sql = "CREATE TABLE x (a TEXT)" }};
    try std.testing.expectError(error.MigrationGap, run(db, &gappy));
    try std.testing.expectEqual(@as(i64, 0), try db.userVersion());
    try expectNoTable(db, "x");
}

test "migrate: a failing migration rolls back its own changes and keeps user_version" {
    const db = try openMemory();
    defer db.close();
    const list = [_]Migration{
        .{ .version = 1, .sql = "CREATE TABLE a (v TEXT)" },
        .{ .version = 2, .sql = "CREATE TABLE b (v TEXT); CREATE TABLE a (v TEXT)" },
    };
    try std.testing.expectError(error.Exec, run(db, &list));
    try std.testing.expectEqual(@as(i64, 1), try db.userVersion());
    try expectNoTable(db, "b");
}

test "migrate: no migrations on an empty database is version 0" {
    const db = try openMemory();
    defer db.close();
    try std.testing.expectEqual(@as(i64, 0), try run(db, &.{}));
}

fn expectNoTable(db: sqlite.Db, name: []const u8) !void {
    const found = try db.prepare("SELECT count(*) FROM sqlite_master WHERE name = ?1");
    defer found.finalize();
    try found.bindText(1, name);
    try std.testing.expect(try found.step());
    try std.testing.expectEqual(@as(i64, 0), found.int(0));
}
