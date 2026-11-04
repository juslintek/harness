//! Leaks fail the build: std.testing.allocator is a SafeAllocator that reports what a test leaked.
//! SafeAllocator replaces DebugAllocator and GeneralPurposeAllocator.
const std = @import("std");

const Owned = struct {
    name: []u8,

    fn create(gpa: std.mem.Allocator, name: []const u8) !Owned {
        return .{ .name = try gpa.dupe(u8, name) };
    }

    fn deinit(owned: Owned, gpa: std.mem.Allocator) void {
        gpa.free(owned.name);
    }
};

test "leak_checks: the testing allocator is a SafeAllocator" {
    try std.testing.expect(@TypeOf(std.testing.allocator_instance) == std.heap.SafeAllocator);
}

test "leak_checks: the pattern that passes" {
    const owned = try Owned.create(std.testing.allocator, "run-1");
    defer owned.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("run-1", owned.name);
}

test "leak_checks: a leak is counted by a private SafeAllocator, not hidden" {
    var safe: std.heap.SafeAllocator = .init(std.testing.allocator, .{});
    const gpa = safe.allocator();
    _ = try gpa.alloc(u8, 16);
    try std.testing.expectEqual(@as(usize, 1), safe.deinitLog(false));
}

test "leak_checks: every allocation failure path is exercised" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(gpa: std.mem.Allocator) !void {
            const a = try Owned.create(gpa, "first");
            errdefer a.deinit(gpa);
            const b = try Owned.create(gpa, "second");
            b.deinit(gpa);
            a.deinit(gpa);
        }
    }.run, .{});
}
