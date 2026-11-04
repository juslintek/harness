//! The single state lock. httpz runs handlers on a thread pool, so everything the TS server
//! mutates on one thread lives in `State`, reachable only through `Locked`, which only
//! `App.lock()` hands out. Never hold it across slow I/O (spawn, git, network).
const std = @import("std");
const c = @import("db/c.zig");

pub const State = struct {
    db: ?*c.Db = null,
};

pub const App = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    /// Do not touch outside this file; go through `Locked.state()`.
    guarded: State = .{},

    pub fn init(gpa: std.mem.Allocator, io: std.Io) App {
        return .{ .gpa = gpa, .io = io };
    }

    pub fn lock(app: *App) Locked {
        app.mutex.lockUncancelable(app.io);
        return .{ .app = app };
    }
};

pub const Locked = struct {
    app: *App,

    pub fn state(locked: Locked) *State {
        return &locked.app.guarded;
    }

    pub fn unlock(locked: Locked) void {
        locked.app.mutex.unlock(locked.app.io);
    }
};

test "app: lock serialises writers" {
    const Worker = struct {
        fn run(app: *App, counter: *u32) void {
            for (0..1000) |_| {
                const locked = app.lock();
                defer locked.unlock();
                const before = counter.*;
                std.atomic.spinLoopHint();
                counter.* = before + 1;
            }
        }
    };
    var app = App.init(std.testing.allocator, std.testing.io);
    var counter: u32 = 0;
    var threads: [4]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Worker.run, .{ &app, &counter });
    for (threads) |thread| thread.join();
    try std.testing.expectEqual(@as(u32, 4000), counter);
}

test "app: state is reachable only while locked" {
    var app = App.init(std.testing.allocator, std.testing.io);
    const locked = app.lock();
    try std.testing.expect(locked.state().db == null);
    locked.unlock();
    try std.testing.expect(app.mutex.tryLock());
    app.mutex.unlock(app.io);
}
