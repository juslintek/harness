//! Incremental tailers for the agent CLIs' usage logs, port of code/src/server/features/usage/tail.ts.
//!
//! Memory: a file is read in `chunk_bytes` pieces into one reused buffer, lines are slices of it,
//! and each line is parsed in an arena that is reset before the next one. Nothing scales with the
//! size of the file or the number of files; only a single line longer than `max_line_bytes` is
//! dropped (TS would hold it whole). The database is touched only inside `App.withLock`, one
//! batch of lines at a time, and never while the file is being read.
const std = @import("std");
const app_mod = @import("../app.zig");
const sqlite = @import("../db/sqlite.zig");
const ids = @import("../ids.zig");
const parity = @import("../parity.zig");
const manager = @import("../runtimes/manager.zig");
const types = @import("../runtimes/types.zig");
const claude_log = @import("claude_log.zig");
const codex_log = @import("codex_log.zig");
const quota = @import("quota.zig");

const App = app_mod.App;
const State = app_mod.State;

pub const Source = struct {
    name: Name,
    root: []const u8,
    /// Sessions whose cwd is under this dir belong to harness runs, which record their own usage.
    exclude_cwd_under: ?[]const u8 = null,

    pub const Name = enum { claude, codex };
};

/// Appends an event; runs under the App lock. The logs slice wires its redacting appender here; the
/// default is the plain insert, which is the same row for a usage event (no body, no command).
pub const AppendFn = *const fn (ctx: ?*anyopaque, db: sqlite.Db, event: types.NewEvent, now_ms: i64) anyerror!void;

pub const Options = struct {
    /// `HARNESS_TAIL_BACKFILL_DAYS`, resolved by `backfillDaysFromEnv`.
    backfill_days: f64 = 30,
    chunk_bytes: usize = 1024 * 1024,
    batch_lines: usize = 500,
    max_line_bytes: usize = 8 * 1024 * 1024,
    append: ?AppendFn = null,
    append_ctx: ?*anyopaque = null,
    clock: *const fn (io: std.Io) i64 = ids.nowMs,
};

const day_ms: f64 = 86_400_000;

/// `Number(process.env.HARNESS_TAIL_BACKFILL_DAYS ?? 30)`, 30 again when it is not a finite number
/// of at least zero. An empty value is 0 days, as `Number("")` is 0.
pub fn backfillDaysFromEnv(value: ?[]const u8) f64 {
    const days = parity.jsNumber(value orelse return 30);
    return if (std.math.isFinite(days) and days >= 0) days else 30;
}

const first_cwd_bytes = 65536;

pub const Tailer = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    app: *App,
    sources: []const Source,
    options: Options = .{},
    sweeping: std.atomic.Value(bool) = .init(false),

    pub fn init(gpa: std.mem.Allocator, io: std.Io, app: *App, sources: []const Source, options: Options) Tailer {
        return .{ .gpa = gpa, .io = io, .app = app, .sources = sources, .options = options };
    }

    /// One pass over every source; the number of usage events added. A pass that starts while
    /// another is running returns 0.
    pub fn sweep(t: *Tailer) !u64 {
        if (t.sweeping.cmpxchgStrong(false, true, .acquire, .monotonic) != null) return 0;
        defer t.sweeping.store(false, .release);
        var added: u64 = 0;
        for (t.sources) |source| added += try t.sweepSource(source);
        return added;
    }

    /// `startTailers`: sweeps every `interval_ms` until the task running it is canceled. A failed
    /// sweep is logged and the next tick tries again.
    pub fn run(t: *Tailer, interval_ms: i64) void {
        while (true) {
            t.io.sleep(.fromMilliseconds(interval_ms), .awake) catch return;
            _ = t.sweep() catch |err| std.log.err("usage tail failed: {t}", .{err});
        }
    }

    fn sweepSource(t: *Tailer, source: Source) !u64 {
        var root = std.Io.Dir.cwd().openDir(t.io, source.root, .{ .iterate = true }) catch |err| switch (err) {
            error.FileNotFound, error.NotDir => return 0,
            else => return err,
        };
        defer root.close(t.io);
        var walker = try root.walkSelectively(t.gpa);
        defer walker.deinit();
        const root_path = std.mem.trimEnd(u8, source.root, "/");
        var added: u64 = 0;
        while (try walker.next(t.io)) |entry| {
            // A glob without `dot: true` skips hidden names at every level.
            if (entry.basename.len == 0 or entry.basename[0] == '.') continue;
            switch (entry.kind) {
                .directory => if (source.name == .codex or entry.depth() < 2) try walker.enter(t.io, entry),
                .file => {
                    if (!matches(source.name, entry.basename, entry.depth())) continue;
                    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
                    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ root_path, entry.path }) catch continue;
                    added += t.tailFile(source, entry.dir, entry.basename, path) catch |err| blk: {
                        // One vanished or unreadable file must not starve the rest of the sweep.
                        std.log.warn("usage tail skipped {s}: {t}", .{ path, err });
                        break :blk 0;
                    };
                },
                else => {},
            }
        }
        return added;
    }

    fn tailFile(t: *Tailer, source: Source, dir: std.Io.Dir, basename: []const u8, path: []const u8) !u64 {
        var file = try dir.openFile(t.io, basename, .{});
        defer file.close(t.io);
        const st = try file.stat(t.io);
        const size: u64 = st.size;
        const mtime: i64 = @intCast(@divFloor(st.mtime.toNanoseconds(), std.time.ns_per_ms));
        const saved = try t.withDb(&StoredArgs{ .path = path }, storedOffset);
        const cutoff = t.backfillCutoff();
        if (saved == null and @as(f64, @floatFromInt(mtime)) < cutoff) {
            try t.saveOffset(path, size, mtime);
            return 0;
        }
        // A shrunk file was rewritten; dedupe keys make the rescan safe.
        const start: u64 = if (saved) |s| (if (s.offset <= size) s.offset else 0) else 0;
        if (saved) |s| if (start == size and s.mtime == mtime) return 0;
        const session_id = sessionIdOf(basename);
        if (try t.withDb(&LoggedArgs{ .session_id = session_id }, loggedViaAcp) or
            try t.inHarnessWorktree(file, source.exclude_cwd_under))
        {
            try t.saveOffset(path, size, mtime);
            return 0;
        }
        return t.readFrom(source.name, file, path, session_id, start, size, mtime);
    }

    fn backfillCutoff(t: *Tailer) f64 {
        return @as(f64, @floatFromInt(t.options.clock(t.io))) - t.options.backfill_days * day_ms;
    }

    fn readFrom(t: *Tailer, name: Source.Name, file: std.Io.File, path: []const u8, session_id: []const u8, start: u64, size: u64, mtime: i64) !u64 {
        const chunk_bytes = t.options.chunk_bytes;
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(t.gpa);
        try buf.ensureTotalCapacity(t.gpa, chunk_bytes);
        var arena: std.heap.ArenaAllocator = .init(t.gpa);
        defer arena.deinit();
        var lines: std.ArrayList(Line) = .empty;
        defer lines.deinit(t.gpa);
        var added: u64 = 0;
        var read_pos = start;
        // File offset of buf[0]; the buffer holds the unfinished tail of the last chunk first.
        var buf_start = start;
        var discarding = false;
        while (read_pos < size) {
            const want: usize = @intCast(@min(chunk_bytes, size - read_pos));
            const old_len = buf.items.len;
            try buf.resize(t.gpa, old_len + want);
            const n = try file.readPositionalAll(t.io, buf.items[old_len..], read_pos);
            buf.shrinkRetainingCapacity(old_len + n);
            if (n == 0) break;
            read_pos += n;
            lines.clearRetainingCapacity();
            var pos: usize = 0;
            if (discarding) {
                // Skipping the rest of an oversized line.
                const nl = std.mem.findScalar(u8, buf.items, '\n') orelse {
                    buf.clearRetainingCapacity();
                    buf_start = read_pos;
                    try t.saveOffset(path, read_pos, mtime);
                    continue;
                };
                discarding = false;
                pos = nl + 1;
            }
            while (std.mem.findScalarPos(u8, buf.items, pos, '\n')) |end| {
                try lines.append(t.gpa, .{ .text = buf.items[pos..end], .offset = buf_start + pos });
                pos = end + 1;
            }
            added += try t.applyBatches(name, path, session_id, lines.items, &arena);
            const carry_len = buf.items.len - pos;
            std.mem.copyForwards(u8, buf.items[0..carry_len], buf.items[pos..]);
            buf.shrinkRetainingCapacity(carry_len);
            buf_start += pos;
            if (carry_len > t.options.max_line_bytes) {
                buf.clearRetainingCapacity();
                buf_start = read_pos;
                discarding = true;
            }
            try t.saveOffset(path, buf_start, mtime);
        }
        return added;
    }

    fn applyBatches(t: *Tailer, name: Source.Name, path: []const u8, session_id: []const u8, lines: []const Line, arena: *std.heap.ArenaAllocator) !u64 {
        var added: u64 = 0;
        var i: usize = 0;
        while (i < lines.len) : (i += t.options.batch_lines) {
            const batch = lines[i..@min(lines.len, i + t.options.batch_lines)];
            added += try t.withDb(&BatchArgs{ .t = t, .name = name, .path = path, .session_id = session_id, .lines = batch, .arena = arena }, applyBatch);
        }
        return added;
    }

    // ---- locked helpers ----

    fn withDb(t: *Tailer, ctx: anytype, comptime f: anytype) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
        const Wrap = struct {
            fn call(c: @TypeOf(ctx), state: *State) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
                const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
                return f(c, db);
            }
        };
        return t.app.withLock(ctx, Wrap.call);
    }

    const StoredArgs = struct { path: []const u8 };
    const Offset = struct { offset: u64, mtime: i64 };

    fn storedOffset(args: *const StoredArgs, db: sqlite.Db) anyerror!?Offset {
        const stmt = try db.prepare("SELECT offset, mtime FROM tail_offsets WHERE path = ?");
        defer stmt.finalize();
        try stmt.bindText(1, args.path);
        if (!try stmt.step()) return null;
        return .{ .offset = @intCast(@max(0, stmt.int(0))), .mtime = stmt.int(1) };
    }

    const SaveArgs = struct { path: []const u8, offset: u64, mtime: i64 };

    fn saveOffsetLocked(args: *const SaveArgs, db: sqlite.Db) anyerror!void {
        const stmt = try db.prepare(
            "INSERT INTO tail_offsets (path, offset, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime",
        );
        defer stmt.finalize();
        try stmt.bindText(1, args.path);
        try stmt.bindInt(2, std.math.cast(i64, args.offset) orelse return error.OffsetOverflow);
        try stmt.bindInt(3, args.mtime);
        _ = try stmt.step();
    }

    fn saveOffset(t: *Tailer, path: []const u8, offset: u64, mtime: i64) !void {
        try t.withDb(&SaveArgs{ .path = path, .offset = offset, .mtime = mtime }, saveOffsetLocked);
    }

    const LoggedArgs = struct { session_id: []const u8 };

    fn loggedViaAcp(args: *const LoggedArgs, db: sqlite.Db) anyerror!bool {
        const stmt = try db.prepare("SELECT 1 FROM events WHERE gen_ai_conversation_id = ? AND COALESCE(source, '') != 'tail' LIMIT 1");
        defer stmt.finalize();
        try stmt.bindText(1, args.session_id);
        return try stmt.step();
    }

    const BatchArgs = struct {
        t: *Tailer,
        name: Source.Name,
        path: []const u8,
        session_id: []const u8,
        lines: []const Line,
        arena: *std.heap.ArenaAllocator,
    };

    /// One transaction per batch. The lines are parsed under the lock: parsing is microseconds,
    /// and the batch is at most `batch_lines` of them.
    fn applyBatch(args: *const BatchArgs, db: sqlite.Db) anyerror!u64 {
        const dedupe = try db.prepare("SELECT 1 FROM events WHERE dedupe_key = ?");
        defer dedupe.finalize();
        const Run = struct {
            args: *const BatchArgs,
            dedupe: sqlite.Stmt,
            fn go(self: @This(), db_: sqlite.Db) anyerror!u64 {
                const a = self.args;
                const t = a.t;
                const now = t.options.clock(t.io);
                const ctx: claude_log.LineContext = .{ .file = a.path, .session_id = a.session_id };
                var n: u64 = 0;
                for (a.lines) |line| {
                    _ = a.arena.reset(.retain_capacity);
                    if (parity.jsTrim(line.text).len == 0) continue;
                    const arena = a.arena.allocator();
                    const parsed = switch (a.name) {
                        .claude => try claude_log.parseClaudeLine(arena, line.text, line.offset, ctx),
                        .codex => try codex_log.parseCodexLine(arena, line.text, line.offset, ctx),
                    };
                    for (parsed.quotas()) |q| try quota.insertSnapshotIfChanged(db_, t.io, q, now);
                    if (parsed.event) |event| {
                        if (try t.appendNew(db_, self.dedupe, event, now)) n += 1;
                    }
                }
                return n;
            }
        };
        return db.transaction(Run{ .args = args, .dedupe = dedupe }, Run.go);
    }

    /// `appendEvent` for a usage event: refused (false) when the dedupe key is already stored.
    fn appendNew(t: *Tailer, db: sqlite.Db, dedupe: sqlite.Stmt, event: types.NewEvent, now: i64) !bool {
        if (event.dedupe_key) |key| {
            try dedupe.reset();
            try dedupe.bindText(1, key);
            if (try dedupe.step()) return false;
        }
        if (t.options.append) |append| {
            try append(t.options.append_ctx, db, event, now);
        } else {
            const id = ids.uuidV7(t.io);
            try manager.insertEventPlain(db, event, &id, now);
        }
        return true;
    }

    fn inHarnessWorktree(t: *Tailer, file: std.Io.File, dir: ?[]const u8) !bool {
        const d = dir orelse return false;
        const buf = try t.gpa.alloc(u8, first_cwd_bytes);
        defer t.gpa.free(buf);
        const n = try file.readPositionalAll(t.io, buf, 0);
        var arena: std.heap.ArenaAllocator = .init(t.gpa);
        defer arena.deinit();
        const cwd = try firstCwd(arena.allocator(), buf[0..n]) orelse return false;
        if (isUnder(cwd, d)) return true;
        var real_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const real_len = std.Io.Dir.cwd().realPathFile(t.io, d, &real_buf) catch return false;
        return isUnder(cwd, real_buf[0..real_len]);
    }
};

const Line = struct { text: []const u8, offset: u64 };

fn isUnder(cwd: []const u8, dir: []const u8) bool {
    return std.mem.eql(u8, cwd, dir) or (std.mem.startsWith(u8, cwd, dir) and cwd.len > dir.len and cwd[dir.len] == '/') or
        (dir.len > 0 and dir[dir.len - 1] == '/' and std.mem.startsWith(u8, cwd, dir));
}

/// The glob of each source: claude `*/*.jsonl`, codex `**/rollout-*.jsonl`.
fn matches(name: Source.Name, basename: []const u8, depth: usize) bool {
    if (!std.mem.endsWith(u8, basename, ".jsonl")) return false;
    return switch (name) {
        .claude => depth == 2,
        .codex => std.mem.startsWith(u8, basename, "rollout-"),
    };
}

fn isHex(ch: u8) bool {
    return std.ascii.isHex(ch);
}

/// The first UUID in the file name, else the name without `.jsonl` (`basename(file, ".jsonl")`).
pub fn sessionIdOf(basename: []const u8) []const u8 {
    const len = 36;
    var i: usize = 0;
    while (i + len <= basename.len) : (i += 1) {
        const s = basename[i..][0..len];
        var ok = true;
        for (s, 0..) |ch, k| {
            const dash = k == 8 or k == 13 or k == 18 or k == 23;
            if (if (dash) ch != '-' else !isHex(ch)) {
                ok = false;
                break;
            }
        }
        if (ok) return s;
    }
    return if (std.mem.endsWith(u8, basename, ".jsonl")) basename[0 .. basename.len - ".jsonl".len] else basename;
}

/// `firstCwd`: the first line with a non-empty `"cwd":"..."`, JSON-decoded. A string JSON refuses
/// is an error, as `JSON.parse` throws there.
fn firstCwd(arena: std.mem.Allocator, head: []const u8) !?[]const u8 {
    const needle = "\"cwd\":\"";
    var lines = std.mem.splitScalar(u8, head, '\n');
    while (lines.next()) |line| {
        var from: usize = 0;
        while (std.mem.find(u8, line[from..], needle)) |rel| {
            const body_start = from + rel + needle.len;
            var i = body_start;
            const close: ?usize = while (i < line.len) : (i += 1) {
                if (line[i] == '"') break i;
                if (line[i] == '\\') {
                    if (i + 1 >= line.len) break null;
                    i += 1;
                }
            } else null;
            if (close) |end| {
                if (end > body_start) {
                    const quoted = line[body_start - 1 .. end + 1];
                    return try std.json.parseFromSliceLeaky([]const u8, arena, quoted, .{});
                }
                break;
            }
            from = body_start;
        }
    }
    return null;
}

// ---- tests ----

const Fixture = @import("../auth/fixture.zig").Fixture;
const testing = std.testing;

const session = "11111111-2222-4333-8444-555555555555";
const other_session = "99999999-2222-4333-8444-555555555555";

const Env = struct {
    fx: *Fixture,
    tmp: std.testing.TmpDir,
    root: []u8,
    sources: [2]Source,
    tailer: Tailer,

    fn create(options: Options) !*Env {
        const self = try testing.allocator.create(Env);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, testing.io);
        errdefer self.fx.destroy();
        self.tmp = std.testing.tmpDir(.{ .iterate = true });
        errdefer self.tmp.cleanup();
        var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const len = try self.tmp.dir.realPath(testing.io, &buf);
        self.root = try testing.allocator.dupe(u8, buf[0..len]);
        errdefer testing.allocator.free(self.root);
        try self.tmp.dir.createDirPath(testing.io, "claude/proj");
        try self.tmp.dir.createDirPath(testing.io, "codex/2026/11/02");
        self.sources = .{
            .{ .name = .claude, .root = try std.fmt.allocPrint(testing.allocator, "{s}/claude", .{self.root}) },
            .{ .name = .codex, .root = try std.fmt.allocPrint(testing.allocator, "{s}/codex", .{self.root}) },
        };
        self.tailer = Tailer.init(testing.allocator, testing.io, &self.fx.app, &self.sources, options);
        return self;
    }

    fn destroy(self: *Env) void {
        testing.allocator.free(self.sources[0].root);
        testing.allocator.free(self.sources[1].root);
        testing.allocator.free(self.root);
        self.tmp.cleanup();
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn write(self: *Env, sub_path: []const u8, data: []const u8) !void {
        try self.tmp.dir.writeFile(testing.io, .{ .sub_path = sub_path, .data = data });
    }

    fn append(self: *Env, sub_path: []const u8, data: []const u8) !void {
        var file = try self.tmp.dir.openFile(testing.io, sub_path, .{ .mode = .read_write });
        defer file.close(testing.io);
        const len = try file.length(testing.io);
        try file.writePositionalAll(testing.io, data, len);
    }

    fn scalar(self: *Env, comptime sql: [:0]const u8) !i64 {
        const stmt = try self.fx.db.prepare(sql);
        defer stmt.finalize();
        _ = try stmt.step();
        return stmt.int(0);
    }

    fn usageEvents(self: *Env) !i64 {
        return self.scalar("SELECT count(*) FROM events WHERE kind='usage'");
    }
};

fn claudeLine(buf: []u8, id: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf,
        \\{{"type":"assistant","timestamp":"2026-11-02T01:00:00.000Z","message":{{"id":"{s}","model":"model-a","usage":{{"input_tokens":3,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}}}}}}
        \\
    , .{id});
}

fn codexLine(buf: []u8, used: u32, with_info: bool, timestamp: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf,
        \\{{"timestamp":"{s}","type":"event_msg","payload":{{"type":"token_count","info":{s},"rate_limits":{{"primary":{{"used_percent":{d},"window_minutes":300,"resets_at":4102444800}},"secondary":{{"used_percent":5,"window_minutes":10080,"resets_at":4102448400}}}}}}}}
        \\
    , .{
        timestamp,
        if (with_info) "{\"last_token_usage\":{\"input_tokens\":50,\"cached_input_tokens\":20,\"output_tokens\":9,\"reasoning_output_tokens\":4}}" else "null",
        used,
    });
}

fn farFuture(_: std.Io) i64 {
    return 4_000_000_000_000;
}

const claude_file = "claude/proj/" ++ session ++ ".jsonl";
const codex_file = "codex/2026/11/02/rollout-2026-11-02T01-00-00-" ++ session ++ ".jsonl";
const ts0 = "2026-11-02T01:00:00.000Z";

test "usage: a claude line becomes one usage event, a rerun adds none" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [512]u8 = undefined;
    try env.write(claude_file, try claudeLine(&b, "msg_1"));
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
    const stmt = try env.fx.db.prepare("SELECT gen_ai_request_model, gen_ai_usage_input_tokens, cache_read_tokens, cache_write_tokens, source, dedupe_key, gen_ai_conversation_id, ts, agent, gen_ai_operation_name FROM events WHERE kind='usage'");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqualStrings("model-a", (try stmt.text(0)).?);
    try testing.expectEqual(@as(i64, 3), stmt.int(1));
    try testing.expectEqual(@as(i64, 100), stmt.int(2));
    try testing.expectEqual(@as(i64, 7), stmt.int(3));
    try testing.expectEqualStrings("tail", (try stmt.text(4)).?);
    try testing.expectEqualStrings("claude:msg_1", (try stmt.text(5)).?);
    try testing.expectEqualStrings(session, (try stmt.text(6)).?);
    try testing.expectEqual(@as(i64, 1_793_581_200_000), stmt.int(7));
    try testing.expectEqualStrings("claude", (try stmt.text(8)).?);
    try testing.expectEqualStrings("chat", (try stmt.text(9)).?);
}

test "usage: only new bytes are read and a partial last line waits" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b1: [512]u8 = undefined;
    var b2: [512]u8 = undefined;
    const second = try claudeLine(&b2, "msg_2");
    const first = try claudeLine(&b1, "msg_1");
    var joined: [1024]u8 = undefined;
    @memcpy(joined[0..first.len], first);
    @memcpy(joined[first.len..][0..20], second[0..20]);
    try env.write(claude_file, joined[0 .. first.len + 20]);
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
    try env.append(claude_file, second[20..]);
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
    try testing.expectEqual(@as(i64, 2), try env.usageEvents());
}

test "usage: truncation rescans from zero without duplicating" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b1: [512]u8 = undefined;
    var b2: [512]u8 = undefined;
    var b3: [512]u8 = undefined;
    var two: [1024]u8 = undefined;
    const l1 = try claudeLine(&b1, "msg_1");
    const l2 = try claudeLine(&b2, "msg_2");
    @memcpy(two[0..l1.len], l1);
    @memcpy(two[l1.len..][0..l2.len], l2);
    try env.write(claude_file, two[0 .. l1.len + l2.len]);
    _ = try env.tailer.sweep();
    try env.write(claude_file, "");
    try env.write(claude_file, try claudeLine(&b3, "msg_3"));
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
    try testing.expectEqual(@as(i64, 3), try env.usageEvents());
}

test "usage: codex token_count gives a usage event and quota snapshots" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [1024]u8 = undefined;
    try env.write(codex_file, try codexLine(&b, 42, true, ts0));
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
    const ev = try env.fx.db.prepare("SELECT gen_ai_usage_input_tokens, cache_read_tokens, reasoning_tokens, agent FROM events WHERE kind='usage'");
    defer ev.finalize();
    try testing.expect(try ev.step());
    try testing.expectEqual(@as(i64, 30), ev.int(0));
    try testing.expectEqual(@as(i64, 20), ev.int(1));
    try testing.expectEqual(@as(i64, 4), ev.int(2));
    try testing.expectEqualStrings("codex", (try ev.text(3)).?);
    const snap = try env.fx.db.prepare("SELECT used_percent, resets_at FROM quota_snapshots WHERE window='primary'");
    defer snap.finalize();
    try testing.expect(try snap.step());
    try testing.expectEqual(@as(f64, 42), snap.real(0));
    try testing.expectEqual(@as(i64, 4102444800000), snap.int(1));
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const view = try quota.latestQuota(arena.allocator(), env.fx.db, 1000);
    for (view) |q| {
        if (std.mem.eql(u8, q.provider, "codex") and std.mem.eql(u8, q.window, "secondary")) try testing.expectEqual(@as(f64, 5), q.used_percent.?);
        if (std.mem.eql(u8, q.provider, "claude")) try testing.expect(q.used_percent == null);
    }
}

test "usage: an unchanged quota is not snapshotted twice, an info-less token_count only snapshots" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [3][1024]u8 = undefined;
    const text = try std.mem.concat(testing.allocator, u8, &.{
        try codexLine(&b[0], 42, true, ts0),
        try codexLine(&b[1], 42, true, ts0),
        try codexLine(&b[2], 43, false, ts0),
    });
    defer testing.allocator.free(text);
    try env.write(codex_file, text);
    _ = try env.tailer.sweep();
    try testing.expectEqual(@as(i64, 3), try env.scalar("SELECT count(*) FROM quota_snapshots"));
    try testing.expectEqual(@as(i64, 2), try env.usageEvents());
}

test "usage: sessions already logged through ACP are skipped" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    try env.fx.run("INSERT INTO events (id, ts, kind, gen_ai_conversation_id, source) VALUES ('e1', 1, 'message', '" ++ session ++ "', 'acp')");
    var b: [1024]u8 = undefined;
    try env.write(claude_file, try claudeLine(&b, "msg_1"));
    try env.write(codex_file, try codexLine(&b, 1, true, ts0));
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
    // The skip is remembered: the offset moved to the end of both files.
    try testing.expectEqual(@as(i64, 2), try env.scalar("SELECT count(*) FROM tail_offsets"));
}

test "usage: a quota's latest follows the log timestamp, not the ingest order" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [1024]u8 = undefined;
    try env.write("codex/2026/11/02/rollout-b-" ++ "21111111-2222-4333-8444-555555555555" ++ ".jsonl", try codexLine(&b, 60, true, "2026-11-02T05:00:00.000Z"));
    _ = try env.tailer.sweep();
    try env.write(codex_file, try codexLine(&b, 10, true, "2026-11-02T01:00:00.000Z"));
    _ = try env.tailer.sweep();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const view = try quota.latestQuota(arena.allocator(), env.fx.db, 1000);
    for (view) |q| {
        if (std.mem.eql(u8, q.provider, "codex") and std.mem.eql(u8, q.window, "primary")) try testing.expectEqual(@as(f64, 60), q.used_percent.?);
    }
}

test "usage: claude sessions whose cwd is under the harness worktrees dir are skipped" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    const worktrees = try std.fmt.allocPrint(testing.allocator, "{s}/home/worktrees", .{env.root});
    defer testing.allocator.free(worktrees);
    env.sources[0].exclude_cwd_under = worktrees;
    var b: [512]u8 = undefined;
    const inside = try std.fmt.allocPrint(testing.allocator, "{{\"cwd\":\"{s}/run1\",\"sessionId\":\"{s}\"}}\n{s}", .{ worktrees, session, try claudeLine(&b, "m1") });
    defer testing.allocator.free(inside);
    try env.write(claude_file, inside);
    var b2: [512]u8 = undefined;
    const elsewhere = try std.fmt.allocPrint(testing.allocator, "{{\"cwd\":\"{s}/elsewhere\"}}\n{s}", .{ env.root, try claudeLine(&b2, "m2") });
    defer testing.allocator.free(elsewhere);
    try env.write("claude/proj/" ++ other_session ++ ".jsonl", elsewhere);
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
    try testing.expectEqual(@as(i64, 1), try env.usageEvents());
}

test "usage: first sight of a file older than the backfill window stores its size and reads nothing" {
    const env = try Env.create(.{ .backfill_days = 30, .clock = farFuture });
    defer env.destroy();
    var b: [512]u8 = undefined;
    const line = try claudeLine(&b, "msg_old");
    try env.write(claude_file, line);
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
    const stmt = try env.fx.db.prepare("SELECT offset FROM tail_offsets");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqual(@as(i64, @intCast(line.len)), stmt.int(0));
    // Known files are always read, however old.
    var b2: [512]u8 = undefined;
    try env.append(claude_file, try claudeLine(&b2, "msg_new"));
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
}

test "usage: a file larger than the chunk is read in full, lines cut by a chunk border included" {
    const env = try Env.create(.{ .backfill_days = 1e9, .chunk_bytes = 4096 });
    defer env.destroy();
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    const total = 300;
    for (0..total) |i| {
        var id: [64]u8 = undefined;
        var b: [512]u8 = undefined;
        // Multi-byte characters, so some chunk border lands inside one.
        const name = try std.fmt.bufPrint(&id, "msg_{d}_{s}", .{ i, "ééé" });
        try out.writer.writeAll(try claudeLine(&b, name));
    }
    try env.write(claude_file, out.written());
    try testing.expect(out.written().len > 4096 * 4);
    try testing.expectEqual(@as(u64, total), try env.tailer.sweep());
    try testing.expectEqual(@as(i64, total), try env.usageEvents());
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
}

test "usage: an oversized line is dropped and the lines after it still count" {
    const env = try Env.create(.{ .backfill_days = 1e9, .chunk_bytes = 1024, .max_line_bytes = 3000 });
    defer env.destroy();
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    var b: [512]u8 = undefined;
    try out.writer.writeAll(try claudeLine(&b, "before"));
    try out.writer.splatByteAll('x', 9000);
    try out.writer.writeAll("\n");
    try out.writer.writeAll(try claudeLine(&b, "after"));
    try env.write(claude_file, out.written());
    try testing.expectEqual(@as(u64, 2), try env.tailer.sweep());
}

test "usage: a unreadable entry does not stop the sweep" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [512]u8 = undefined;
    try env.write("claude/proj/broken.jsonl", try claudeLine(&b, "msg_bad"));
    var broken = try env.tmp.dir.openFile(testing.io, "claude/proj/broken.jsonl", .{});
    try broken.setPermissions(testing.io, .fromMode(0));
    broken.close(testing.io);
    try env.tmp.dir.createDirPath(testing.io, "claude/other");
    try env.write("claude/other/" ++ other_session ++ ".jsonl", try claudeLine(&b, "msg_ok"));
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
}

test "usage: hidden files and other depths are not tailed" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [512]u8 = undefined;
    const line = try claudeLine(&b, "m");
    try env.write("claude/proj/.hidden.jsonl", line);
    try env.write("claude/top.jsonl", line);
    try env.tmp.dir.createDirPath(testing.io, "claude/proj/deep");
    try env.write("claude/proj/deep/x.jsonl", line);
    try env.write("claude/proj/not-jsonl.txt", line);
    try env.write("codex/2026/11/02/other-" ++ session ++ ".jsonl", line);
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
}

test "usage: a missing root is skipped" {
    const env = try Env.create(.{});
    defer env.destroy();
    var sources = [_]Source{.{ .name = .claude, .root = "/nonexistent/harness-usage-root" }};
    var tailer = Tailer.init(testing.allocator, testing.io, &env.fx.app, &sources, .{});
    try testing.expectEqual(@as(u64, 0), try tailer.sweep());
}

test "usage: a sweep that overlaps another is skipped" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [512]u8 = undefined;
    try env.write(claude_file, try claudeLine(&b, "msg_1"));
    env.tailer.sweeping.store(true, .release);
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
    env.tailer.sweeping.store(false, .release);
    try testing.expectEqual(@as(u64, 1), try env.tailer.sweep());
}

test "usage: the run loop picks up new lines on its timer and stops when canceled" {
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    var b: [512]u8 = undefined;
    try env.write(claude_file, try claudeLine(&b, "msg_t"));
    var future = try testing.io.concurrent(Tailer.run, .{ &env.tailer, 10 });
    var waited: usize = 0;
    while (waited < 200 and try env.usageEvents() == 0) : (waited += 1) try testing.io.sleep(.fromMilliseconds(10), .awake);
    future.cancel(testing.io);
    try testing.expectEqual(@as(i64, 1), try env.usageEvents());
}

test "usage: an offset beyond i64 is an error, not a panic" {
    const fx = try Fixture.create(testing.allocator, testing.io);
    defer fx.destroy();
    const args: Tailer.SaveArgs = .{ .path = "/p", .offset = std.math.maxInt(u64), .mtime = 1 };
    try testing.expectError(error.OffsetOverflow, Tailer.saveOffsetLocked(&args, fx.db));
}

test "usage: session id and cwd extraction" {
    try testing.expectEqualStrings(session, sessionIdOf("rollout-2026-11-02T01-00-00-" ++ session ++ ".jsonl"));
    try testing.expectEqualStrings(session, sessionIdOf(session ++ ".jsonl"));
    try testing.expectEqualStrings("broken", sessionIdOf("broken.jsonl"));
    try testing.expectEqualStrings("noext", sessionIdOf("noext"));
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("/a b/\"c\"", (try firstCwd(a, "{\"x\":1}\n{\"cwd\":\"\",\"y\":1}\n{\"cwd\":\"/a b/\\\"c\\\"\"}")).?);
    try testing.expect(try firstCwd(a, "{\"cwd\":\"/cut") == null);
    try testing.expect(try firstCwd(a, "nothing here") == null);
    try testing.expectError(error.SyntaxError, firstCwd(a, "{\"cwd\":\"\\q\"}"));
    try testing.expect(isUnder("/w/run1", "/w"));
    try testing.expect(isUnder("/w", "/w"));
    try testing.expect(!isUnder("/wx", "/w"));
    try testing.expectEqual(@as(f64, 30), backfillDaysFromEnv(null));
    try testing.expectEqual(@as(f64, 0), backfillDaysFromEnv(""));
    try testing.expectEqual(@as(f64, 7), backfillDaysFromEnv("7"));
    try testing.expectEqual(@as(f64, 30), backfillDaysFromEnv("-1"));
    try testing.expectEqual(@as(f64, 30), backfillDaysFromEnv("abc"));
}

test "usage: backfill over a large log stays inside a bounded allocator" {
    // About 9 MiB of log read through a 3 MiB allocator: the tailer's heap use cannot scale with
    // the file. SQLite allocates through libc and is not counted; its page cache is capped.
    var storage: [3 * 1024 * 1024]u8 = undefined;
    var fba: std.heap.FixedBufferAllocator = .init(&storage);
    const env = try Env.create(.{ .backfill_days = 1e9 });
    defer env.destroy();
    env.tailer.gpa = fba.allocator();
    var file = try env.tmp.dir.createFile(testing.io, claude_file, .{});
    defer file.close(testing.io);
    var write_buf: [64 * 1024]u8 = undefined;
    var writer = file.writer(testing.io, &write_buf);
    const total = 50_000;
    var line_buf: [512]u8 = undefined;
    var id_buf: [32]u8 = undefined;
    for (0..total) |i| try writer.interface.writeAll(try claudeLine(&line_buf, try std.fmt.bufPrint(&id_buf, "msg_{d}", .{i})));
    try writer.interface.flush();
    try testing.expect(try file.length(testing.io) > 3 * storage.len);
    try testing.expectEqual(@as(u64, total), try env.tailer.sweep());
    try testing.expectEqual(@as(i64, total), try env.usageEvents());
    try testing.expectEqual(@as(u64, 0), try env.tailer.sweep());
}

test {
    _ = @import("claude_log.zig");
    _ = @import("codex_log.zig");
    _ = @import("quota.zig");
    _ = @import("summary.zig");
    _ = @import("routes.zig");
}
