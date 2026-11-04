//! Definite-length CBOR reader for attestation objects, authenticator extensions and COSE keys.
//!
//! Reference: @levischuck/tiny-cbor as used by @simplewebauthn/server 14.0.3. Where this reader is
//! stricter on purpose: indefinite lengths, tags, simple values other than false/true/null/undefined,
//! truncated strings (tiny-cbor silently cuts a byte string short), nesting and size limits.
//! Integers beyond 2^53 are refused, as tiny-cbor does ("Length not supported").
const std = @import("std");

const Allocator = std.mem.Allocator;

pub const max_depth = 16;
/// Entries in one array or map. WebAuthn data has a handful; an x5c chain has three or four.
pub const max_items = 256;
/// Values in a whole document, so nested maximal containers cannot multiply.
pub const max_nodes = 4096;
const max_safe_int: u64 = (1 << 53) - 1;

pub const Error = error{
    Truncated,
    Malformed,
    Unsupported,
    TooDeep,
    TooLarge,
    DuplicateKey,
    TrailingData,
    OutOfMemory,
};

pub const Key = union(enum) {
    int: i64,
    text: []const u8,

    fn eql(a: Key, b: Key) bool {
        return switch (a) {
            .int => |x| b == .int and b.int == x,
            .text => |x| b == .text and std.mem.eql(u8, x, b.text),
        };
    }
};

pub const Entry = struct { key: Key, value: Value };

pub const Value = union(enum) {
    int: i64,
    bytes: []const u8,
    text: []const u8,
    array: []const Value,
    map: []const Entry,
    boolean: bool,
    null,
    undefined,
    float: f64,

    pub fn get(self: Value, key: i64) ?Value {
        return self.lookup(.{ .int = key });
    }

    pub fn getText(self: Value, key: []const u8) ?Value {
        return self.lookup(.{ .text = key });
    }

    fn lookup(self: Value, key: Key) ?Value {
        if (self != .map) return null;
        for (self.map) |entry| if (entry.key.eql(key)) return entry.value;
        return null;
    }
};

/// A decoded item whose containers live in `arena`. `len` is how many input bytes it used.
pub const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    value: Value,
    len: usize,

    pub fn deinit(self: *Parsed) void {
        self.arena.deinit();
    }
};

/// First item of `input`; bytes after it are the caller's business (authenticator data).
pub fn decodeFirst(gpa: Allocator, input: []const u8) Error!Parsed {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena.deinit();
    const first = try decodeFirstArena(arena.allocator(), input);
    return .{ .arena = arena, .value = first.value, .len = first.len };
}

/// The whole of `input` must be exactly one item.
pub fn decode(gpa: Allocator, input: []const u8) Error!Parsed {
    var parsed = try decodeFirst(gpa, input);
    errdefer parsed.deinit();
    if (parsed.len != input.len) return error.TrailingData;
    return parsed;
}

pub const First = struct { value: Value, len: usize };

/// The whole of `input` must be exactly one item; allocations come from `arena`.
pub fn decodeArena(arena: Allocator, input: []const u8) Error!Value {
    const first = try decodeFirstArena(arena, input);
    if (first.len != input.len) return error.TrailingData;
    return first.value;
}

/// Same as `decodeFirst` with every allocation made from `arena`; nothing is freed on failure, so
/// the arena must belong to the caller's request.
pub fn decodeFirstArena(arena: Allocator, input: []const u8) Error!First {
    if (input.len == 0) return error.Truncated;
    var decoder: Decoder = .{ .input = input, .arena = arena };
    const value = try decoder.value(0);
    return .{ .value = value, .len = decoder.pos };
}

const Head = struct { major: u3, info: u5, arg: u64 };

const Decoder = struct {
    input: []const u8,
    pos: usize = 0,
    nodes: usize = 0,
    arena: Allocator,

    fn remaining(self: *const Decoder) usize {
        return self.input.len - self.pos;
    }

    fn take(self: *Decoder, n: usize) Error![]const u8 {
        if (n > self.remaining()) return error.Truncated;
        const out = self.input[self.pos..][0..n];
        self.pos += n;
        return out;
    }

    fn head(self: *Decoder) Error!Head {
        const first = (try self.take(1))[0];
        const major: u3 = @intCast(first >> 5);
        const info: u5 = @intCast(first & 0x1f);
        const arg: u64 = switch (info) {
            0...23 => info,
            24 => (try self.take(1))[0],
            25 => std.mem.readInt(u16, (try self.take(2))[0..2], .big),
            26 => std.mem.readInt(u32, (try self.take(4))[0..4], .big),
            27 => std.mem.readInt(u64, (try self.take(8))[0..8], .big),
            // 28 to 30 are reserved and 31 is the indefinite-length marker or break.
            28...31 => return error.Unsupported,
        };
        return .{ .major = major, .info = info, .arg = arg };
    }

    fn count(self: *Decoder, arg: u64, per_item: usize) Error!usize {
        if (arg > max_items) return error.TooLarge;
        const n: usize = @intCast(arg);
        // Every item takes at least one byte, so a count the input cannot hold is a truncation and
        // never reaches the allocator.
        if (n * per_item > self.remaining()) return error.Truncated;
        return n;
    }

    fn value(self: *Decoder, depth: usize) Error!Value {
        if (depth > max_depth) return error.TooDeep;
        self.nodes += 1;
        if (self.nodes > max_nodes) return error.TooLarge;
        const h = try self.head();
        switch (h.major) {
            0 => {
                if (h.arg > max_safe_int) return error.Unsupported;
                return .{ .int = @intCast(h.arg) };
            },
            1 => {
                if (h.arg > max_safe_int) return error.Unsupported;
                const magnitude: i64 = @intCast(h.arg);
                return .{ .int = -1 - magnitude };
            },
            2 => return .{ .bytes = try self.string(h.arg) },
            3 => return .{ .text = try self.string(h.arg) },
            4 => {
                const n = try self.count(h.arg, 1);
                const items = try self.arena.alloc(Value, n);
                for (items) |*item| item.* = try self.value(depth + 1);
                return .{ .array = items };
            },
            5 => {
                const n = try self.count(h.arg, 2);
                const entries = try self.arena.alloc(Entry, n);
                for (entries, 0..) |*entry, i| {
                    entry.key = try self.key(depth + 1);
                    for (entries[0..i]) |earlier| if (earlier.key.eql(entry.key)) return error.DuplicateKey;
                    entry.value = try self.value(depth + 1);
                }
                return .{ .map = entries };
            },
            6 => return error.Unsupported,
            7 => return switch (h.info) {
                20 => .{ .boolean = false },
                21 => .{ .boolean = true },
                22 => .null,
                23 => .undefined,
                25 => .{ .float = @as(f16, @bitCast(@as(u16, @intCast(h.arg)))) },
                26 => .{ .float = @as(f32, @bitCast(@as(u32, @intCast(h.arg)))) },
                27 => .{ .float = @bitCast(h.arg) },
                else => error.Unsupported,
            },
        }
    }

    fn string(self: *Decoder, len: u64) Error![]const u8 {
        if (len > self.remaining()) return error.Truncated;
        return self.take(@intCast(len));
    }

    // tiny-cbor only allows string and number keys, so a map keyed by anything else is malformed.
    fn key(self: *Decoder, depth: usize) Error!Key {
        const peek = self.input[self.pos..];
        if (peek.len == 0) return error.Truncated;
        return switch (peek[0] >> 5) {
            0, 1, 3 => switch (try self.value(depth)) {
                .int => |n| .{ .int = n },
                .text => |s| .{ .text = s },
                else => unreachable,
            },
            else => error.Malformed,
        };
    }
};

/// Minimal-length encoding of ints, strings, arrays, maps and simple values, which is what
/// tiny-cbor writes. @simplewebauthn re-encodes the COSE key it stores, so the blob in the
/// database is this form and not necessarily the bytes the authenticator sent.
pub fn encode(gpa: Allocator, v: Value) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try encodeInto(gpa, &out, v);
    return out.toOwnedSlice(gpa);
}

fn encodeHead(gpa: Allocator, out: *std.ArrayList(u8), major: u8, arg: u64) Error!void {
    const m = major << 5;
    if (arg < 24) {
        try out.append(gpa, m | @as(u8, @intCast(arg)));
    } else if (arg <= 0xff) {
        try out.appendSlice(gpa, &.{ m | 24, @intCast(arg) });
    } else if (arg <= 0xffff) {
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, @intCast(arg), .big);
        try out.append(gpa, m | 25);
        try out.appendSlice(gpa, &b);
    } else if (arg <= 0xffff_ffff) {
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @intCast(arg), .big);
        try out.append(gpa, m | 26);
        try out.appendSlice(gpa, &b);
    } else {
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, arg, .big);
        try out.append(gpa, m | 27);
        try out.appendSlice(gpa, &b);
    }
}

fn encodeInto(gpa: Allocator, out: *std.ArrayList(u8), v: Value) Error!void {
    switch (v) {
        .int => |n| if (n >= 0) {
            try encodeHead(gpa, out, 0, @intCast(n));
        } else {
            try encodeHead(gpa, out, 1, @intCast(-1 - n));
        },
        .bytes => |b| {
            try encodeHead(gpa, out, 2, b.len);
            try out.appendSlice(gpa, b);
        },
        .text => |s| {
            try encodeHead(gpa, out, 3, s.len);
            try out.appendSlice(gpa, s);
        },
        .array => |items| {
            try encodeHead(gpa, out, 4, items.len);
            for (items) |item| try encodeInto(gpa, out, item);
        },
        .map => |entries| {
            try encodeHead(gpa, out, 5, entries.len);
            for (entries) |entry| {
                switch (entry.key) {
                    .int => |n| try encodeInto(gpa, out, .{ .int = n }),
                    .text => |s| try encodeInto(gpa, out, .{ .text = s }),
                }
                try encodeInto(gpa, out, entry.value);
            }
        },
        .boolean => |b| try out.append(gpa, if (b) 0xf5 else 0xf4),
        .null => try out.append(gpa, 0xf6),
        .undefined => try out.append(gpa, 0xf7),
        .float => return error.Unsupported,
    }
}

test "cbor: scalar items decode" {
    const gpa = std.testing.allocator;
    const cases = [_]struct { bytes: []const u8, want: Value }{
        .{ .bytes = &.{0x00}, .want = .{ .int = 0 } },
        .{ .bytes = &.{0x17}, .want = .{ .int = 23 } },
        .{ .bytes = &.{ 0x18, 0x18 }, .want = .{ .int = 24 } },
        .{ .bytes = &.{ 0x19, 0x01, 0x00 }, .want = .{ .int = 256 } },
        .{ .bytes = &.{0x20}, .want = .{ .int = -1 } },
        .{ .bytes = &.{ 0x38, 0xff }, .want = .{ .int = -256 } },
        .{ .bytes = &.{ 0x39, 0x01, 0x00 }, .want = .{ .int = -257 } },
        .{ .bytes = &.{ 0x1a, 0xff, 0xff, 0xff, 0xff }, .want = .{ .int = 4294967295 } },
        .{ .bytes = &.{ 0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }, .want = .{ .int = 9007199254740991 } },
        .{ .bytes = &.{0xf4}, .want = .{ .boolean = false } },
        .{ .bytes = &.{0xf5}, .want = .{ .boolean = true } },
        .{ .bytes = &.{0xf6}, .want = .null },
        .{ .bytes = &.{0xf7}, .want = .undefined },
    };
    for (cases) |case| {
        var parsed = try decode(gpa, case.bytes);
        defer parsed.deinit();
        try std.testing.expectEqualDeep(case.want, parsed.value);
    }
}

test "cbor: strings, arrays and maps decode and look up" {
    const gpa = std.testing.allocator;
    // {1: 2, 3: -7, -1: 1, -2: h'0102', "a": [true, "x"]}
    const bytes = [_]u8{ 0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x42, 0x01, 0x02, 0x61, 'a', 0x82, 0xf5, 0x61, 'x' };
    var parsed = try decode(gpa, &bytes);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, 2), parsed.value.get(1).?.int);
    try std.testing.expectEqual(@as(i64, -7), parsed.value.get(3).?.int);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2 }, parsed.value.get(-2).?.bytes);
    const arr = parsed.value.getText("a").?.array;
    try std.testing.expectEqual(@as(usize, 2), arr.len);
    try std.testing.expectEqualStrings("x", arr[1].text);
    try std.testing.expect(parsed.value.get(99) == null);
}

test "cbor: decodeFirst reports the bytes it used" {
    const gpa = std.testing.allocator;
    var parsed = try decodeFirst(gpa, &.{ 0x82, 0x01, 0x02, 0xff, 0xff });
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 3), parsed.len);
}

test "cbor: hostile and malformed input is an error and never a panic" {
    const gpa = std.testing.allocator;
    const E = Error;
    const cases = [_]struct { bytes: []const u8, err: E }{
        .{ .bytes = &.{}, .err = error.Truncated },
        .{ .bytes = &.{0x18}, .err = error.Truncated },
        .{ .bytes = &.{ 0x19, 0x01 }, .err = error.Truncated },
        .{ .bytes = &.{ 0x1b, 0, 0, 0, 0, 0, 0, 0 }, .err = error.Truncated },
        // text string of length 5 with one byte behind it
        .{ .bytes = &.{ 0x65, 'a' }, .err = error.Truncated },
        // byte string whose declared length is 2^32 - 1
        .{ .bytes = &.{ 0x5a, 0xff, 0xff, 0xff, 0xff, 0x00 }, .err = error.Truncated },
        // byte string whose declared length is 2^64 - 1
        .{ .bytes = &.{ 0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }, .err = error.Truncated },
        // array of 2^32 - 1 items
        .{ .bytes = &.{ 0x9a, 0xff, 0xff, 0xff, 0xff }, .err = error.TooLarge },
        // map of 2^64 - 1 pairs
        .{ .bytes = &.{ 0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }, .err = error.TooLarge },
        // array of 3 with room for one
        .{ .bytes = &.{ 0x83, 0x01 }, .err = error.Truncated },
        // indefinite-length byte string, array and map
        .{ .bytes = &.{ 0x5f, 0x41, 0x00, 0xff }, .err = error.Unsupported },
        .{ .bytes = &.{ 0x9f, 0x01, 0xff }, .err = error.Unsupported },
        .{ .bytes = &.{ 0xbf, 0x01, 0x02, 0xff }, .err = error.Unsupported },
        // reserved additional information
        .{ .bytes = &.{0x1c}, .err = error.Unsupported },
        // a tag around an int
        .{ .bytes = &.{ 0xc1, 0x01 }, .err = error.Unsupported },
        // simple value 16 and the two-byte simple form
        .{ .bytes = &.{0xf0}, .err = error.Unsupported },
        .{ .bytes = &.{ 0xf8, 0x20 }, .err = error.Unsupported },
        // integers beyond 2^53
        .{ .bytes = &.{ 0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }, .err = error.Unsupported },
        .{ .bytes = &.{ 0x3b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }, .err = error.Unsupported },
        // map keys that are not ints or text, and duplicates
        .{ .bytes = &.{ 0xa1, 0x41, 0x00, 0x01 }, .err = error.Malformed },
        .{ .bytes = &.{ 0xa1, 0x80, 0x01 }, .err = error.Malformed },
        .{ .bytes = &.{ 0xa2, 0x01, 0x01, 0x01, 0x02 }, .err = error.DuplicateKey },
        .{ .bytes = &.{ 0xa2, 0x61, 'a', 0x01, 0x61, 'a', 0x02 }, .err = error.DuplicateKey },
        // map with a key and no value
        .{ .bytes = &.{ 0xa1, 0x01 }, .err = error.Truncated },
        // trailing bytes after a whole item
        .{ .bytes = &.{ 0x01, 0x00 }, .err = error.TrailingData },
    };
    for (cases) |case| try std.testing.expectError(case.err, decode(gpa, case.bytes));
}

test "cbor: nesting depth is limited" {
    const gpa = std.testing.allocator;
    var deep: [max_depth + 3]u8 = undefined;
    @memset(&deep, 0x81);
    deep[deep.len - 1] = 0x00;
    try std.testing.expectError(error.TooDeep, decode(gpa, &deep));
    var ok: [max_depth + 1]u8 = undefined;
    @memset(&ok, 0x81);
    ok[ok.len - 1] = 0x00;
    var parsed = try decode(gpa, &ok);
    parsed.deinit();
}

test "cbor: the whole document is limited to max_nodes values" {
    const gpa = std.testing.allocator;
    // 20 arrays of 255 items each: every container is within max_items, the document is not
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(gpa);
    try buf.appendSlice(gpa, &.{ 0x98, 20 });
    for (0..20) |_| {
        try buf.appendSlice(gpa, &.{ 0x98, 255 });
        try buf.appendNTimes(gpa, 0x00, 255);
    }
    try std.testing.expectError(error.TooLarge, decode(gpa, buf.items));
}

test "cbor: encode round trips and is minimal" {
    const gpa = std.testing.allocator;
    // The same map as above, written with 2-byte lengths where one byte would do.
    const loose = [_]u8{ 0xa2, 0x18, 0x01, 0x19, 0x00, 0x02, 0x03, 0x18, 0x26 };
    var parsed = try decode(gpa, &loose);
    defer parsed.deinit();
    const tight = try encode(gpa, parsed.value);
    defer gpa.free(tight);
    try std.testing.expectEqualSlices(u8, &.{ 0xa2, 0x01, 0x02, 0x03, 0x18, 0x26 }, tight);
}

test "cbor: allocation failure at every point is an error without a leak" {
    const bytes = [_]u8{ 0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x42, 0x01, 0x02, 0x61, 'a', 0x82, 0xf5, 0x61, 'x' };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(gpa: Allocator, input: []const u8) !void {
            var parsed = try decode(gpa, input);
            defer parsed.deinit();
            const again = try encode(gpa, parsed.value);
            gpa.free(again);
        }
    }.run, .{@as([]const u8, &bytes)});
}
