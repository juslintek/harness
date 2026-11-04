//! JSON helpers. Duplicate keys resolve to the last value, as JSON.parse does in TS, and unknown
//! fields are ignored, as zod's default object parsing does.
const std = @import("std");

pub const parse_options: std.json.ParseOptions = .{
    .duplicate_field_behavior = .use_last,
    .ignore_unknown_fields = true,
};

pub fn parse(comptime T: type, gpa: std.mem.Allocator, bytes: []const u8) std.json.ParseError(std.json.Scanner)!std.json.Parsed(T) {
    return std.json.parseFromSlice(T, gpa, bytes, parse_options);
}

test "json: duplicate keys keep the last value" {
    const Body = struct { id: u32, name: []const u8 };
    const parsed = try parse(Body, std.testing.allocator, "{\"id\":1,\"name\":\"a\",\"id\":2,\"extra\":true}");
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u32, 2), parsed.value.id);
    try std.testing.expectEqualStrings("a", parsed.value.name);
}

test "json: malformed input is an error" {
    try std.testing.expectError(error.UnexpectedEndOfInput, parse(struct { id: u32 }, std.testing.allocator, "{\"id\":"));
}
