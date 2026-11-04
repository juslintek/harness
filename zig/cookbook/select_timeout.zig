//! TS: Promise.race([work, timeout(ms)]). std.Io.Select runs tasks and hands back the first result;
//! `io.sleep` is the timer. Use `concurrent`, not `async`: `async` may run the function inline on
//! the calling thread, and a blocking task would then finish before the timer task even starts.
const std = @import("std");

pub const Outcome = enum { finished, timed_out };

const Event = union(enum) {
    work: std.Io.Cancelable!void,
    timer: std.Io.Cancelable!void,
};

fn work(io: std.Io, duration_ms: i64) std.Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(duration_ms), .awake);
}

/// Runs `work` for `work_ms` against a `limit_ms` timer. The loser is cancelled and joined before
/// this returns, so nothing outlives the call. Cancellation reaches `io.sleep` as error.Canceled.
pub fn race(io: std.Io, work_ms: i64, limit_ms: i64) !Outcome {
    var buffer: [2]Event = undefined;
    var select: std.Io.Select(Event) = .init(io, &buffer);
    defer select.cancelDiscard();
    try select.concurrent(.work, work, .{ io, work_ms });
    try select.concurrent(.timer, work, .{ io, limit_ms });
    return switch (try select.await()) {
        .work => .finished,
        .timer => .timed_out,
    };
}

test "select_timeout: fast work wins" {
    try std.testing.expectEqual(Outcome.finished, try race(std.testing.io, 5, 2000));
}

test "select_timeout: slow work loses to the timer and is cancelled" {
    const io = std.testing.io;
    const start = std.Io.Clock.awake.now(io);
    try std.testing.expectEqual(Outcome.timed_out, try race(io, 10_000, 30));
    const elapsed_ms = start.durationTo(std.Io.Clock.awake.now(io)).toMilliseconds();
    try std.testing.expect(elapsed_ms < 5000);
}
