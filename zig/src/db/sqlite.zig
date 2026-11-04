//! Small wrapper over the externs in c.zig, standing in for bun:sqlite. Every call that can fail
//! returns an error; the SQLite message is available from `errmsg` until the next call on the
//! same connection. The connection lives in App state, so callers reach it only inside
//! App.withLock.
const std = @import("std");
const c = @import("c.zig");

pub const Error = error{
    Open,
    Exec,
    Prepare,
    Bind,
    Step,
    /// busy_timeout ran out while another connection held the lock.
    Busy,
    /// UNIQUE, NOT NULL, CHECK, FOREIGN KEY or trigger RAISE(ABORT) failure.
    Constraint,
    /// A text, blob or statement longer than SQLite's int length parameter.
    TooBig,
    OutOfMemory,
};

const sqlite_busy = 5;
const sqlite_nomem = 7;
const sqlite_constraint = 19;
const sqlite_column_null_type = 5;

/// The low byte is the primary result code, whether or not extended codes are enabled.
fn mapStatus(rc: c_int, fallback: Error) Error {
    return switch (rc & 0xff) {
        sqlite_busy => error.Busy,
        sqlite_nomem => error.OutOfMemory,
        sqlite_constraint => error.Constraint,
        else => fallback,
    };
}

pub const Db = struct {
    handle: *c.Db,

    /// Same PRAGMAs, in the same order, as openDb in code/src/server/db/db.ts.
    pub fn open(gpa: std.mem.Allocator, path: []const u8) Error!Db {
        const path_z = try gpa.dupeSentinel(u8, path, 0);
        defer gpa.free(path_z);
        var handle: ?*c.Db = null;
        const flags = c.open_readwrite | c.open_create | c.open_fullmutex;
        const rc = c.sqlite3_open_v2(path_z.ptr, &handle, flags, null);
        // SQLite returns a handle on most failures; it still has to be closed.
        const opened = handle orelse return mapStatus(rc, error.Open);
        if (rc != c.ok) {
            std.log.warn("sqlite open {s}: {s}", .{ path, c.sqlite3_errmsg(opened) });
            _ = c.sqlite3_close(opened);
            return mapStatus(rc, error.Open);
        }
        const db: Db = .{ .handle = opened };
        errdefer db.close();
        inline for (.{
            "PRAGMA journal_mode = WAL",
            "PRAGMA foreign_keys = ON",
            "PRAGMA busy_timeout = 5000",
            "PRAGMA synchronous = NORMAL",
        }) |pragma| try db.exec(pragma);
        return db;
    }

    /// Fails with a log line when a statement is still unfinalized: that is a leak in the caller.
    pub fn close(db: Db) void {
        if (c.sqlite3_close(db.handle) != c.ok) std.log.warn("sqlite close: a statement is still open", .{});
    }

    /// Valid until the next call on this connection; copy it to keep it.
    pub fn errmsg(db: Db) []const u8 {
        return std.mem.span(c.sqlite3_errmsg(db.handle));
    }

    /// Runs one or more statements without parameters.
    pub fn exec(db: Db, sql: [:0]const u8) Error!void {
        var message: ?[*:0]u8 = null;
        const rc = c.sqlite3_exec(db.handle, sql.ptr, null, null, &message);
        // SQLite allocated `message`; it goes back through sqlite3_free. errmsg has the same text.
        if (message) |m| c.sqlite3_free(m);
        if (rc != c.ok) return mapStatus(rc, error.Exec);
    }

    pub fn prepare(db: Db, sql: []const u8) Error!Stmt {
        const len = std.math.cast(c_int, sql.len) orelse return error.TooBig;
        var handle: ?*c.Stmt = null;
        const rc = c.sqlite3_prepare_v2(db.handle, sql.ptr, len, &handle, null);
        if (rc != c.ok) return mapStatus(rc, error.Prepare);
        // An empty or comment-only string prepares to no statement.
        return .{ .handle = handle orelse return error.Prepare };
    }

    /// PRAGMA user_version is a signed 32-bit header field; a negative value is not ours.
    pub fn userVersion(db: Db) Error!i64 {
        const stmt = try db.prepare("PRAGMA user_version");
        defer stmt.finalize();
        if (!try stmt.step()) return error.Step;
        return stmt.int(0);
    }

    /// BEGIN IMMEDIATE so a writer takes the write lock up front and cannot fail halfway with
    /// SQLITE_BUSY on the upgrade from a read lock.
    pub fn begin(db: Db) Error!void {
        try db.exec("BEGIN IMMEDIATE");
    }

    pub fn commit(db: Db) Error!void {
        try db.exec("COMMIT");
    }

    pub fn rollback(db: Db) Error!void {
        try db.exec("ROLLBACK");
    }

    /// Runs `f(ctx, db)` between BEGIN IMMEDIATE and COMMIT, rolling back when `f` or the commit
    /// fails. `f` must return an error union.
    pub fn transaction(db: Db, ctx: anytype, comptime f: anytype) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
        try db.begin();
        const result = f(ctx, db) catch |err| {
            db.rollbackAfter(err);
            return err;
        };
        db.commit() catch |err| {
            db.rollbackAfter(err);
            return err;
        };
        return result;
    }

    /// SQLite may already have rolled back (disk full, interrupt), so a failing ROLLBACK is
    /// expected there; the original error is the one worth returning.
    fn rollbackAfter(db: Db, cause: anyerror) void {
        db.rollback() catch |err| std.log.warn("rollback after {t} failed: {t}", .{ cause, err });
    }
};

pub const Stmt = struct {
    handle: *c.Stmt,

    /// The result code only repeats the last step's error, which step already returned.
    pub fn finalize(stmt: Stmt) void {
        _ = c.sqlite3_finalize(stmt.handle);
    }

    /// Rewinds for another run; bound values stay until rebound or cleared.
    pub fn reset(stmt: Stmt) Error!void {
        const rc = c.sqlite3_reset(stmt.handle);
        if (rc != c.ok) return mapStatus(rc, error.Step);
    }

    pub fn clearBindings(stmt: Stmt) void {
        _ = c.sqlite3_clear_bindings(stmt.handle);
    }

    /// True while a row is ready to read, false when the statement is done.
    pub fn step(stmt: Stmt) Error!bool {
        const rc = c.sqlite3_step(stmt.handle);
        return switch (rc) {
            c.row => true,
            c.done => false,
            else => mapStatus(rc, error.Step),
        };
    }

    /// Parameter indexes start at 1.
    pub fn bindNull(stmt: Stmt, index: c_int) Error!void {
        try checkBind(c.sqlite3_bind_null(stmt.handle, index));
    }

    pub fn bindInt(stmt: Stmt, index: c_int, value: i64) Error!void {
        try checkBind(c.sqlite3_bind_int64(stmt.handle, index, value));
    }

    pub fn bindReal(stmt: Stmt, index: c_int, value: f64) Error!void {
        try checkBind(c.sqlite3_bind_double(stmt.handle, index, value));
    }

    /// SQLite copies the text, so a slice from an arena or the stack is fine.
    pub fn bindText(stmt: Stmt, index: c_int, value: []const u8) Error!void {
        const len = std.math.cast(c_int, value.len) orelse return error.TooBig;
        try checkBind(c.sqlite3_bind_text(stmt.handle, index, value.ptr, len, c.transient));
    }

    pub fn bindBlob(stmt: Stmt, index: c_int, data: []const u8) Error!void {
        const len = std.math.cast(c_int, data.len) orelse return error.TooBig;
        try checkBind(c.sqlite3_bind_blob(stmt.handle, index, data.ptr, len, c.transient));
    }

    /// Column indexes start at 0. A NULL column reads as 0.
    pub fn int(stmt: Stmt, column: c_int) i64 {
        return c.sqlite3_column_int64(stmt.handle, column);
    }

    pub fn real(stmt: Stmt, column: c_int) f64 {
        return c.sqlite3_column_double(stmt.handle, column);
    }

    pub fn isNull(stmt: Stmt, column: c_int) bool {
        return c.sqlite3_column_type(stmt.handle, column) == sqlite_column_null_type;
    }

    /// Null for SQL NULL. The slice points into SQLite memory and is valid until the next step,
    /// reset or finalize; use `textAlloc` to keep it.
    pub fn text(stmt: Stmt, column: c_int) Error!?[]const u8 {
        if (stmt.isNull(column)) return null;
        // A NULL pointer from a non-NULL column means SQLite ran out of memory converting it.
        const ptr = c.sqlite3_column_text(stmt.handle, column) orelse return error.OutOfMemory;
        return ptr[0..byteCount(stmt, column)];
    }

    pub fn blob(stmt: Stmt, column: c_int) Error!?[]const u8 {
        if (stmt.isNull(column)) return null;
        const len = byteCount(stmt, column);
        // An empty blob has no pointer; it is not an error.
        const ptr = c.sqlite3_column_blob(stmt.handle, column) orelse
            return if (len == 0) &.{} else error.OutOfMemory;
        return ptr[0..len];
    }

    pub fn textAlloc(stmt: Stmt, gpa: std.mem.Allocator, column: c_int) (Error || std.mem.Allocator.Error)!?[]u8 {
        const value = try stmt.text(column) orelse return null;
        return try gpa.dupe(u8, value);
    }

    /// Must be asked after the text or blob accessor, which may convert the value.
    fn byteCount(stmt: Stmt, column: c_int) usize {
        return std.math.cast(usize, c.sqlite3_column_bytes(stmt.handle, column)) orelse 0;
    }
};

fn checkBind(rc: c_int) Error!void {
    if (rc != c.ok) return mapStatus(rc, error.Bind);
}

fn memoryDb() !Db {
    return Db.open(std.testing.allocator, ":memory:");
}

test "sqlite: open applies the TS pragmas" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir_len = try tmp.dir.realPath(std.testing.io, &buf);
    const path = try std.fmt.allocPrint(std.testing.allocator, "{s}/t.db", .{buf[0..dir_len]});
    defer std.testing.allocator.free(path);

    const db = try Db.open(std.testing.allocator, path);
    defer db.close();
    for ([_]struct { []const u8, []const u8 }{
        .{ "PRAGMA journal_mode", "wal" },
        .{ "PRAGMA foreign_keys", "1" },
        .{ "PRAGMA busy_timeout", "5000" },
        .{ "PRAGMA synchronous", "1" },
    }) |case| {
        const stmt = try db.prepare(case[0]);
        defer stmt.finalize();
        try std.testing.expect(try stmt.step());
        try std.testing.expectEqualStrings(case[1], (try stmt.text(0)).?);
    }
}

test "sqlite: open of a missing directory fails" {
    try std.testing.expectError(error.Open, Db.open(std.testing.allocator, "/nonexistent-dir-for-test/t.db"));
}

test "sqlite: bound parameters round trip and nulls read back as null" {
    const db = try memoryDb();
    defer db.close();
    try db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB)");

    const insert = try db.prepare("INSERT INTO t (name, score, data) VALUES (?1, ?2, ?3)");
    defer insert.finalize();
    try insert.bindText(1, "it's \"quoted\"; DROP TABLE t");
    try insert.bindReal(2, 1.5);
    try insert.bindBlob(3, "\x00\x01");
    try std.testing.expect(!try insert.step());
    try insert.reset();
    try insert.bindNull(1);
    try insert.bindInt(2, 7);
    try insert.bindBlob(3, "");
    try std.testing.expect(!try insert.step());

    const select = try db.prepare("SELECT name, score, data FROM t ORDER BY id");
    defer select.finalize();
    try std.testing.expect(try select.step());
    try std.testing.expectEqualStrings("it's \"quoted\"; DROP TABLE t", (try select.text(0)).?);
    try std.testing.expectEqual(@as(f64, 1.5), select.real(1));
    try std.testing.expectEqualSlices(u8, "\x00\x01", (try select.blob(2)).?);
    try std.testing.expect(try select.step());
    try std.testing.expect(select.isNull(0));
    try std.testing.expectEqual(@as(?[]const u8, null), try select.text(0));
    try std.testing.expectEqual(@as(i64, 7), select.int(1));
    try std.testing.expectEqual(@as(usize, 0), (try select.blob(2)).?.len);
    try std.testing.expect(!try select.step());
}

test "sqlite: failures are errors with a message" {
    const db = try memoryDb();
    defer db.close();
    try std.testing.expectError(error.Prepare, db.prepare("SELEKT 1"));
    try std.testing.expect(std.mem.find(u8, db.errmsg(), "syntax error") != null);
    try std.testing.expectError(error.Prepare, db.prepare("-- nothing"));
    try std.testing.expectError(error.Exec, db.exec("DROP TABLE missing"));
    try std.testing.expect(std.mem.find(u8, db.errmsg(), "no such table") != null);

    try db.exec("CREATE TABLE t (v TEXT UNIQUE NOT NULL)");
    const insert = try db.prepare("INSERT INTO t (v) VALUES (?1)");
    defer insert.finalize();
    try std.testing.expectError(error.Bind, insert.bindText(2, "out of range"));
    try insert.bindText(1, "a");
    try std.testing.expect(!try insert.step());
    try insert.reset();
    try insert.bindText(1, "a");
    try std.testing.expectError(error.Constraint, insert.step());
    try std.testing.expectError(error.Constraint, insert.reset());
}

test "sqlite: transaction commits on success and rolls back on error" {
    const db = try memoryDb();
    defer db.close();
    try db.exec("CREATE TABLE t (v TEXT UNIQUE)");
    const Work = struct {
        fn insert(values: []const []const u8, tx: Db) Error!void {
            for (values) |value| {
                const stmt = try tx.prepare("INSERT INTO t (v) VALUES (?1)");
                defer stmt.finalize();
                try stmt.bindText(1, value);
                _ = try stmt.step();
            }
        }
    };
    try db.transaction(@as([]const []const u8, &.{ "a", "b" }), Work.insert);
    try std.testing.expectError(error.Constraint, db.transaction(@as([]const []const u8, &.{ "c", "a" }), Work.insert));

    const count = try db.prepare("SELECT count(*) FROM t");
    defer count.finalize();
    try std.testing.expect(try count.step());
    try std.testing.expectEqual(@as(i64, 2), count.int(0));
    // The failed transaction left nothing open: a new one can begin.
    try db.begin();
    try db.rollback();
}

test "sqlite: a second BEGIN IMMEDIATE on one connection fails instead of nesting" {
    const db = try memoryDb();
    defer db.close();
    try db.begin();
    try std.testing.expectError(error.Exec, db.begin());
    try db.rollback();
}

test "sqlite: allocation failures in open and textAlloc leave nothing behind" {
    const Case = struct {
        fn run(gpa: std.mem.Allocator) !void {
            const db = try Db.open(gpa, ":memory:");
            defer db.close();
            const stmt = try db.prepare("SELECT 'hello'");
            defer stmt.finalize();
            try std.testing.expect(try stmt.step());
            const owned = (try stmt.textAlloc(gpa, 0)).?;
            defer gpa.free(owned);
            try std.testing.expectEqualStrings("hello", owned);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Case.run, .{});
}

test "sqlite: text and statements longer than a C int are refused, not truncated" {
    const db = try memoryDb();
    defer db.close();
    const stmt = try db.prepare("SELECT ?1");
    defer stmt.finalize();
    // A slice with a huge length and no backing memory is never read: the length check comes first.
    const huge: []const u8 = @as([*]const u8, @ptrFromInt(1))[0 .. @as(usize, std.math.maxInt(c_int)) + 1];
    try std.testing.expectError(error.TooBig, stmt.bindText(1, huge));
    try std.testing.expectError(error.TooBig, stmt.bindBlob(1, huge));
    try std.testing.expectError(error.TooBig, db.prepare(huge));
}
