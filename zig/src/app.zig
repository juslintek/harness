//! The single state lock. httpz runs handlers on a thread pool, so everything the TS server
//! mutates on one thread lives in `State`, reachable only inside `App.withLock`. Never hold it
//! across slow I/O (spawn, git, network).
const std = @import("std");
const c = @import("db/c.zig");

pub const State = struct {
    db: ?*c.Db = null,
};

pub const App = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    /// Zig has no private fields: only `withLock` in this file may touch it.
    guarded: State = .{},

    pub fn init(gpa: std.mem.Allocator, io: std.Io) App {
        return .{ .gpa = gpa, .io = io };
    }

    /// Runs `f(ctx, state)` with the lock held. The state pointer exists only inside `f`, so it
    /// cannot outlive the lock or be reached without it. Do not do slow I/O inside `f`.
    pub fn withLock(app: *App, ctx: anytype, comptime f: anytype) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
        comptime if (leaksState(@typeInfo(@TypeOf(f)).@"fn".return_type.?))
            @compileError("a withLock callback must not return the state pointer");
        app.mutex.lockUncancelable(app.io);
        defer app.mutex.unlock(app.io);
        return f(ctx, &app.guarded);
    }
};

/// True when `T` is, or wraps in an optional or error union, a pointer to `State`.
fn leaksState(comptime T: type) bool {
    return switch (@typeInfo(T)) {
        .pointer => |p| p.child == State,
        .optional => |o| leaksState(o.child),
        .error_union => |e| leaksState(e.payload),
        else => false,
    };
}

test "app: returning the state pointer is detected" {
    try std.testing.expect(leaksState(*State));
    try std.testing.expect(leaksState(?*const State));
    try std.testing.expect(leaksState(anyerror!*State));
    try std.testing.expect(!leaksState(bool));
    try std.testing.expect(!leaksState(?*c.Db));
}

test "app: lock serialises writers" {
    const Worker = struct {
        fn bump(counter: *u32, _: *State) void {
            const before = counter.*;
            std.atomic.spinLoopHint();
            counter.* = before + 1;
        }
        fn run(app: *App, counter: *u32) void {
            for (0..1000) |_| app.withLock(counter, bump);
        }
    };
    var app = App.init(std.testing.allocator, std.testing.io);
    var counter: u32 = 0;
    var threads: [4]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Worker.run, .{ &app, &counter });
    for (threads) |thread| thread.join();
    try std.testing.expectEqual(@as(u32, 4000), counter);
}

test "app: state is reachable only inside withLock and the lock is released after" {
    const Probe = struct {
        fn dbIsNull(_: void, state: *State) bool {
            return state.db == null;
        }
    };
    var app = App.init(std.testing.allocator, std.testing.io);
    try std.testing.expect(app.withLock({}, Probe.dbIsNull));
    try std.testing.expect(app.mutex.tryLock());
    app.mutex.unlock(app.io);
}
