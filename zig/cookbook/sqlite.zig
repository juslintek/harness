//! TS: bun:sqlite (`db.query(sql).get(...)`, `db.transaction`). Here: the hand-written externs in
//! src/db/c.zig, no translate-c. The connection lives in App state, so real code reaches it only
//! inside App.withLock; these snippets use a private in-memory database.
const std = @import("std");
const c = @import("../src/db/c.zig");

const Error = error{ Open, Prepare, Step, Exec, Bind };

fn open() Error!*c.Db {
    var db: ?*c.Db = null;
    errdefer if (db) |d| {
        _ = c.sqlite3_close(d);
    };
    const flags = c.open_readwrite | c.open_create | c.open_fullmutex;
    if (c.sqlite3_open_v2(":memory:", &db, flags, null) != c.ok) return error.Open;
    return db.?;
}

fn exec(db: *c.Db, sql: [:0]const u8) Error!void {
    var message: ?[*:0]u8 = null;
    if (c.sqlite3_exec(db, sql.ptr, null, null, &message) != c.ok) {
        // sqlite allocated `message`; it must go back through sqlite3_free.
        if (message) |m| c.sqlite3_free(m);
        return error.Exec;
    }
}

fn prepare(db: *c.Db, sql: []const u8) Error!*c.Stmt {
    var stmt: ?*c.Stmt = null;
    if (c.sqlite3_prepare_v2(db, sql.ptr, @intCast(sql.len), &stmt, null) != c.ok) return error.Prepare;
    return stmt.?;
}

/// Bind indexes start at 1. `transient` makes sqlite copy the text, so a slice from an arena is safe.
fn bindText(stmt: *c.Stmt, index: c_int, text: []const u8) Error!void {
    if (c.sqlite3_bind_text(stmt, index, text.ptr, @intCast(text.len), c.transient) != c.ok) return error.Bind;
}

fn columnText(stmt: *c.Stmt, index: c_int) []const u8 {
    const ptr = c.sqlite3_column_text(stmt, index) orelse return "";
    return ptr[0..@intCast(c.sqlite3_column_bytes(stmt, index))];
}

test "sqlite: prepared statement with bound parameters, read back by column" {
    const db = try open();
    defer _ = c.sqlite3_close(db);
    try exec(db, "CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, rank REAL)");

    const insert = try prepare(db, "INSERT INTO task (title, rank) VALUES (?1, ?2)");
    defer _ = c.sqlite3_finalize(insert);
    try bindText(insert, 1, "it's \"quoted\"; DROP TABLE task");
    try std.testing.expectEqual(@as(c_int, c.ok), c.sqlite3_bind_double(insert, 2, 1.5));
    try std.testing.expectEqual(@as(c_int, c.done), c.sqlite3_step(insert));
    try std.testing.expectEqual(@as(c_int, 1), c.sqlite3_changes(db));
    try std.testing.expectEqual(@as(i64, 1), c.sqlite3_last_insert_rowid(db));

    const select = try prepare(db, "SELECT id, title, rank FROM task WHERE title = ?1");
    defer _ = c.sqlite3_finalize(select);
    try bindText(select, 1, "it's \"quoted\"; DROP TABLE task");
    try std.testing.expectEqual(@as(c_int, c.row), c.sqlite3_step(select));
    try std.testing.expectEqual(@as(i64, 1), c.sqlite3_column_int64(select, 0));
    try std.testing.expectEqualStrings("it's \"quoted\"; DROP TABLE task", columnText(select, 1));
    try std.testing.expectEqual(@as(f64, 1.5), c.sqlite3_column_double(select, 2));
    try std.testing.expectEqual(@as(c_int, c.done), c.sqlite3_step(select));
}

test "sqlite: reset lets one statement run many times" {
    const db = try open();
    defer _ = c.sqlite3_close(db);
    try exec(db, "CREATE TABLE n (v INTEGER)");
    const insert = try prepare(db, "INSERT INTO n (v) VALUES (?1)");
    defer _ = c.sqlite3_finalize(insert);
    for (1..4) |value| {
        _ = c.sqlite3_reset(insert);
        _ = c.sqlite3_bind_int64(insert, 1, @intCast(value));
        try std.testing.expectEqual(@as(c_int, c.done), c.sqlite3_step(insert));
    }
    const sum = try prepare(db, "SELECT sum(v) FROM n");
    defer _ = c.sqlite3_finalize(sum);
    try std.testing.expectEqual(@as(c_int, c.row), c.sqlite3_step(sum));
    try std.testing.expectEqual(@as(i64, 6), c.sqlite3_column_int64(sum, 0));
}

test "sqlite: a failed step inside BEGIN IMMEDIATE rolls back" {
    const db = try open();
    defer _ = c.sqlite3_close(db);
    try exec(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)");

    try exec(db, "BEGIN IMMEDIATE");
    try exec(db, "INSERT INTO t (v) VALUES ('a')");
    try std.testing.expectError(error.Exec, exec(db, "INSERT INTO t (v) VALUES ('a')"));
    try exec(db, "ROLLBACK");

    const count = try prepare(db, "SELECT count(*) FROM t");
    defer _ = c.sqlite3_finalize(count);
    try std.testing.expectEqual(@as(c_int, c.row), c.sqlite3_step(count));
    try std.testing.expectEqual(@as(i64, 0), c.sqlite3_column_int64(count, 0));
}

test "sqlite: a committed transaction is visible" {
    const db = try open();
    defer _ = c.sqlite3_close(db);
    try exec(db, "CREATE TABLE t (v TEXT)");
    try exec(db, "BEGIN IMMEDIATE");
    try exec(db, "INSERT INTO t (v) VALUES ('x')");
    try exec(db, "COMMIT");
    const count = try prepare(db, "SELECT count(*) FROM t");
    defer _ = c.sqlite3_finalize(count);
    try std.testing.expectEqual(@as(c_int, c.row), c.sqlite3_step(count));
    try std.testing.expectEqual(@as(i64, 1), c.sqlite3_column_int64(count, 0));
}

test "sqlite: FTS5 match with a bound query, ordered by rank" {
    const db = try open();
    defer _ = c.sqlite3_close(db);
    try exec(db, "CREATE VIRTUAL TABLE message_fts USING fts5(body, tokenize='trigram')");
    try exec(db, "INSERT INTO message_fts (rowid, body) VALUES (1, 'orchestrator restarted'), (2, 'zig port plan'), (3, 'restarted twice')");

    const query = try prepare(db, "SELECT rowid FROM message_fts WHERE message_fts MATCH ?1 ORDER BY rank, rowid");
    defer _ = c.sqlite3_finalize(query);
    try bindText(query, 1, "restart");
    var hits: [3]i64 = undefined;
    var n: usize = 0;
    while (c.sqlite3_step(query) == c.row) : (n += 1) {
        // A tokenizer change could return more rows than the buffer holds; fail the test, do not overrun.
        if (n >= hits.len) return error.TooManyRows;
        hits[n] = c.sqlite3_column_int64(query, 0);
    }
    try std.testing.expectEqual(@as(usize, 2), n);
    try std.testing.expect(hits[0] == 1 or hits[0] == 3);
}

test "sqlite: a syntax error reports through errmsg without crashing" {
    const db = try open();
    defer _ = c.sqlite3_close(db);
    try std.testing.expectError(error.Prepare, prepare(db, "SELEKT 1"));
    try std.testing.expect(std.mem.find(u8, std.mem.span(c.sqlite3_errmsg(db)), "syntax error") != null);
}
