//! The Laya circuit breaker. TS: `failures`/`openUntil` in features/laya/client.ts. Three failures
//! in a row open the circuit for 30 s. There is no separate half-open flag: once the window has
//! passed the failure count is still at the threshold, so the next call is let through as a probe,
//! one more failure opens the circuit again and a success closes it. Like TS, every call that
//! arrives after the window is let through, not only the first one.
//!
//! Times are epoch ms passed in by the caller, so tests drive the clock by hand. The state is
//! behind its own small mutex because a Laya call runs outside `App.withLock`.
const std = @import("std");

pub const failures_to_open: u32 = 3;
pub const open_ms: i64 = 30_000;

pub const State = enum { closed, open, half_open };

pub const Breaker = struct {
    mutex: std.Io.Mutex = .init,
    failures: u32 = 0,
    open_until: i64 = 0,

    /// False while the circuit is open: the call must be skipped.
    pub fn allow(self: *Breaker, io: std.Io, now_ms: i64) bool {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        return now_ms >= self.open_until;
    }

    pub fn recordSuccess(self: *Breaker, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.failures = 0;
    }

    pub fn recordFailure(self: *Breaker, io: std.Io, now_ms: i64) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.failures +|= 1;
        if (self.failures >= failures_to_open) self.open_until = now_ms + open_ms;
    }

    pub fn reset(self: *Breaker, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.failures = 0;
        self.open_until = 0;
    }

    pub fn state(self: *Breaker, io: std.Io, now_ms: i64) State {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (now_ms < self.open_until) return .open;
        return if (self.failures >= failures_to_open) .half_open else .closed;
    }
};

const tio = std.testing.io;

test "laya: breaker opens on the third failure and stays open for 30 s" {
    var b: Breaker = .{};
    try std.testing.expectEqual(State.closed, b.state(tio, 1000));
    b.recordFailure(tio, 1000);
    b.recordFailure(tio, 1000);
    try std.testing.expect(b.allow(tio, 1000));
    try std.testing.expectEqual(State.closed, b.state(tio, 1000));
    b.recordFailure(tio, 1000);
    try std.testing.expectEqual(State.open, b.state(tio, 1000));
    try std.testing.expect(!b.allow(tio, 1000));
    try std.testing.expect(!b.allow(tio, 1000 + 29_999));
    try std.testing.expect(b.allow(tio, 1000 + 30_000));
    try std.testing.expectEqual(State.half_open, b.state(tio, 1000 + 30_000));
}

test "laya: a failed probe after the window opens the circuit again" {
    var b: Breaker = .{};
    for (0..3) |_| b.recordFailure(tio, 0);
    try std.testing.expectEqual(State.half_open, b.state(tio, 31_000));
    b.recordFailure(tio, 31_000);
    try std.testing.expectEqual(State.open, b.state(tio, 31_000));
    try std.testing.expect(!b.allow(tio, 31_000 + 29_000));
    try std.testing.expect(b.allow(tio, 31_000 + 30_000));
}

test "laya: a successful probe closes the circuit and a success resets the count" {
    var b: Breaker = .{};
    for (0..3) |_| b.recordFailure(tio, 0);
    b.recordSuccess(tio);
    try std.testing.expectEqual(State.closed, b.state(tio, 31_000));
    // After a reset the next two failures are not enough to open it.
    b.recordFailure(tio, 31_000);
    b.recordFailure(tio, 31_000);
    try std.testing.expectEqual(State.closed, b.state(tio, 31_000));
    b.recordSuccess(tio);
    b.recordFailure(tio, 31_000);
    b.recordFailure(tio, 31_000);
    try std.testing.expect(b.allow(tio, 31_000));
}

test "laya: reset clears an open circuit" {
    var b: Breaker = .{};
    for (0..3) |_| b.recordFailure(tio, 5);
    b.reset(tio);
    try std.testing.expectEqual(State.closed, b.state(tio, 5));
    try std.testing.expect(b.allow(tio, 5));
}
