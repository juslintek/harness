//! COSE_Key parsing and WebAuthn signature verification for the four algorithms the server
//! advertises: ML-DSA-44 (-48), EdDSA (-8), ES256 (-7) and RS256 (-257).
//!
//! Reference: @simplewebauthn/server 14.0.3 `helpers/iso/isoCrypto/verify*.js`. It dispatches on
//! `kty` and takes the hash from `alg`; this module dispatches on `alg` and also requires the
//! matching `kty` and curve, so a key labelled ES256 over P-384 is refused here and not verified.
const std = @import("std");
const cbor = @import("cbor.zig");

const Certificate = std.crypto.Certificate;
const Sha256 = std.crypto.hash.sha2.Sha256;
const EcdsaP256 = std.crypto.sign.ecdsa.EcdsaP256Sha256;
const Ed25519 = std.crypto.sign.Ed25519;
const MlDsa44 = std.crypto.sign.mldsa.MLDSA44;

pub const Alg = enum(i32) {
    mldsa44 = -48,
    eddsa = -8,
    es256 = -7,
    rs256 = -257,
};

/// Order of `pubKeyCredParams` in the options the TS server sends, when its runtime has ML-DSA.
pub const default_algs = [_]i32{ -48, -8, -7, -257 };

const label_kty = 1;
const label_alg = 3;
const label_crv = -1;
const label_x = -2;
const label_y = -3;
const label_n = -1;
const label_e = -2;
const label_pub = -1;

const kty_okp = 1;
const kty_ec2 = 2;
const kty_rsa = 3;
const kty_akp = 7;
const crv_p256 = 1;
const crv_ed25519 = 6;

const rsa_modulus_lengths = [_]usize{ 256, 384, 512 };

pub const Error = error{
    /// The map has no integer `alg` (label 3).
    MissingAlg,
    UnsupportedAlgorithm,
    InvalidKey,
};

pub const Key = union(Alg) {
    mldsa44: []const u8,
    eddsa: [32]u8,
    es256: struct { x: [32]u8, y: [32]u8 },
    rs256: struct { n: []const u8, e: []const u8 },
};

/// The numeric `alg` of a COSE key map, the first thing @simplewebauthn reads from one.
pub fn algOf(map: cbor.Value) error{MissingAlg}!i64 {
    const alg = map.get(label_alg) orelse return error.MissingAlg;
    if (alg != .int) return error.MissingAlg;
    return alg.int;
}

pub fn algFromInt(n: i64) ?Alg {
    return std.enums.fromInt(Alg, n);
}

fn intAt(map: cbor.Value, label: i64) ?i64 {
    const v = map.get(label) orelse return null;
    return if (v == .int) v.int else null;
}

fn bytesAt(map: cbor.Value, label: i64) ?[]const u8 {
    const v = map.get(label) orelse return null;
    return if (v == .bytes) v.bytes else null;
}

fn fixedAt(comptime n: usize, map: cbor.Value, label: i64) ?[n]u8 {
    const b = bytesAt(map, label) orelse return null;
    if (b.len != n) return null;
    return b[0..n].*;
}

/// Reads the key out of a COSE map. The result borrows from `map`. This checks shape and lengths;
/// `check` also proves the key material is usable.
pub fn parseKey(map: cbor.Value) Error!Key {
    if (map != .map) return error.InvalidKey;
    const alg = algFromInt(try algOf(map)) orelse return error.UnsupportedAlgorithm;
    const kty = intAt(map, label_kty) orelse return error.InvalidKey;
    switch (alg) {
        .es256 => {
            if (kty != kty_ec2 or intAt(map, label_crv) != crv_p256) return error.InvalidKey;
            return .{ .es256 = .{
                .x = fixedAt(32, map, label_x) orelse return error.InvalidKey,
                .y = fixedAt(32, map, label_y) orelse return error.InvalidKey,
            } };
        },
        .eddsa => {
            if (kty != kty_okp or intAt(map, label_crv) != crv_ed25519) return error.InvalidKey;
            return .{ .eddsa = fixedAt(32, map, label_x) orelse return error.InvalidKey };
        },
        .rs256 => {
            if (kty != kty_rsa) return error.InvalidKey;
            const n = bytesAt(map, label_n) orelse return error.InvalidKey;
            const e = bytesAt(map, label_e) orelse return error.InvalidKey;
            for (rsa_modulus_lengths) |len| if (n.len == len) return .{ .rs256 = .{ .n = n, .e = e } };
            return error.InvalidKey;
        },
        .mldsa44 => {
            if (kty != kty_akp) return error.InvalidKey;
            const pub_key = bytesAt(map, label_pub) orelse return error.InvalidKey;
            if (pub_key.len != MlDsa44.PublicKey.encoded_length) return error.InvalidKey;
            return .{ .mldsa44 = pub_key };
        },
    }
}

/// Proves the key material is a valid public key for its algorithm (point on the curve, canonical
/// Ed25519 encoding, sane RSA modulus and exponent, decodable ML-DSA key).
pub fn check(key: Key) error{InvalidKey}!void {
    switch (key) {
        .es256 => |k| {
            var sec1: [65]u8 = undefined;
            sec1[0] = 0x04;
            @memcpy(sec1[1..33], &k.x);
            @memcpy(sec1[33..65], &k.y);
            _ = EcdsaP256.PublicKey.fromSec1(&sec1) catch return error.InvalidKey;
        },
        .eddsa => |k| _ = Ed25519.PublicKey.fromBytes(k) catch return error.InvalidKey,
        .rs256 => |k| _ = Certificate.rsa.PublicKey.fromBytes(k.e, k.n) catch return error.InvalidKey,
        .mldsa44 => |k| _ = MlDsa44.PublicKey.fromBytes(k[0..MlDsa44.PublicKey.encoded_length].*) catch return error.InvalidKey,
    }
}

/// `sig` is the raw WebAuthn assertion signature: DER for ES256, 64 bytes for EdDSA, the PKCS#1
/// block for RS256 and the FIPS 204 encoding for ML-DSA-44 with an empty context, which is what
/// WebCrypto `verify` uses. Any failure, including an undecodable signature, is `SignatureInvalid`.
pub fn verify(key: Key, msg: []const u8, sig: []const u8) error{SignatureInvalid}!void {
    switch (key) {
        .es256 => |k| {
            var sec1: [65]u8 = undefined;
            sec1[0] = 0x04;
            @memcpy(sec1[1..33], &k.x);
            @memcpy(sec1[33..65], &k.y);
            const public_key = EcdsaP256.PublicKey.fromSec1(&sec1) catch return error.SignatureInvalid;
            const parsed = EcdsaP256.Signature.fromDer(sig) catch return error.SignatureInvalid;
            parsed.verify(msg, public_key) catch return error.SignatureInvalid;
        },
        .eddsa => |k| {
            if (sig.len != Ed25519.Signature.encoded_length) return error.SignatureInvalid;
            const public_key = Ed25519.PublicKey.fromBytes(k) catch return error.SignatureInvalid;
            const parsed = Ed25519.Signature.fromBytes(sig[0..Ed25519.Signature.encoded_length].*);
            parsed.verify(msg, public_key) catch return error.SignatureInvalid;
        },
        .rs256 => |k| {
            const public_key = Certificate.rsa.PublicKey.fromBytes(k.e, k.n) catch return error.SignatureInvalid;
            inline for (rsa_modulus_lengths) |len| {
                if (k.n.len == len) {
                    if (sig.len != len) return error.SignatureInvalid;
                    Certificate.rsa.PKCS1v1_5Signature.verify(len, sig[0..len], msg, public_key, Sha256) catch return error.SignatureInvalid;
                    return;
                }
            }
            return error.SignatureInvalid;
        },
        .mldsa44 => |k| {
            if (sig.len != MlDsa44.Signature.encoded_length) return error.SignatureInvalid;
            const public_key = MlDsa44.PublicKey.fromBytes(k[0..MlDsa44.PublicKey.encoded_length].*) catch return error.SignatureInvalid;
            const parsed = MlDsa44.Signature.fromBytes(sig[0..MlDsa44.Signature.encoded_length].*) catch return error.SignatureInvalid;
            parsed.verify(msg, public_key) catch return error.SignatureInvalid;
        },
    }
}

/// Builds the COSE map the TS server stores for a key. Test helper: production code receives keys.
pub fn testMap(arena: std.mem.Allocator, entries: []const cbor.Entry) !cbor.Value {
    return .{ .map = try arena.dupe(cbor.Entry, entries) };
}

fn es256Entries(x: []const u8, y: []const u8) [5]cbor.Entry {
    return .{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 2 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -7 } },
        .{ .key = .{ .int = -1 }, .value = .{ .int = 1 } },
        .{ .key = .{ .int = -2 }, .value = .{ .bytes = x } },
        .{ .key = .{ .int = -3 }, .value = .{ .bytes = y } },
    };
}

test "cose: ES256 sign with std, verify through the COSE path" {
    const kp = try EcdsaP256.KeyPair.generateDeterministic(@splat(7));
    const sec1 = kp.public_key.toUncompressedSec1();
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const entries = es256Entries(sec1[1..33], sec1[33..65]);
    const key = try parseKey(try testMap(arena.allocator(), &entries));
    try check(key);

    const sig = try kp.sign("message", null);
    var der_buf: [EcdsaP256.Signature.der_encoded_length_max]u8 = undefined;
    const der = sig.toDer(&der_buf);
    try verify(key, "message", der);
    try std.testing.expectError(error.SignatureInvalid, verify(key, "messagf", der));
    var flipped: [EcdsaP256.Signature.der_encoded_length_max]u8 = undefined;
    @memcpy(flipped[0..der.len], der);
    flipped[der.len - 1] ^= 1;
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", flipped[0..der.len]));
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", der[0 .. der.len - 1]));
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", ""));
    // raw r||s is not what WebAuthn sends
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", &sig.toBytes()));
}

test "cose: EdDSA sign with std, verify through the COSE path" {
    const kp = try Ed25519.KeyPair.generateDeterministic(@splat(9));
    const pub_bytes = kp.public_key.toBytes();
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const key = try parseKey(try testMap(arena.allocator(), &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 1 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -8 } },
        .{ .key = .{ .int = -1 }, .value = .{ .int = 6 } },
        .{ .key = .{ .int = -2 }, .value = .{ .bytes = &pub_bytes } },
    }));
    try check(key);
    const sig = (try kp.sign("message", null)).toBytes();
    try verify(key, "message", &sig);
    try std.testing.expectError(error.SignatureInvalid, verify(key, "other", &sig));
    var bad = sig;
    bad[10] ^= 0x40;
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", &bad));
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", sig[0..63]));
}

test "cose: ML-DSA-44 sign with std, verify through the COSE path" {
    const kp = try MlDsa44.KeyPair.generateDeterministic(@splat(3));
    const pub_bytes = kp.public_key.toBytes();
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const key = try parseKey(try testMap(arena.allocator(), &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 7 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -48 } },
        .{ .key = .{ .int = -1 }, .value = .{ .bytes = &pub_bytes } },
    }));
    try check(key);
    const sig = (try kp.sign("message", null)).toBytes();
    try verify(key, "message", &sig);
    try std.testing.expectError(error.SignatureInvalid, verify(key, "messagf", &sig));
    var bad = sig;
    bad[100] ^= 1;
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", &bad));
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", sig[0 .. sig.len - 1]));
    try std.testing.expectError(error.SignatureInvalid, verify(key, "message", ""));
}

test "cose: unknown algorithms and malformed keys are rejected" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const x: [32]u8 = @splat(1);
    // ES384, PS256 and RS1 are real COSE algorithms this server does not accept
    for ([_]i64{ -35, -37, -65535, 0, 1000 }) |alg| {
        var entries = es256Entries(&x, &x);
        entries[1].value = .{ .int = alg };
        try std.testing.expectError(error.UnsupportedAlgorithm, parseKey(try testMap(a, &entries)));
    }
    // alg missing, alg not an int, key not a map
    try std.testing.expectError(error.MissingAlg, parseKey(try testMap(a, &.{.{ .key = .{ .int = 1 }, .value = .{ .int = 2 } }})));
    var entries = es256Entries(&x, &x);
    entries[1].value = .{ .text = "ES256" };
    try std.testing.expectError(error.MissingAlg, parseKey(try testMap(a, &entries)));
    try std.testing.expectError(error.InvalidKey, parseKey(.{ .bytes = &x }));
    // kty or curve that does not belong to the algorithm
    entries = es256Entries(&x, &x);
    entries[0].value = .{ .int = 1 };
    try std.testing.expectError(error.InvalidKey, parseKey(try testMap(a, &entries)));
    entries = es256Entries(&x, &x);
    entries[2].value = .{ .int = 2 };
    try std.testing.expectError(error.InvalidKey, parseKey(try testMap(a, &entries)));
    // coordinate of the wrong length
    entries = es256Entries(x[0..31], &x);
    try std.testing.expectError(error.InvalidKey, parseKey(try testMap(a, &entries)));
    // well-formed but not on the curve
    entries = es256Entries(&x, &x);
    try std.testing.expectError(error.InvalidKey, check(try parseKey(try testMap(a, &entries))));
    // RSA with a 1000-bit and a 2048-bit modulus whose exponent is even
    const short_n: [125]u8 = @splat(0xff);
    try std.testing.expectError(error.InvalidKey, parseKey(try testMap(a, &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 3 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -257 } },
        .{ .key = .{ .int = -1 }, .value = .{ .bytes = &short_n } },
        .{ .key = .{ .int = -2 }, .value = .{ .bytes = &.{ 1, 0, 1 } } },
    })));
    const n: [256]u8 = @splat(0xff);
    const even = try parseKey(try testMap(a, &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 3 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -257 } },
        .{ .key = .{ .int = -1 }, .value = .{ .bytes = &n } },
        .{ .key = .{ .int = -2 }, .value = .{ .bytes = &.{2} } },
    }));
    try std.testing.expectError(error.InvalidKey, check(even));
    // ML-DSA key of the wrong length
    try std.testing.expectError(error.InvalidKey, parseKey(try testMap(a, &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 7 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -48 } },
        .{ .key = .{ .int = -1 }, .value = .{ .bytes = &x } },
    })));
}

test "cose: allocation failure while parsing a stored key never leaks" {
    const sec1 = (try EcdsaP256.KeyPair.generateDeterministic(@splat(1))).public_key.toUncompressedSec1();
    const entries = es256Entries(sec1[1..33], sec1[33..65]);
    const encoded = try cbor.encode(std.testing.allocator, .{ .map = &entries });
    defer std.testing.allocator.free(encoded);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(gpa: std.mem.Allocator, bytes: []const u8) !void {
            var parsed = try cbor.decode(gpa, bytes);
            defer parsed.deinit();
            const key = try parseKey(parsed.value);
            try check(key);
        }
    }.run, .{@as([]const u8, encoded)});
}
