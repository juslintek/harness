//! Identifiers and timestamps. Ids are UUIDv7 like Bun.randomUUIDv7() in TS; times are epoch ms.
const std = @import("std");

pub const uuid_len = 36;

pub fn nowMs(io: std.Io) i64 {
    return std.Io.Clock.real.now(io).toMilliseconds();
}

/// Packs the last ms timestamp and a 12-bit counter, so ids stay strictly increasing across threads
/// and a clock that stalls or steps back, like Bun.randomUUIDv7().
var last: std.atomic.Value(u64) = .init(0);

pub fn uuidV7(io: std.Io) [uuid_len]u8 {
    const now: u64 = @intCast(@max(0, nowMs(io)));
    var prev = last.load(.monotonic);
    var next: u64 = undefined;
    while (true) {
        // A counter overflow carries into the millisecond, which keeps the order intact.
        next = if (now << 12 > prev) now << 12 else prev + 1;
        prev = last.cmpxchgWeak(prev, next, .monotonic, .monotonic) orelse break;
    }
    var random: [10]u8 = undefined;
    io.random(&random);
    random[0] = @intCast((next >> 8) & 0x0f);
    random[1] = @truncate(next);
    return formatUuidV7(@intCast(next >> 12), random);
}

/// Layout per RFC 9562: 48-bit ms timestamp, version 7, 12 bits taken from random[0..2] (the counter
/// in uuidV7), variant 10, 62 random bits.
pub fn formatUuidV7(ms: u48, random: [10]u8) [uuid_len]u8 {
    var bytes: [16]u8 = undefined;
    std.mem.writeInt(u48, bytes[0..6], ms, .big);
    @memcpy(bytes[6..], &random);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var out: [uuid_len]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out);
    w.print("{x}-{x}-{x}-{x}-{x}", .{
        bytes[0..4],
        bytes[4..6],
        bytes[6..8],
        bytes[8..10],
        bytes[10..16],
    }) catch unreachable;
    return out;
}

test "ids: formatUuidV7 sets version, variant and timestamp" {
    const id = formatUuidV7(0x0123456789ab, .{ 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff });
    try std.testing.expectEqualStrings("01234567-89ab-7fff-bfff-ffffffffffff", &id);
}

test "ids: uuidV7 ids sort by creation time" {
    const io = std.testing.io;
    const a = uuidV7(io);
    try io.sleep(.fromMilliseconds(2), .real);
    const b = uuidV7(io);
    try std.testing.expect(std.mem.order(u8, &a, &b) == .lt);
    try std.testing.expectEqual(@as(u8, '7'), a[14]);
}

test "ids: nowMs is a plausible epoch time" {
    try std.testing.expect(nowMs(std.testing.io) > 1_700_000_000_000);
}

test "ids: uuidV7 is strictly increasing within one millisecond" {
    const io = std.testing.io;
    var prev = uuidV7(io);
    for (0..5000) |_| {
        const next = uuidV7(io);
        try std.testing.expect(std.mem.order(u8, &prev, &next) == .lt);
        prev = next;
    }
}
