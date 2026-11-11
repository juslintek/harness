//! JSON helpers. Duplicate keys resolve to the last value, as JSON.parse does in TS, and unknown
//! fields are ignored, as zod's default object parsing does.
const std = @import("std");

pub const parse_options: std.json.ParseOptions = .{
    .duplicate_field_behavior = .use_last,
    .ignore_unknown_fields = true,
};

/// A string field the way zod reads one: a JSON string and nothing else. A plain `[]const u8` in a
/// struct handed to `std.json` also takes an array of integers (read as bytes), so request bodies
/// use this type; `headers.parseBody` refuses a raw `[]const u8` at compile time.
pub const Str = struct {
    text: []const u8,

    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) std.json.ParseError(@TypeOf(source.*))!Str {
        return switch (try source.nextAllocMax(allocator, options.allocate.?, options.max_value_len.?)) {
            inline .string, .allocated_string => |text| .{ .text = text },
            else => error.UnexpectedToken,
        };
    }
};

/// `z.enum([...])`: the name of a tag as a JSON string. `std.json` reads an enum from a JSON number
/// too (as its index), where zod answers 400.
pub fn Enum(comptime E: type) type {
    return struct {
        tag: E,

        pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) std.json.ParseError(@TypeOf(source.*))!@This() {
            const name = try Str.jsonParse(allocator, source, options);
            return .{ .tag = std.meta.stringToEnum(E, name.text) orelse return error.InvalidEnumTag };
        }
    };
}

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

const Probe = struct { word: Str, kind: ?Enum(enum { a, b }) = null, flag: bool = false };

test "json: Str and Enum read only JSON strings" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ok = try std.json.parseFromSliceLeaky(Probe, a, "{\"word\":\"hi\\u00e9\",\"kind\":\"b\",\"flag\":true}", parse_options);
    try std.testing.expectEqualStrings("hi\u{e9}", ok.word.text);
    try std.testing.expectEqual(.b, ok.kind.?.tag);
    const refused = [_][]const u8{
        "{\"word\":[104,105]}",
        "{\"word\":7}",
        "{\"word\":1.5}",
        "{\"word\":true}",
        "{\"word\":null}",
        "{\"word\":{}}",
        "{\"word\":\"x\",\"kind\":1}",
        "{\"word\":\"x\",\"kind\":\"1\"}",
        "{\"word\":\"x\",\"kind\":\"c\"}",
        "{\"word\":\"x\",\"kind\":[\"a\"]}",
        "{\"word\":\"\xff\"}",
    };
    for (refused) |body| try std.testing.expect(std.meta.isError(std.json.parseFromSliceLeaky(Probe, a, body, parse_options)));
}
