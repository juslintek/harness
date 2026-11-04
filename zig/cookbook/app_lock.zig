//! TS: a handler's synchronous section is atomic because the server is single-threaded. Here every
//! piece of mutable state sits behind App.withLock (src/app.zig); the state pointer exists only
//! inside the callback. Do not call slow I/O (spawn, git, network) from inside it.
const std = @import("std");
const app_mod = @import("../src/app.zig");

const App = app_mod.App;
const State = app_mod.State;

const Counter = struct {
    amount: u32,

    fn bump(counter: Counter, state: *State) u32 {
        // `state` is the only way to the guarded fields; here we only prove the lock is held.
        std.debug.assert(state.db == null);
        return counter.amount + 1;
    }
};

test "app_lock: a callback returns a value computed under the lock" {
    var app = App.init(std.testing.allocator, std.testing.io);
    const next = app.withLock(Counter{ .amount = 41 }, Counter.bump);
    try std.testing.expectEqual(@as(u32, 42), next);
}

test "app_lock: the lock is free again after the callback returns" {
    var app = App.init(std.testing.allocator, std.testing.io);
    _ = app.withLock(Counter{ .amount = 0 }, Counter.bump);
    try std.testing.expect(app.mutex.tryLock());
    app.mutex.unlock(app.io);
}

test "app_lock: ctx can carry an out pointer for results that need a slice" {
    const Collect = struct {
        fn run(out: *[8]u8, _: *State) void {
            @memcpy(out[0..2], "ok");
        }
    };
    var app = App.init(std.testing.allocator, std.testing.io);
    var out: [8]u8 = @splat(0);
    app.withLock(&out, Collect.run);
    try std.testing.expectEqualStrings("ok", out[0..2]);
}
