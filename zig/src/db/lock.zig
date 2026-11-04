//! Home lock, the same protocol as lockHome in code/src/server/db/db.ts so that a TS server and a
//! Zig server on one HARNESS_HOME exclude each other: a pid file, no flock. Every look at
//! harness.lock and every write of it happens while holding harness.lock.takeover, an O_EXCL file
//! that exists only for those few calls. A path has no compare-and-swap, so without the mutex two
//! servers that read the same dead pid could each replace the lock, or one could remove a lock
//! another had just created. A mutex left behind by a crash inside that window is not guessed at.
//!
//! Everything goes through the home directory handle, so the checks and the opens name the same
//! directory even if a path component is swapped afterwards.
const std = @import("std");

const Dir = std.Io.Dir;
const Pid = std.c.pid_t;

pub const lock_name = "harness.lock";
pub const mutex_name = "harness.lock.takeover";

/// db.ts: 100 attempts, 20 ms apart.
const takeover_attempts = 100;
const takeover_delay_ms = 20;
/// A real lock holds a pid and a newline; anything longer is junk and counts as stale.
const max_lock_bytes = 4096;
/// Number.isSafeInteger in the TS parser.
const max_safe_integer: u64 = (1 << 53) - 1;

extern "c" fn kill(pid: Pid, sig: c_int) c_int;

/// Filled in when acquire fails with error.AlreadyLocked, for the "already using" message.
pub const Held = struct { pid: u64 = 0 };

/// `home` is borrowed: keep the directory open until `release` has run.
pub const HomeLock = struct {
    io: std.Io,
    home: Dir,
    pid: u64,
    released: bool = false,

    /// Idempotent. Only removes a lock that still holds our pid: after a release another server
    /// may own the file, and a late shutdown path must not delete its lock.
    pub fn release(lock: *HomeLock) void {
        if (lock.released) return;
        lock.released = true;
        // db.ts: a lock that is not a readable regular file is not ours to remove.
        const holder = lockPid(lock.io, lock.home) catch |err| {
            std.log.warn("{s} left in place: {t}", .{ lock_name, err });
            return;
        };
        if (holder != lock.pid) return;
        lock.home.deleteFile(lock.io, lock_name) catch |err| {
            if (err != error.FileNotFound) std.log.warn("cannot remove {s}: {t}", .{ lock_name, err });
        };
    }
};

/// Errors: AlreadyLocked (a live process holds the home, see `held`), NotRegularFile (the lock or
/// mutex path is a symlink or other non-file, remove it), TakeoverHeld (the mutex file stayed for
/// two seconds, remove it if no server is starting), plus I/O errors.
pub fn acquire(io: std.Io, home: Dir, held: *Held) !HomeLock {
    return acquireWith(io, home, held, takeover_attempts, takeover_delay_ms);
}

fn acquireWith(io: std.Io, home: Dir, held: *Held, attempts: usize, delay_ms: i64) !HomeLock {
    const pid = std.math.cast(u64, std.c.getpid()) orelse return error.InvalidPid;
    try takeMutex(io, home, attempts, delay_ms);
    defer dropMutex(io, home);
    if (try lockPid(io, home)) |holder| {
        if (pidAlive(holder)) {
            held.pid = holder;
            return error.AlreadyLocked;
        }
    }
    try writeLock(io, home, pid);
    return .{ .io = io, .home = home, .pid = pid };
}

fn takeMutex(io: std.Io, home: Dir, attempts: usize, delay_ms: i64) !void {
    for (0..attempts) |_| {
        const file = home.createFile(io, mutex_name, .{ .exclusive = true }) catch |err| switch (err) {
            error.PathAlreadyExists => {
                try refuseNonRegular(io, home, mutex_name);
                try io.sleep(.fromMilliseconds(delay_ms), .awake);
                continue;
            },
            else => return err,
        };
        file.close(io);
        return;
    }
    return error.TakeoverHeld;
}

fn dropMutex(io: std.Io, home: Dir) void {
    home.deleteFile(io, mutex_name) catch |err| {
        if (err != error.FileNotFound) std.log.warn("cannot remove {s}: {t}", .{ mutex_name, err });
    };
}

/// The home can be shared with other accounts, so a lock or mutex path that is a symlink (or
/// anything but a regular file) is refused, never followed: writing through it could truncate or
/// create a file outside the home.
fn refuseNonRegular(io: std.Io, home: Dir, name: []const u8) !void {
    const stat = home.statFile(io, name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    if (stat.kind != .file) return error.NotRegularFile;
}

/// Content that is not a positive pid counts as stale: kill(0) would signal our own process group
/// and kill(-n) a whole group, so they must never reach the liveness check.
fn lockPid(io: std.Io, home: Dir) !?u64 {
    try refuseNonRegular(io, home, lock_name);
    var file = home.openFile(io, lock_name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer file.close(io);
    var buf: [max_lock_bytes + 1]u8 = undefined;
    const len = try file.readPositionalAll(io, &buf, 0);
    if (len > max_lock_bytes) return null;
    return parsePid(buf[0..len]);
}

/// db.ts: /^\d+\s*$/ and a safe integer above zero.
fn parsePid(content: []const u8) ?u64 {
    const digits = std.mem.trimEnd(u8, content, " \t\n\r\x0b\x0c");
    if (digits.len == 0) return null;
    for (digits) |ch| if (!std.ascii.isDigit(ch)) return null;
    const pid = std.fmt.parseInt(u64, digits, 10) catch return null;
    return if (pid > 0 and pid <= max_safe_integer) pid else null;
}

/// kill(pid, 0) succeeding or failing with EPERM means the process exists. A pid that does not
/// fit pid_t cannot name a process (process.kill throws there, which db.ts counts as dead).
fn pidAlive(pid: u64) bool {
    const target = std.math.cast(Pid, pid) orelse return false;
    const rc = kill(target, 0);
    return rc == 0 or std.c.errno(rc) == .PERM;
}

/// Written to a private file and renamed over the lock, so a symlink at the lock path is replaced
/// rather than written through, and the lock never exists half written.
fn writeLock(io: std.Io, home: Dir, pid: u64) !void {
    var tmp_buf: [lock_name.len + 32]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buf, lock_name ++ ".{d}.tmp", .{pid});
    home.deleteFile(io, tmp) catch |err| if (err != error.FileNotFound) return err;
    var file = try home.createFile(io, tmp, .{ .exclusive = true, .permissions = .fromMode(0o600) });
    errdefer home.deleteFile(io, tmp) catch |err| std.log.warn("cannot remove {s}: {t}", .{ tmp, err });
    {
        defer file.close(io);
        var line_buf: [32]u8 = undefined;
        try file.writeStreamingAll(io, try std.fmt.bufPrint(&line_buf, "{d}\n", .{pid}));
    }
    try home.rename(tmp, home, lock_name, io);
}

const dead_pid = "2147483647\n";

fn readLockFile(tmp: *std.testing.TmpDir, buf: []u8) ![]const u8 {
    return tmp.dir.readFile(std.testing.io, lock_name, buf);
}

fn expectAbsent(dir: Dir, name: []const u8) !void {
    try std.testing.expectError(error.FileNotFound, dir.access(std.testing.io, name, .{}));
}

test "lock: acquire writes our pid, a second attempt is refused, release frees it" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var held: Held = .{};
    var lock = try acquire(io, tmp.dir, &held);
    var buf: [64]u8 = undefined;
    var expected: [32]u8 = undefined;
    try std.testing.expectEqualStrings(
        try std.fmt.bufPrint(&expected, "{d}\n", .{lock.pid}),
        try readLockFile(&tmp, &buf),
    );
    try expectAbsent(tmp.dir, mutex_name);

    var other: Held = .{};
    try std.testing.expectError(error.AlreadyLocked, acquire(io, tmp.dir, &other));
    try std.testing.expectEqual(lock.pid, other.pid);
    try expectAbsent(tmp.dir, mutex_name);

    lock.release();
    lock.release();
    try expectAbsent(tmp.dir, lock_name);

    var again = try acquire(io, tmp.dir, &held);
    again.release();
}

test "lock: a dead pid is replaced" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = lock_name, .data = dead_pid });

    var held: Held = .{};
    var lock = try acquire(io, tmp.dir, &held);
    defer lock.release();
    var buf: [64]u8 = undefined;
    try std.testing.expect(!std.mem.eql(u8, dead_pid, try readLockFile(&tmp, &buf)));
    try std.testing.expectEqual(@as(u64, 0), held.pid);
}

test "lock: content that is not a positive pid is stale" {
    const io = std.testing.io;
    const junk = [_][]const u8{
        "",                 "abc",        "12abc",    "-5\n", "0\n", "0", "1e3", "+7", " 7", "7 8", "99999999999999999999999",
        "9007199254740993", "4294967297", "\x00\x00",
    };
    for (junk) |content| {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        try tmp.dir.writeFile(io, .{ .sub_path = lock_name, .data = content });
        var held: Held = .{};
        var lock = try acquire(io, tmp.dir, &held);
        lock.release();
    }
}

test "lock: parsePid follows the TS regex" {
    try std.testing.expectEqual(@as(?u64, 42), parsePid("42"));
    try std.testing.expectEqual(@as(?u64, 42), parsePid("0042\n"));
    try std.testing.expectEqual(@as(?u64, 42), parsePid("42 \t\r\n"));
    try std.testing.expectEqual(@as(?u64, max_safe_integer), parsePid("9007199254740991"));
    try std.testing.expectEqual(@as(?u64, null), parsePid("9007199254740992"));
    try std.testing.expectEqual(@as(?u64, null), parsePid("0"));
    try std.testing.expectEqual(@as(?u64, null), parsePid("\n42"));
}

test "lock: our own live pid in the file counts as held" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var line: [32]u8 = undefined;
    const pid: u64 = @intCast(std.c.getpid());
    try tmp.dir.writeFile(io, .{ .sub_path = lock_name, .data = try std.fmt.bufPrint(&line, "{d}\n", .{pid}) });
    var held: Held = .{};
    try std.testing.expectError(error.AlreadyLocked, acquire(io, tmp.dir, &held));
    try std.testing.expectEqual(pid, held.pid);
}

test "lock: a symlinked lock is refused and nothing is written through it" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "target.txt", .data = "keep" });
    try tmp.dir.symLink(io, "target.txt", lock_name, .{});

    var held: Held = .{};
    try std.testing.expectError(error.NotRegularFile, acquire(io, tmp.dir, &held));
    var buf: [16]u8 = undefined;
    try std.testing.expectEqualStrings("keep", try tmp.dir.readFile(io, "target.txt", &buf));
    var link_buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("target.txt", link_buf[0..try tmp.dir.readLink(io, lock_name, &link_buf)]);
    try expectAbsent(tmp.dir, mutex_name);
}

test "lock: a dangling symlink and a directory at the lock path are refused" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var held: Held = .{};

    try tmp.dir.symLink(io, "nowhere", lock_name, .{});
    try std.testing.expectError(error.NotRegularFile, acquire(io, tmp.dir, &held));
    try tmp.dir.deleteFile(io, lock_name);

    try tmp.dir.createDir(io, lock_name, .default_dir);
    try std.testing.expectError(error.NotRegularFile, acquire(io, tmp.dir, &held));
}

test "lock: a symlinked takeover mutex is refused" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.symLink(io, "nowhere", mutex_name, .{});
    var held: Held = .{};
    try std.testing.expectError(error.NotRegularFile, acquire(io, tmp.dir, &held));
    try expectAbsent(tmp.dir, lock_name);
}

test "lock: a mutex left behind stops the takeover without guessing" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = mutex_name, .data = "" });
    var held: Held = .{};
    try std.testing.expectError(error.TakeoverHeld, acquireWith(io, tmp.dir, &held, 3, 1));
    try expectAbsent(tmp.dir, lock_name);
    try tmp.dir.access(io, mutex_name, .{});
}

test "lock: release leaves a lock that holds another pid" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var held: Held = .{};
    var lock = try acquire(io, tmp.dir, &held);
    try tmp.dir.writeFile(io, .{ .sub_path = lock_name, .data = "1\n" });
    lock.release();
    var buf: [16]u8 = undefined;
    try std.testing.expectEqualStrings("1\n", try readLockFile(&tmp, &buf));
}

test "lock: the lock file is private and no temp file is left behind" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    var held: Held = .{};
    var lock = try acquire(io, tmp.dir, &held);
    defer lock.release();
    const stat = try tmp.dir.statFile(io, lock_name, .{});
    try std.testing.expectEqual(@as(std.posix.mode_t, 0o600), stat.permissions.toMode() & 0o777);
    var it = tmp.dir.iterate();
    var count: usize = 0;
    while (try it.next(io)) |entry| {
        try std.testing.expectEqualStrings(lock_name, entry.name);
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), count);
}

test "lock: racing threads in one process produce exactly one owner" {
    const Race = struct {
        wins: std.atomic.Value(u32) = .init(0),
        refused: std.atomic.Value(u32) = .init(0),
        failed: std.atomic.Value(u32) = .init(0),

        fn run(race: *@This(), io: std.Io, home: Dir) void {
            var held: Held = .{};
            if (acquireWith(io, home, &held, 500, 2)) |_| {
                _ = race.wins.fetchAdd(1, .monotonic);
            } else |err| {
                const counter = if (err == error.AlreadyLocked) &race.refused else &race.failed;
                _ = counter.fetchAdd(1, .monotonic);
            }
        }
    };
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var race: Race = .{};
    var threads: [8]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Race.run, .{ &race, io, tmp.dir });
    for (threads) |thread| thread.join();
    try std.testing.expectEqual(@as(u32, 1), race.wins.load(.monotonic));
    try std.testing.expectEqual(@as(u32, 7), race.refused.load(.monotonic));
    try std.testing.expectEqual(@as(u32, 0), race.failed.load(.monotonic));
    try expectAbsent(tmp.dir, mutex_name);
}
