//! Hand-written externs for the vendored SQLite amalgamation. No translate-c.
const std = @import("std");

pub const Db = opaque {};
pub const Stmt = opaque {};

pub const ok = 0;
pub const row = 100;
pub const done = 101;

pub const open_readwrite = 0x00000002;
pub const open_create = 0x00000004;
pub const open_fullmutex = 0x00010000;

/// Tells SQLite to copy the bound text or blob immediately.
pub const transient: ?*align(1) const fn (?*anyopaque) callconv(.c) void = @ptrFromInt(std.math.maxInt(usize));

pub extern fn sqlite3_libversion() [*:0]const u8;
pub extern fn sqlite3_open_v2(path: [*:0]const u8, out: *?*Db, flags: c_int, vfs: ?[*:0]const u8) c_int;
pub extern fn sqlite3_close(db: *Db) c_int;
pub extern fn sqlite3_busy_timeout(db: *Db, ms: c_int) c_int;
pub extern fn sqlite3_exec(db: *Db, sql: [*:0]const u8, callback: ?*const anyopaque, arg: ?*anyopaque, errmsg: *?[*:0]u8) c_int;
pub extern fn sqlite3_free(ptr: ?*anyopaque) void;
pub extern fn sqlite3_errmsg(db: *Db) [*:0]const u8;
pub extern fn sqlite3_extended_errcode(db: *Db) c_int;
pub extern fn sqlite3_changes(db: *Db) c_int;
pub extern fn sqlite3_last_insert_rowid(db: *Db) i64;

pub extern fn sqlite3_prepare_v2(db: *Db, sql: [*]const u8, len: c_int, out: *?*Stmt, tail: ?*[*]const u8) c_int;
pub extern fn sqlite3_step(stmt: *Stmt) c_int;
pub extern fn sqlite3_reset(stmt: *Stmt) c_int;
pub extern fn sqlite3_finalize(stmt: *Stmt) c_int;
pub extern fn sqlite3_clear_bindings(stmt: *Stmt) c_int;

pub extern fn sqlite3_bind_null(stmt: *Stmt, index: c_int) c_int;
pub extern fn sqlite3_bind_int64(stmt: *Stmt, index: c_int, value: i64) c_int;
pub extern fn sqlite3_bind_double(stmt: *Stmt, index: c_int, value: f64) c_int;
pub extern fn sqlite3_bind_text(stmt: *Stmt, index: c_int, text: [*]const u8, len: c_int, destructor: ?*align(1) const fn (?*anyopaque) callconv(.c) void) c_int;
pub extern fn sqlite3_bind_blob(stmt: *Stmt, index: c_int, data: [*]const u8, len: c_int, destructor: ?*align(1) const fn (?*anyopaque) callconv(.c) void) c_int;

pub extern fn sqlite3_column_count(stmt: *Stmt) c_int;
pub extern fn sqlite3_column_type(stmt: *Stmt, index: c_int) c_int;
pub extern fn sqlite3_column_int64(stmt: *Stmt, index: c_int) i64;
pub extern fn sqlite3_column_double(stmt: *Stmt, index: c_int) f64;
pub extern fn sqlite3_column_text(stmt: *Stmt, index: c_int) ?[*]const u8;
pub extern fn sqlite3_column_blob(stmt: *Stmt, index: c_int) ?[*]const u8;
pub extern fn sqlite3_column_bytes(stmt: *Stmt, index: c_int) c_int;

test "db/c: vendored sqlite is 3.54 with FTS5 compiled in" {
    try std.testing.expect(std.mem.startsWith(u8, std.mem.span(sqlite3_libversion()), "3.54."));

    var db: ?*Db = null;
    try std.testing.expectEqual(@as(c_int, ok), sqlite3_open_v2(":memory:", &db, open_readwrite | open_create, null));
    defer _ = sqlite3_close(db.?);

    var err: ?[*:0]u8 = null;
    const sql = "CREATE VIRTUAL TABLE t USING fts5(body, content='', contentless_delete=1)";
    try std.testing.expectEqual(@as(c_int, ok), sqlite3_exec(db.?, sql, null, null, &err));
}
