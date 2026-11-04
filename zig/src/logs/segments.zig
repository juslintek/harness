//! Port of segments.ts: pending event bodies are packed into zstd segments (level 3, about 256 KiB
//! raw each) and the events row keeps the segment id and the byte range of its body.
const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const ids = @import("../ids.zig");
const zstd = @import("zstd_c.zig");

const Allocator = std.mem.Allocator;

pub const default_min_bytes: i64 = 262144;
const max_raw_bytes: usize = 262144;
const level = 3;
/// A corrupt raw_len must not turn into a huge allocation.
const max_segment_raw: i64 = 1 << 30;

pub const Error = sqlite.Error || Allocator.Error || error{ CorruptSegment, ZstdFailed };

const Pending = struct { rowid: i64, body: []u8 };

fn freePending(gpa: Allocator, rows: *std.ArrayList(Pending)) void {
    for (rows.items) |row| gpa.free(row.body);
    rows.deinit(gpa);
}

fn bindRun(stmt: sqlite.Stmt, index: c_int, run_id: ?[]const u8) !void {
    if (run_id) |id| try stmt.bindText(index, id) else try stmt.bindNull(index);
}

fn seal(gpa: Allocator, io: std.Io, db: sqlite.Db, run_id: ?[]const u8, rows: []const Pending) Error!void {
    var total: usize = 0;
    for (rows) |row| total += row.body.len;
    const raw = try gpa.alloc(u8, total);
    defer gpa.free(raw);
    var at: usize = 0;
    for (rows) |row| {
        @memcpy(raw[at..][0..row.body.len], row.body);
        at += row.body.len;
    }
    const packed_buf = try gpa.alloc(u8, zstd.ZSTD_compressBound(raw.len));
    defer gpa.free(packed_buf);
    const n = zstd.ZSTD_compress(packed_buf.ptr, packed_buf.len, raw.ptr, raw.len, level);
    if (zstd.ZSTD_isError(n) != 0) return error.ZstdFailed;

    const id = ids.uuidV7(io);
    const insert = try db.prepare("INSERT INTO segments (id, run_id, created_at, level, raw_len, bytes) VALUES (?, ?, ?, ?, ?, ?)");
    defer insert.finalize();
    try insert.bindText(1, &id);
    try bindRun(insert, 2, run_id);
    try insert.bindInt(3, ids.nowMs(io));
    try insert.bindInt(4, level);
    try insert.bindInt(5, @intCast(raw.len));
    try insert.bindBlob(6, packed_buf[0..n]);
    _ = try insert.step();

    const update = try db.prepare("UPDATE events SET segment_id = ?, seg_offset = ?, seg_len = ? WHERE rowid = ?");
    defer update.finalize();
    const drop = try db.prepare("DELETE FROM pending_payloads WHERE event_rowid = ?");
    defer drop.finalize();
    var offset: i64 = 0;
    for (rows) |row| {
        const len: i64 = @intCast(row.body.len);
        try update.bindText(1, &id);
        try update.bindInt(2, offset);
        try update.bindInt(3, len);
        try update.bindInt(4, row.rowid);
        _ = try update.step();
        try update.reset();
        try drop.bindInt(1, row.rowid);
        _ = try drop.step();
        try drop.reset();
        offset += len;
    }
}

fn sealRun(gpa: Allocator, io: std.Io, db: sqlite.Db, run_id: ?[]const u8) Error!u32 {
    var rows: std.ArrayList(Pending) = .empty;
    defer freePending(gpa, &rows);
    {
        const stmt = try db.prepare("SELECT event_rowid, body FROM pending_payloads WHERE run_id IS ? ORDER BY event_rowid");
        defer stmt.finalize();
        try bindRun(stmt, 1, run_id);
        while (try stmt.step()) {
            const body = try stmt.textAlloc(gpa, 1) orelse return error.CorruptSegment;
            errdefer gpa.free(body);
            try rows.append(gpa, .{ .rowid = stmt.int(0), .body = body });
        }
    }
    var written: u32 = 0;
    var from: usize = 0;
    var size: usize = 0;
    for (rows.items, 0..) |row, i| {
        size += row.body.len;
        if (size >= max_raw_bytes) {
            try seal(gpa, io, db, run_id, rows.items[from .. i + 1]);
            written += 1;
            from = i + 1;
            size = 0;
        }
    }
    if (from < rows.items.len) {
        try seal(gpa, io, db, run_id, rows.items[from..]);
        written += 1;
    }
    return written;
}

const SealCtx = struct { gpa: Allocator, io: std.Io, run_id: ?[]const u8, only_run: bool, min_bytes: i64 };

fn sealAll(ctx: SealCtx, db: sqlite.Db) Error!u32 {
    if (ctx.only_run) return sealRun(ctx.gpa, ctx.io, db, ctx.run_id);
    var runs: std.ArrayList(?[]u8) = .empty;
    defer {
        for (runs.items) |run| if (run) |r| ctx.gpa.free(r);
        runs.deinit(ctx.gpa);
    }
    {
        const stmt = try db.prepare("SELECT run_id FROM pending_payloads GROUP BY run_id HAVING SUM(length(CAST(body AS BLOB))) >= ?");
        defer stmt.finalize();
        try stmt.bindInt(1, ctx.min_bytes);
        while (try stmt.step()) {
            const run = try stmt.textAlloc(ctx.gpa, 0);
            errdefer if (run) |r| ctx.gpa.free(r);
            try runs.append(ctx.gpa, run);
        }
    }
    var written: u32 = 0;
    for (runs.items) |run| written += try sealRun(ctx.gpa, ctx.io, db, run);
    return written;
}

/// Seals one run's pending bodies, or every run holding at least `min_bytes` of them. Opens its
/// own transaction (a savepoint inside one), so a failure seals nothing.
pub fn sealPending(gpa: Allocator, io: std.Io, db: sqlite.Db, run_id: ?[]const u8, only_run: bool, min_bytes: i64) Error!u32 {
    return atomic(db, SealCtx{ .gpa = gpa, .io = io, .run_id = run_id, .only_run = only_run, .min_bytes = min_bytes }, sealAll);
}

/// Runs `f(ctx, db)` as one unit: BEGIN IMMEDIATE when no transaction is open, otherwise a
/// savepoint inside the caller's transaction (the manager appends a run's end event in one).
pub fn atomic(db: sqlite.Db, ctx: anytype, comptime f: anytype) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
    if (!db.inTransaction()) return db.transaction(ctx, f);
    try db.exec("SAVEPOINT logs_atomic");
    const result = f(ctx, db) catch |err| {
        db.exec("ROLLBACK TO logs_atomic") catch |e| std.log.warn("rollback to savepoint after {t} failed: {t}", .{ err, e });
        db.exec("RELEASE logs_atomic") catch |e| std.log.warn("release savepoint after {t} failed: {t}", .{ err, e });
        return err;
    };
    try db.exec("RELEASE logs_atomic");
    return result;
}

/// The bytes [offset, offset + len) of a segment's raw payload, clamped like Buffer.subarray;
/// null when the segment row is missing. The caller frees the slice.
pub fn readSegmentBody(gpa: Allocator, db: sqlite.Db, segment_id: []const u8, offset: i64, len: i64) Error!?[]u8 {
    const stmt = try db.prepare("SELECT bytes, raw_len FROM segments WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, segment_id);
    if (!try stmt.step()) return null;
    const compressed = try stmt.blob(0) orelse return error.CorruptSegment;
    const raw_len = stmt.int(1);
    if (raw_len < 0 or raw_len > max_segment_raw) return error.CorruptSegment;
    const raw = try gpa.alloc(u8, @intCast(raw_len));
    defer gpa.free(raw);
    const got = zstd.ZSTD_decompress(raw.ptr, raw.len, compressed.ptr, compressed.len);
    if (zstd.ZSTD_isError(got) != 0 or got != raw.len) return error.CorruptSegment;
    const start: usize = @intCast(std.math.clamp(offset, 0, raw_len));
    const end: usize = @intCast(std.math.clamp(offset + len, @as(i64, @intCast(start)), raw_len));
    return try gpa.dupe(u8, raw[start..end]);
}
