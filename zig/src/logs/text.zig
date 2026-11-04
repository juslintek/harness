//! The JavaScript string behaviour search needs and std does not have: UTF-16 indexing (snippets
//! are cut by code unit), case folding, `[\p{L}\p{N}]+` words and JSON.stringify escaping.
//! Case folding and the letter test are approximations, listed under Z8 in the plan's known gaps.
const std = @import("std");

const Allocator = std.mem.Allocator;

const replacement: u21 = 0xfffd;

/// Decodes one code point; an invalid byte is U+FFFD, as TextDecoder does for the first byte.
fn decodeAt(utf8: []const u8, at: usize) struct { cp: u21, len: usize } {
    const len = std.unicode.utf8ByteSequenceLength(utf8[at]) catch return .{ .cp = replacement, .len = 1 };
    if (at + len > utf8.len) return .{ .cp = replacement, .len = 1 };
    const cp = std.unicode.utf8Decode(utf8[at .. at + len]) catch return .{ .cp = replacement, .len = 1 };
    return .{ .cp = cp, .len = len };
}

/// String.prototype.toLowerCase for one code point: ASCII, Latin-1, Latin Extended-A, Greek and
/// Cyrillic. The rest is left as is (U+0130 and final sigma special cases included).
pub fn lowerCp(cp: u21) u21 {
    return switch (cp) {
        'A'...'Z', 0xc0...0xd6, 0xd8...0xde => cp + 32,
        0x100...0x12f, 0x132...0x137, 0x14a...0x177 => if (cp % 2 == 0) cp + 1 else cp,
        0x139...0x148, 0x179...0x17e => if (cp % 2 == 1) cp + 1 else cp,
        0x178 => 0xff,
        0x391...0x3a1, 0x3a3...0x3ab => cp + 32,
        0x410...0x42f => cp + 32,
        0x400...0x40f => cp + 80,
        else => cp,
    };
}

/// The code points of `utf8`, lower-cased.
pub fn lowerCodepoints(gpa: Allocator, utf8: []const u8) Allocator.Error![]u21 {
    var out: std.ArrayList(u21) = .empty;
    errdefer out.deinit(gpa);
    var at: usize = 0;
    while (at < utf8.len) {
        const d = decodeAt(utf8, at);
        try out.append(gpa, lowerCp(d.cp));
        at += d.len;
    }
    return out.toOwnedSlice(gpa);
}

pub fn appendUtf8(out: *std.ArrayList(u8), gpa: Allocator, cp: u21) Allocator.Error!void {
    var buf: [4]u8 = undefined;
    const n = std.unicode.utf8Encode(cp, &buf) catch unreachable;
    try out.appendSlice(gpa, buf[0..n]);
}

fn appendUnits(out: *std.ArrayList(u16), gpa: Allocator, cp: u21) Allocator.Error!void {
    if (cp < 0x10000) return out.append(gpa, @intCast(cp));
    const v = cp - 0x10000;
    try out.append(gpa, @intCast(0xd800 + (v >> 10)));
    try out.append(gpa, @intCast(0xdc00 + (v & 0x3ff)));
}

fn utf16Of(gpa: Allocator, utf8: []const u8, fold: bool) Allocator.Error![]u16 {
    var out: std.ArrayList(u16) = .empty;
    errdefer out.deinit(gpa);
    var at: usize = 0;
    while (at < utf8.len) {
        const d = decodeAt(utf8, at);
        try appendUnits(&out, gpa, if (fold) lowerCp(d.cp) else d.cp);
        at += d.len;
    }
    return out.toOwnedSlice(gpa);
}

pub fn toUtf16(gpa: Allocator, utf8: []const u8) Allocator.Error![]u16 {
    return utf16Of(gpa, utf8, false);
}

pub fn toUtf16Lower(gpa: Allocator, utf8: []const u8) Allocator.Error![]u16 {
    return utf16Of(gpa, utf8, true);
}

/// `[...text].length` for a UTF-16 string: a surrogate pair counts once.
pub fn codepointCount(units: []const u16) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < units.len) : (i += 1) {
        n += 1;
        if (units[i] >= 0xd800 and units[i] < 0xdc00 and i + 1 < units.len and units[i + 1] >= 0xdc00 and units[i + 1] < 0xe000) i += 1;
    }
    return n;
}

/// Stands in for `\p{L}` and `\p{N}`: ASCII exactly, above that every code point except the
/// punctuation, symbol, mark and private-use blocks listed here.
pub fn isWordCp(cp: u21) bool {
    if (cp < 0x80) return std.ascii.isAlphanumeric(@intCast(cp));
    return switch (cp) {
        0x80...0xa9, 0xab...0xb1, 0xb4, 0xb6...0xb8, 0xbb, 0xbf, 0xd7, 0xf7 => false,
        0x300...0x36f, 0x2000...0x206f, 0x20a0...0x20cf, 0x2190...0x245f, 0x2500...0x2bff => false,
        0x2e00...0x2e7f, 0x3000...0x3004, 0x3008...0x3020, 0x3030, 0x303d...0x303f => false,
        0xe000...0xf8ff, 0xfe00...0xfe0f, 0xfe30...0xfe6f, 0xff00...0xff0f, 0xff1a...0xff20 => false,
        0xff3b...0xff40, 0xff5b...0xff65, 0xfff0...0xffff, 0x1f000...0x1faff => false,
        else => true,
    };
}

pub const Words = struct {
    utf8: []const u8,
    at: usize = 0,

    /// The next maximal run of word code points, as a slice of the input.
    pub fn next(w: *Words) ?[]const u8 {
        var start: ?usize = null;
        while (w.at < w.utf8.len) {
            const d = decodeAt(w.utf8, w.at);
            if (isWordCp(d.cp) and d.cp != replacement) {
                if (start == null) start = w.at;
                w.at += d.len;
            } else {
                if (start) |s| return w.utf8[s..w.at];
                w.at += d.len;
            }
        }
        const s = start orelse return null;
        return w.utf8[s..w.at];
    }
};

pub fn wordIterator(utf8: []const u8) Words {
    return .{ .utf8 = utf8 };
}

/// JSON.stringify of a JS string: lone surrogates become \udXXX, other non-ASCII stays raw.
pub fn writeJsonString(w: *std.Io.Writer, units: []const u16) std.Io.Writer.Error!void {
    try w.writeByte('"');
    var i: usize = 0;
    while (i < units.len) : (i += 1) {
        const u = units[i];
        switch (u) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            0x08 => try w.writeAll("\\b"),
            0x0c => try w.writeAll("\\f"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0...0x07, 0x0b, 0x0e...0x1f, 0xd800...0xdfff => {
                const high = u >= 0xd800 and u < 0xdc00;
                if (high and i + 1 < units.len and units[i + 1] >= 0xdc00 and units[i + 1] < 0xe000) {
                    const cp: u21 = 0x10000 + ((@as(u21, u) - 0xd800) << 10) + (units[i + 1] - 0xdc00);
                    var buf: [4]u8 = undefined;
                    const n = std.unicode.utf8Encode(cp, &buf) catch unreachable;
                    try w.writeAll(buf[0..n]);
                    i += 1;
                } else {
                    try w.print("\\u{x:0>4}", .{u});
                }
            },
            else => {
                var buf: [4]u8 = undefined;
                const n = std.unicode.utf8Encode(@intCast(u), &buf) catch unreachable;
                try w.writeAll(buf[0..n]);
            },
        }
    }
    try w.writeByte('"');
}

test "logs/text: lone surrogates and control characters are escaped like JSON.stringify" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    const units = [_]u16{ 'a', '"', '\\', '\n', 0x1b, 0x7f, 0xd83d, 'x', 0xd83d, 0xde42, 0xdc00, 0xe9 };
    try writeJsonString(&out.writer, &units);
    try std.testing.expectEqualStrings("\"a\\\"\\\\\\n\\u001b\x7f\\ud83dx\u{1F642}\\udc00\u{e9}\"", out.written());
}

test "logs/text: utf16 conversion, folding and counting" {
    const gpa = std.testing.allocator;
    const units = try toUtf16Lower(gpa, "ŠIS 🙂 Įrašas");
    defer gpa.free(units);
    const expected = std.unicode.utf8ToUtf16LeStringLiteral("šis 🙂 įrašas");
    try std.testing.expectEqualSlices(u16, expected, units);
    try std.testing.expectEqual(@as(usize, 12), codepointCount(units));
    try std.testing.expectEqual(@as(usize, 13), units.len);
}

test "logs/text: words are runs of letters and digits" {
    var words = wordIterator("  foo-bar_baz 42, naïve… “quoted” 🙂 end");
    const want = [_][]const u8{ "foo", "bar", "baz", "42", "naïve", "quoted", "end" };
    for (want) |w| try std.testing.expectEqualStrings(w, words.next().?);
    try std.testing.expect(words.next() == null);
}
