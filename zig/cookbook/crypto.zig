//! TS: crypto.createHash("sha256").update(x).digest("hex") and timingSafeEqual.
const std = @import("std");

const Sha256 = std.crypto.hash.sha2.Sha256;

pub fn sha256Hex(bytes: []const u8) [64]u8 {
    var digest: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

/// Compares two hex digests without an early exit. Arrays of one fixed length only: a length
/// mismatch is a type error here, not a runtime branch that leaks the length.
pub fn digestsEqual(a: [64]u8, b: [64]u8) bool {
    return std.crypto.timing_safe.eql([64]u8, a, b);
}

test "crypto: sha256 hex matches the known vector" {
    const hex = sha256Hex("abc");
    try std.testing.expectEqualStrings("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", &hex);
}

test "crypto: constant-time compare" {
    const a = sha256Hex("token");
    try std.testing.expect(digestsEqual(a, sha256Hex("token")));
    try std.testing.expect(!digestsEqual(a, sha256Hex("tokem")));
}

test "crypto: incremental hashing equals one-shot" {
    var hasher = Sha256.init(.{});
    hasher.update("a");
    hasher.update("bc");
    const hex = std.fmt.bytesToHex(hasher.finalResult(), .lower);
    try std.testing.expectEqualStrings(&sha256Hex("abc"), &hex);
}
