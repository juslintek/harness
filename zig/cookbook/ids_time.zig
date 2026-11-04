//! TS: Bun.randomUUIDv7() and Date.now(). Reuse src/ids.zig; do not write a second generator.
const std = @import("std");
const ids = @import("../src/ids.zig");

test "ids_time: uuidV7 is a 36 character string with version 7" {
    const id = ids.uuidV7(std.testing.io);
    try std.testing.expectEqual(@as(usize, ids.uuid_len), id.len);
    try std.testing.expectEqual(@as(u8, '7'), id[14]);
    try std.testing.expect(id[8] == '-' and id[13] == '-' and id[18] == '-' and id[23] == '-');
}

test "ids_time: ids created later sort later as plain strings" {
    const io = std.testing.io;
    const first = ids.uuidV7(io);
    const second = ids.uuidV7(io);
    try std.testing.expectEqual(std.math.Order.lt, std.mem.order(u8, &first, &second));
}

test "ids_time: epoch milliseconds come from the Io clock, as an i64 like Date.now()" {
    const before = ids.nowMs(std.testing.io);
    try std.testing.expect(before > 1_700_000_000_000);
    const direct = std.Io.Clock.real.now(std.testing.io).toMilliseconds();
    try std.testing.expect(direct >= before);
}

test "ids_time: a monotonic clock for durations is separate from wall time" {
    const io = std.testing.io;
    const start = std.Io.Clock.awake.now(io);
    try io.sleep(.fromMilliseconds(5), .awake);
    const elapsed_ns = start.durationTo(std.Io.Clock.awake.now(io)).toNanoseconds();
    try std.testing.expect(elapsed_ns >= 4 * std.time.ns_per_ms);
}
