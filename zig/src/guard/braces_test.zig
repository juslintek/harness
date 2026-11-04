const std = @import("std");
const braces = @import("braces.zig");

const gpa = std.testing.allocator;

fn expandJoined(word: []const u8) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var out: std.ArrayList([]const u8) = .empty;
    defer out.deinit(gpa);
    try braces.expandBraces(arena.allocator(), gpa, word, &out);
    return std.mem.join(gpa, " ", out.items);
}

fn expectExpands(word: []const u8, expected: []const u8) !void {
    const got = try expandJoined(word);
    defer gpa.free(got);
    try std.testing.expectEqualStrings(expected, got);
}

test "braces: lists expand left to right and nest" {
    try expectExpands("x{a,b}y", "xay xby");
    try expectExpands("{a,b}{c,d}", "ac ad bc bd");
    try expectExpands("{a,{b,c}}", "a b c");
    try expectExpands("{a,}", "a ");
}

test "braces: sequences, single items and unbalanced groups stay as they are" {
    try expectExpands("{1..3}", "{1..3}");
    try expectExpands("{a}", "{a}");
    try expectExpands("{a,b", "{a,b");
    try expectExpands("a}", "a}");
    try expectExpands("{{a,b}", "{{a,b}");
}

test "braces: quoted, escaped and substituted words are left alone" {
    try expectExpands("$x{a,b}", "$x{a,b}");
    try expectExpands("{a,b}\\x", "{a,b}\\x");
    try expectExpands("{a,'b'}", "{a,'b'}");
    try expectExpands("{a,b}\u{a0}", "{a,b}\u{a0}");
    try expectExpands("{a,b}\u{feff}", "{a,b}\u{feff}");
}

test "braces: more than 64 alternatives keep the original word" {
    try expectExpands("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}");
    const got = try expandJoined("{1,2,3,4,5,6,7,8}{1,2,3,4,5}");
    defer gpa.free(got);
    try std.testing.expectEqual(@as(usize, 39), std.mem.count(u8, got, " "));
}

test "braces: a long run of nested groups without commas is linear" {
    const n = 50_000;
    const word = try gpa.alloc(u8, 2 * n);
    defer gpa.free(word);
    @memset(word[0..n], '{');
    @memset(word[n..], '}');
    const got = try expandJoined(word);
    defer gpa.free(got);
    try std.testing.expectEqual(word.len, got.len);
}

fn expandOnce(a: std.mem.Allocator, word: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var out: std.ArrayList([]const u8) = .empty;
    defer out.deinit(a);
    try braces.expandBraces(arena.allocator(), a, word, &out);
}

test "braces: allocation failures leave nothing behind" {
    try std.testing.checkAllAllocationFailures(gpa, expandOnce, .{@as([]const u8, "{a,{b,c}}{d,e}x")});
}
