//! Identifiers and timestamps. Ids are UUIDv7 like Bun.randomUUIDv7() in TS; times are epoch ms.
const std = @import("std");

pub const uuid_len = 36;

pub fn nowMs(io: std.Io) i64 {
    return std.Io.Clock.real.now(io).toMilliseconds();
}

pub fn uuidV7(io: std.Io) [uuid_len]u8 {
    var random: [10]u8 = undefined;
    io.random(&random);
    return formatUuidV7(@intCast(@max(0, nowMs(io))), random);
}

/// Layout per RFC 9562: 48-bit ms timestamp, version 7, 12 random bits, variant 10, 62 random bits.
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
