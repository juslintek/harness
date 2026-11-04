//! Body of GET /api/health. The route itself is wired by the http slice. Shape and instance id
//! handling follow src/shared/health.ts, ensureInstance in db.ts and the route in server/http.ts.
const std = @import("std");
const ids = @import("ids.zig");
const sqlite = @import("db/sqlite.zig");
const migrate = @import("db/migrate.zig");

/// main.ts passes the literal "0.0.0" as the version.
pub const version = "0.0.0";

/// Returns the id of the first `instance` row, creating one on a fresh database. The caller owns
/// the slice. Run it at boot, under the home lock and before serving: the select and the insert
/// are not one transaction, as in TS.
pub fn ensureInstance(gpa: std.mem.Allocator, io: std.Io, db: sqlite.Db) (sqlite.Error || std.mem.Allocator.Error)![]u8 {
    {
        const select = try db.prepare("SELECT id FROM instance LIMIT 1");
        defer select.finalize();
        if (try select.step()) return (try select.textAlloc(gpa, 0)) orelse error.Step;
    }
    const id = try gpa.dupe(u8, &ids.uuidV7(io));
    errdefer gpa.free(id);
    const insert = try db.prepare("INSERT INTO instance (id, created_at) VALUES (?1, ?2)");
    defer insert.finalize();
    try insert.bindText(1, id);
    try insert.bindInt(2, ids.nowMs(io));
    _ = try insert.step();
    return id;
}

/// `{"ok":true,"instanceId":...,"version":...}`, the field order healthSchema declares. The caller
/// owns the slice.
pub fn body(gpa: std.mem.Allocator, instance_id: []const u8) std.mem.Allocator.Error![]u8 {
    return std.json.Stringify.valueAlloc(gpa, .{ .ok = true, .instanceId = instance_id, .version = version }, .{});
}

fn migratedMemory(gpa: std.mem.Allocator) !sqlite.Db {
    const db = try sqlite.Db.open(gpa, ":memory:");
    errdefer db.close();
    _ = try migrate.run(db, &migrate.embedded);
    return db;
}

test "health: the first call creates the instance row and later calls return it" {
    const gpa = std.testing.allocator;
    const db = try migratedMemory(gpa);
    defer db.close();

    const first = try ensureInstance(gpa, std.testing.io, db);
    defer gpa.free(first);
    try std.testing.expectEqual(@as(usize, ids.uuid_len), first.len);
    try std.testing.expectEqual(@as(u8, '7'), first[14]);

    const second = try ensureInstance(gpa, std.testing.io, db);
    defer gpa.free(second);
    try std.testing.expectEqualStrings(first, second);

    const count = try db.prepare("SELECT count(*), min(created_at) FROM instance");
    defer count.finalize();
    try std.testing.expect(try count.step());
    try std.testing.expectEqual(@as(i64, 1), count.int(0));
    try std.testing.expect(count.int(1) > 1_700_000_000_000);
}

test "health: body has the fields and order of healthSchema" {
    const gpa = std.testing.allocator;
    const text = try body(gpa, "0190a0b0-0000-7000-8000-000000000000");
    defer gpa.free(text);
    try std.testing.expectEqualStrings(
        "{\"ok\":true,\"instanceId\":\"0190a0b0-0000-7000-8000-000000000000\",\"version\":\"0.0.0\"}",
        text,
    );
}

test "health: body escapes the instance id like JSON.stringify" {
    const gpa = std.testing.allocator;
    const text = try body(gpa, "a\"b\\c\n");
    defer gpa.free(text);
    try std.testing.expectEqualStrings("{\"ok\":true,\"instanceId\":\"a\\\"b\\\\c\\n\",\"version\":\"0.0.0\"}", text);
}

test "health: allocation failures leak nothing" {
    const Case = struct {
        fn run(gpa: std.mem.Allocator) !void {
            const db = try migratedMemory(gpa);
            defer db.close();
            const id = try ensureInstance(gpa, std.testing.io, db);
            defer gpa.free(id);
            const text = try body(gpa, id);
            gpa.free(text);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Case.run, .{});
}
