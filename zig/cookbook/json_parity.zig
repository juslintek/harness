//! TS: JSON.parse then zod, `s.length`, `s.trim()`. Where Zig differs from JS and how to match.
//! Known divergence, not matched here: std.json rejects a lone surrogate escape (`"\uD800"`) because
//! the scanner forbids unpaired halves (std/json/Scanner.zig, header comment), while JSON.parse and
//! zod accept it. The last test pins the rejection; the ruling is a K0 item (see PORTING.md).
const std = @import("std");

const Body = struct {
    id: u32,
    title: []const u8,
    note: ?[]const u8 = null,
};

/// Same options as src/json.zig: JSON.parse keeps the last duplicate key, zod ignores extra keys.
const options: std.json.ParseOptions = .{
    .duplicate_field_behavior = .use_last,
    .ignore_unknown_fields = true,
};

pub fn parseBody(gpa: std.mem.Allocator, bytes: []const u8) !std.json.Parsed(Body) {
    return std.json.parseFromSlice(Body, gpa, bytes, options);
}

/// JS `string.length` counts UTF-16 code units; `[]const u8.len` counts bytes. Length limits that
/// the TS server enforces with zod `.max(n)` must use this. Invalid UTF-8 is an error here.
pub fn jsLength(utf8: []const u8) !usize {
    return std.unicode.calcUtf16LeLen(utf8);
}

/// The code points JS String.prototype.trim removes (WhiteSpace and LineTerminator in the spec).
fn isJsSpace(cp: u21) bool {
    return switch (cp) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        0x2000...0x200a => true,
        else => false,
    };
}

/// std.mem.trim with an ASCII set leaves U+00A0, U+3000, U+FEFF and friends in place; JS removes them.
pub fn jsTrim(utf8: []const u8) []const u8 {
    var start: usize = 0;
    var it = std.unicode.Utf8Iterator{ .bytes = utf8, .i = 0 };
    while (it.nextCodepoint()) |cp| {
        if (!isJsSpace(cp)) break;
        start = it.i;
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

test "json: duplicate keys keep the last value and unknown keys are ignored" {
    const parsed = try parseBody(std.testing.allocator, "{\"id\":1,\"title\":\"a\",\"id\":2,\"extra\":[1]}");
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u32, 2), parsed.value.id);
    try std.testing.expectEqual(@as(?[]const u8, null), parsed.value.note);
}

test "json: the default options reject duplicate keys" {
    const err = std.json.parseFromSlice(Body, std.testing.allocator, "{\"id\":1,\"id\":2,\"title\":\"\"}", .{});
    try std.testing.expectError(error.DuplicateField, err);
}

test "json: a number where a string is expected is a type error" {
    try std.testing.expectError(error.UnexpectedToken, parseBody(std.testing.allocator, "{\"id\":1,\"title\":5}"));
}

test "json: a lone surrogate escape is rejected, unlike JSON.parse (known divergence)" {
    try std.testing.expectError(error.SyntaxError, parseBody(std.testing.allocator, "{\"id\":1,\"title\":\"\\uD800\"}"));
    try std.testing.expectError(error.SyntaxError, parseBody(std.testing.allocator, "{\"id\":1,\"title\":\"\\uDC00\"}"));
    const pair = try parseBody(std.testing.allocator, "{\"id\":1,\"title\":\"\\uD83D\\uDE00\"}");
    defer pair.deinit();
    try std.testing.expectEqualStrings("\u{1F600}", pair.value.title);
}

test "json: length is UTF-16 code units like JS" {
    try std.testing.expectEqual(@as(usize, 5), try jsLength("hello"));
    try std.testing.expectEqual(@as(usize, 2), try jsLength("\u{1F600}"));
    try std.testing.expectEqual(@as(usize, 1), try jsLength("\u{0105}"));
    try std.testing.expectEqual(@as(usize, 4), "\u{0105}\u{0105}".len);
}

test "json: trim removes the JS whitespace set, not just ASCII" {
    try std.testing.expectEqualStrings("a b", jsTrim("\u{feff} \u{00a0}a b\u{3000}\n"));
    try std.testing.expectEqualStrings("", jsTrim(" \u{2003}\t"));
    try std.testing.expectEqualStrings("\u{0105}", jsTrim("\u{0105}"));
    try std.testing.expectEqualStrings("\u{00a0}x", std.mem.trim(u8, " \u{00a0}x ", " "));
}
