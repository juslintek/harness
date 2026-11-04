//! TS: crypto.randomBytes(n) and crypto.getRandomValues. Secrets (session tokens, run tokens,
//! challenges) must use io.randomSecure; io.random is a seeded PRNG for non-secret ids and jitter.
const std = @import("std");

pub const token_bytes = 32;

/// 64 lowercase hex characters from the OS entropy source. Fails instead of falling back.
pub fn newToken(io: std.Io) ![token_bytes * 2]u8 {
    var raw: [token_bytes]u8 = undefined;
    try io.randomSecure(&raw);
    return std.fmt.bytesToHex(raw, .lower);
}

test "random_secure: tokens have the right shape and differ" {
    const io = std.testing.io;
    const a = try newToken(io);
    const b = try newToken(io);
    try std.testing.expectEqual(@as(usize, 64), a.len);
    try std.testing.expect(!std.mem.eql(u8, &a, &b));
    for (a) |ch| try std.testing.expect(std.ascii.isHex(ch));
}
