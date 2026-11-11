//! JS-semantics helpers. TS enforces limits and coerces input with JavaScript string rules, and
//! the Zig port has to accept and refuse exactly the same inputs. See working-docs/zig-plan.md 2.6.
const std = @import("std");

/// The length zod 4.6 enforces for string `.min(n)` and `.max(n)`: Unicode code points, so one
/// emoji counts 1 (zod `checks.js`, `util.codePointLength`). Invalid UTF-8 is an error: JSON.parse
/// could never have produced it. Use this for every schema limit, never `utf16Len`.
pub fn codePoints(utf8: []const u8) error{InvalidUtf8}!usize {
    return std.unicode.utf8CountCodepoints(utf8) catch error.InvalidUtf8;
}

/// `s.length` in JS: UTF-16 code units. Only plain `.length` checks in TS code count these (such
/// as the guard's `src.length`), a zod limit does not. Invalid UTF-8 is an error.
pub fn utf16Len(utf8: []const u8) error{InvalidUtf8}!usize {
    // calcUtf16LeLen indexes past the end on a truncated sequence, so validate first.
    if (!std.unicode.utf8ValidateSlice(utf8)) return error.InvalidUtf8;
    return std.unicode.calcUtf16LeLen(utf8) catch error.InvalidUtf8;
}

/// WhiteSpace and LineTerminator of ECMA-262, the set `String.prototype.trim` strips. U+180E is not
/// in it, and U+200B is not either.
fn isJsSpace(cp: u21) bool {
    return switch (cp) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        0x2000...0x200a => true,
        else => false,
    };
}

/// `s.trim()`. `std.mem.trim` with an ASCII set would leave U+00A0, U+3000 and U+FEFF in place.
/// The result is a slice of the input. Bytes that are not valid UTF-8 stop the trim at that point.
pub fn jsTrim(utf8: []const u8) []const u8 {
    var start: usize = 0;
    while (start < utf8.len) {
        // Utf8Iterator.nextCodepoint asserts on a bad lead byte, so decode by hand.
        const len = std.unicode.utf8ByteSequenceLength(utf8[start]) catch break;
        if (start + len > utf8.len) break;
        const cp = std.unicode.utf8Decode(utf8[start..][0..len]) catch break;
        if (!isJsSpace(cp)) break;
        start += len;
    }
    var end = utf8.len;
    while (end > start) {
        var begin = end - 1;
        while (begin > start and utf8[begin] & 0xc0 == 0x80) begin -= 1;
        const cp = std.unicode.utf8Decode(utf8[begin..end]) catch break;
        if (!isJsSpace(cp)) break;
        end = begin;
    }
    return utf8[start..end];
}

const kelvin_sign: u21 = 0x212a;
const dotted_capital_i: u21 = 0x0130;
const combining_dot_above = "\u{0307}";

/// `s.toLowerCase()` as far as an email address needs it. TS runs `trim().toLowerCase()` and then a
/// zod email regex that only accepts ASCII, so the only question is which non-ASCII code points
/// lowercase into ASCII. Exactly one does: U+212A KELVIN SIGN becomes `k`. U+0130 becomes `i` plus
/// U+0307, which stays non-ASCII and fails the regex like in TS. contract/js-lowercase-to-ascii.json
/// does not exist yet, so this list is hand-written; every other non-ASCII code point is copied
/// unchanged, which differs from JS only in values the email regex refuses either way.
/// Caller owns the result.
pub fn jsLowerEmail(gpa: std.mem.Allocator, utf8: []const u8) error{ InvalidUtf8, OutOfMemory }![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.ensureTotalCapacity(gpa, utf8.len);
    var it = (std.unicode.Utf8View.init(utf8) catch return error.InvalidUtf8).iterator();
    while (it.nextCodepointSlice()) |slice| {
        const cp = std.unicode.utf8Decode(slice) catch return error.InvalidUtf8;
        switch (cp) {
            'A'...'Z' => try out.append(gpa, @as(u8, @intCast(cp)) + ('a' - 'A')),
            kelvin_sign => try out.append(gpa, 'k'),
            dotted_capital_i => try out.appendSlice(gpa, "i" ++ combining_dot_above),
            else => try out.appendSlice(gpa, slice),
        }
    }
    return out.toOwnedSlice(gpa);
}

fn isDigit(ch: u8) bool {
    return ch >= '0' and ch <= '9';
}

/// Length of `[0-9]+` at the start of `s`.
fn digitRun(s: []const u8) usize {
    var n: usize = 0;
    while (n < s.len and isDigit(s[n])) n += 1;
    return n;
}

/// True when `s` is a StrDecimalLiteral without sign: `1`, `1.`, `.5`, `1.5e-3`. Zig's own float
/// parser would also take `inf`, `nan`, `0x1p3` and `1_0`, which JS refuses.
fn isUnsignedDecimal(s: []const u8) bool {
    var i: usize = 0;
    const int_digits = digitRun(s);
    i += int_digits;
    var frac_digits: usize = 0;
    if (i < s.len and s[i] == '.') {
        i += 1;
        frac_digits = digitRun(s[i..]);
        i += frac_digits;
    }
    if (int_digits == 0 and frac_digits == 0) return false;
    if (i < s.len and (s[i] == 'e' or s[i] == 'E')) {
        i += 1;
        if (i < s.len and (s[i] == '+' or s[i] == '-')) i += 1;
        const exp_digits = digitRun(s[i..]);
        if (exp_digits == 0) return false;
        i += exp_digits;
    }
    return i == s.len;
}

/// Digits of a `0x`, `0o` or `0b` literal. JS has no sign on these.
fn parseRadix(digits: []const u8, base: u8) ?f64 {
    if (digits.len == 0) return null;
    // All three bases are powers of two, so each digit is a fixed number of exact bits. Keep the
    // first 64 significant bits, count the rest, and remember whether any of them was set: that
    // is enough to round the whole integer once, to nearest even, as ECMAScript requires.
    const bits_per_digit: u3 = switch (base) {
        2 => 1,
        8 => 3,
        16 => 4,
        else => unreachable,
    };
    var mantissa: u64 = 0;
    var kept: u32 = 0;
    var dropped: u64 = 0;
    var sticky = false;
    for (digits) |ch| {
        const d = std.fmt.charToDigit(ch, base) catch return null;
        var shift: u3 = bits_per_digit;
        while (shift > 0) {
            shift -= 1;
            const bit: u1 = @truncate(d >> shift);
            if (kept == 0 and bit == 0) continue;
            if (kept < 64) {
                mantissa = (mantissa << 1) | bit;
                kept += 1;
            } else {
                dropped += 1;
                sticky = sticky or bit == 1;
            }
        }
    }
    if (kept <= 53) return std.math.ldexp(@as(f64, @floatFromInt(mantissa)), clampExp(dropped));
    const extra: u6 = @intCast(kept - 53);
    var rounded = mantissa >> extra;
    const low = mantissa & ((@as(u64, 1) << extra) - 1);
    const half = @as(u64, 1) << (extra - 1);
    if (low > half or (low == half and (sticky or rounded & 1 == 1))) rounded += 1;
    return std.math.ldexp(@as(f64, @floatFromInt(rounded)), clampExp(dropped + extra));
}

fn clampExp(exp: u64) i32 {
    return @intCast(@min(exp, 4096));
}

/// `Number(s)` for a string: NaN when `s` is not a numeric literal. After `jsTrim`, empty is 0, and
/// the accepted forms are `Infinity`, signed decimals with an optional exponent, and unsigned `0x`,
/// `0o` and `0b` integers. `"0x10"` is 16, `"1e2"` is 100, `" 5 "` is 5, `"1_0"` and `"5px"` are NaN.
pub fn jsNumber(s: []const u8) f64 {
    const text = jsTrim(s);
    if (text.len == 0) return 0;
    if (text.len > 2 and text[0] == '0') {
        const base: u8 = switch (text[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            'b', 'B' => 2,
            else => 0,
        };
        if (base != 0) return parseRadix(text[2..], base) orelse std.math.nan(f64);
    }
    var body = text;
    var negative = false;
    if (body[0] == '+' or body[0] == '-') {
        negative = body[0] == '-';
        body = body[1..];
    }
    const magnitude: f64 = if (std.mem.eql(u8, body, "Infinity"))
        std.math.inf(f64)
    else if (isUnsignedDecimal(body))
        std.fmt.parseFloat(f64, body) catch return std.math.nan(f64)
    else
        return std.math.nan(f64);
    return if (negative) -magnitude else magnitude;
}

/// What `z.coerce.number()` hands to the next check: null where zod 4's `z.number()` refuses the
/// value, which is NaN and both infinities.
pub fn coerceNumber(s: []const u8) ?f64 {
    const value = jsNumber(s);
    return if (std.math.isFinite(value)) value else null;
}

const testing = std.testing;

test "parity: codePoints counts an emoji once and refuses invalid UTF-8" {
    try testing.expectEqual(@as(usize, 0), try codePoints(""));
    try testing.expectEqual(@as(usize, 5), try codePoints("hello"));
    try testing.expectEqual(@as(usize, 1), try codePoints("\u{0105}"));
    try testing.expectEqual(@as(usize, 1), try codePoints("\u{1F600}"));
    try testing.expectEqual(@as(usize, 4), try codePoints("a\u{1F600}b\u{0105}"));
    try testing.expectError(error.InvalidUtf8, codePoints("\xff"));
    try testing.expectError(error.InvalidUtf8, codePoints("a\xc3"));
    try testing.expectError(error.InvalidUtf8, codePoints("\xed\xa0\x80"));
}

test "parity: utf16Len counts code units, not bytes" {
    try testing.expectEqual(@as(usize, 0), try utf16Len(""));
    try testing.expectEqual(@as(usize, 5), try utf16Len("hello"));
    try testing.expectEqual(@as(usize, 1), try utf16Len("\u{0105}"));
    try testing.expectEqual(@as(usize, 1), try utf16Len("\u{ffff}"));
    try testing.expectEqual(@as(usize, 2), try utf16Len("\u{10000}"));
    try testing.expectEqual(@as(usize, 2), try utf16Len("\u{1F600}"));
    try testing.expectEqual(@as(usize, 6), try utf16Len("a\u{1F600}b\u{0105}a"));
    try testing.expectEqual(@as(usize, 4), "\u{0105}\u{0105}".len);
}

test "parity: utf16Len refuses invalid UTF-8" {
    try testing.expectError(error.InvalidUtf8, utf16Len("\xff"));
    try testing.expectError(error.InvalidUtf8, utf16Len("a\xc3"));
    try testing.expectError(error.InvalidUtf8, utf16Len("\xed\xa0\x80"));
}

test "parity: jsTrim strips the JS whitespace set and nothing else" {
    const cases = [_][2][]const u8{
        .{ "", "" },
        .{ "  a b  ", "a b" },
        .{ "\t\n\x0b\x0c\r x \r\n", "x" },
        .{ "\u{feff} \u{00a0}a b\u{3000}\n", "a b" },
        .{ "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}z", "z" },
        .{ "\u{1680}\u{2028}\u{2029}\u{202f}\u{205f}y", "y" },
        .{ " \u{2003}\t", "" },
        .{ "\u{0105}", "\u{0105}" },
        .{ "\u{200b}a\u{200b}", "\u{200b}a\u{200b}" },
        .{ "\u{180e}a", "\u{180e}a" },
        .{ "a\u{0085}", "a\u{0085}" },
    };
    for (cases) |case| try testing.expectEqualStrings(case[1], jsTrim(case[0]));
    try testing.expectEqualStrings("\u{00a0}x", std.mem.trim(u8, " \u{00a0}x ", " "));
}

test "parity: jsTrim keeps bytes it cannot decode" {
    try testing.expectEqualStrings("a\xff", jsTrim(" a\xff"));
    try testing.expectEqualStrings("\xffa", jsTrim("\xffa "));
}

fn lowerEmailOnce(gpa: std.mem.Allocator, input: []const u8) !void {
    const out = try jsLowerEmail(gpa, input);
    gpa.free(out);
}

test "parity: jsLowerEmail lowercases ASCII and maps the Kelvin sign into ASCII" {
    const cases = [_][2][]const u8{
        .{ "", "" },
        .{ "Alice@Example.COM", "alice@example.com" },
        .{ "already@lower.test", "already@lower.test" },
        .{ "\u{212a}ai@x.test", "kai@x.test" },
        .{ "a\u{212a}\u{212a}@x.test", "akk@x.test" },
        .{ "\u{0130}@x.test", "i\u{0307}@x.test" },
        .{ "\u{0105}@x.test", "\u{0105}@x.test" },
    };
    for (cases) |case| {
        const out = try jsLowerEmail(testing.allocator, case[0]);
        defer testing.allocator.free(out);
        try testing.expectEqualStrings(case[1], out);
    }
}

test "parity: jsLowerEmail refuses invalid UTF-8 and frees on every allocation failure" {
    try testing.expectError(error.InvalidUtf8, jsLowerEmail(testing.allocator, "a\xffb"));
    try testing.expectError(error.InvalidUtf8, jsLowerEmail(testing.allocator, "\xed\xa0\x80"));
    try testing.checkAllAllocationFailures(testing.allocator, lowerEmailOnce, .{"Mixed\u{212a}Case\u{0130}@x.test"});
}

fn expectNumber(expected: f64, input: []const u8) !void {
    const got = jsNumber(input);
    if (std.math.isNan(expected)) {
        try testing.expect(std.math.isNan(got));
    } else {
        try testing.expectEqual(expected, got);
    }
}

test "parity: jsNumber follows Number(string)" {
    const nan = std.math.nan(f64);
    const inf = std.math.inf(f64);
    try expectNumber(0, "");
    try expectNumber(0, "   ");
    try expectNumber(0, "\u{00a0}\n");
    try expectNumber(5, " 5 ");
    try expectNumber(5, "\u{feff}5\u{3000}");
    try expectNumber(16, "0x10");
    try expectNumber(16, "0X10");
    try expectNumber(8, "0o10");
    try expectNumber(5, "0b101");
    try expectNumber(100, "1e2");
    try expectNumber(100, "1E+2");
    try expectNumber(0.01, "1e-2");
    try expectNumber(0.5, ".5");
    try expectNumber(1, "1.");
    try expectNumber(-3.25, "-3.25");
    try expectNumber(3, "+3");
    try expectNumber(7, "007");
    try expectNumber(inf, "Infinity");
    try expectNumber(-inf, "-Infinity");
    try expectNumber(inf, "1e999");
    try expectNumber(255, "0xFf");
    try expectNumber(18446744073709551616.0, "0x10000000000000000");
    try expectNumber(nan, "0x");
    try expectNumber(nan, "-0x10");
    try expectNumber(nan, "0xg");
    try expectNumber(nan, "0b2");
    try expectNumber(nan, "0o8");
    try expectNumber(nan, "infinity");
    try expectNumber(nan, "inf");
    try expectNumber(nan, "NaN");
    try expectNumber(nan, "nan");
    try expectNumber(nan, "1_0");
    try expectNumber(nan, "5px");
    try expectNumber(nan, "1e");
    try expectNumber(nan, "1e+");
    try expectNumber(nan, ".");
    try expectNumber(nan, "+");
    try expectNumber(nan, "--1");
    try expectNumber(nan, "1 2");
    try expectNumber(nan, "0x1p3");
    try expectNumber(nan, "1n");
    try expectNumber(nan, "\u{200b}1");
}

// Expected patterns are the correctly rounded value of the exact integer (checked with Python's
// int-to-float, which rounds once to nearest even, as ECMAScript requires). Bun's JavaScriptCore
// differs on the first and the seventh case (it answers ...7c and ...fe), so a TS server on Bun
// parses those two literals one ulp lower than the spec and than this port.
test "parity: radix literals round once, to nearest even (bit patterns from exact integer rounding)" {
    const cases = [_]struct { []const u8, u64 }{
        .{ "0xc98c1360f0fbe408b84119f54c073f6b8", 0x482931826c1e1f7d },
        .{ "0x1fffffffffffff", 0x433fffffffffffff },
        .{ "0x20000000000001", 0x4340000000000000 },
        .{ "0x20000000000003", 0x4340000000000002 },
        .{ "0x3fffffffffffff80000000000000000", 0x4790000000000000 },
        .{ "0x3fffffffffffff80000000000000001", 0x4790000000000000 },
        .{ "0x1ffffffffffffe8000000000000000000000000000000000000001", 0x4d3fffffffffffff },
        .{ "0b111111111111111111111111111111111111111111111111111111", 0x4350000000000000 },
        .{ "0o7777777777777777777777777", 0x44a0000000000000 },
    };
    for (cases) |case| try testing.expectEqual(case[1], @as(u64, @bitCast(jsNumber(case[0]))));
}

test "parity: jsNumber keeps the sign of zero" {
    try testing.expect(std.math.signbit(jsNumber("-0")));
    try testing.expect(!std.math.signbit(jsNumber("0")));
}

test "parity: coerceNumber is null exactly where zod would see NaN" {
    try testing.expectEqual(@as(?f64, 0), coerceNumber(""));
    try testing.expectEqual(@as(?f64, 100), coerceNumber("1e2"));
    try testing.expectEqual(@as(?f64, null), coerceNumber("abc"));
    try testing.expectEqual(@as(?f64, null), coerceNumber("Infinity"));
    try testing.expectEqual(@as(?f64, null), coerceNumber("-Infinity"));
    try testing.expectEqual(@as(?f64, null), coerceNumber("1e999"));
}
