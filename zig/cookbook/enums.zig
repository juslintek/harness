//! TS: string unions and numeric enums. 0.17 renamed @intFromEnum and @enumFromInt.
const std = @import("std");

pub const Priority = enum(u8) {
    low = 1,
    normal = 2,
    high = 3,

    pub fn fromInt(n: u8) ?Priority {
        return std.enums.fromInt(Priority, n);
    }
};

pub const Status = enum { todo, doing, done };

test "enums: @backingInt and @fromBackingInt replace the old builtins" {
    const high: Priority = .high;
    try std.testing.expectEqual(@as(u8, 3), @backingInt(high));
    const back: Priority = @fromBackingInt(2);
    try std.testing.expectEqual(Priority.normal, back);
}

test "enums: an untrusted integer goes through std.enums.fromInt, which returns null" {
    try std.testing.expectEqual(@as(?Priority, .low), Priority.fromInt(1));
    try std.testing.expectEqual(@as(?Priority, null), Priority.fromInt(9));
}

test "enums: strings map to variants with std.meta.stringToEnum and back with @tagName" {
    try std.testing.expectEqual(@as(?Status, .doing), std.meta.stringToEnum(Status, "doing"));
    try std.testing.expectEqual(@as(?Status, null), std.meta.stringToEnum(Status, "Doing"));
    try std.testing.expectEqualStrings("done", @tagName(Status.done));
}

test "enums: std.json maps a string to an enum and rejects unknown names" {
    const Row = struct { status: Status };
    const ok = try std.json.parseFromSlice(Row, std.testing.allocator, "{\"status\":\"todo\"}", .{});
    defer ok.deinit();
    try std.testing.expectEqual(Status.todo, ok.value.status);
    try std.testing.expectError(error.InvalidEnumTag, std.json.parseFromSlice(Row, std.testing.allocator, "{\"status\":\"x\"}", .{}));
}
