//! TS: the garbage collector. A request or an agent turn gets one arena; everything it allocates is
//! freed in one call, so handlers skip per-value `free` and cannot leak on an early `return error`.
const std = @import("std");

const Summary = struct { words: usize, longest: []const u8 };

/// Allocations here go to `arena` and are never freed one by one. The result stays valid until the
/// caller deinitialises the arena, so copy anything that must outlive it with the long-lived allocator.
fn summarise(arena: std.mem.Allocator, text: []const u8) !Summary {
    var words: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeScalar(u8, text, ' ');
    while (it.next()) |word| try words.append(arena, try arena.dupe(u8, word));
    var longest: []const u8 = "";
    for (words.items) |word| if (word.len > longest.len) {
        longest = word;
    };
    return .{ .words = words.items.len, .longest = longest };
}

/// What a handler does: arena over the long-lived allocator, one deinit, the answer copied out.
pub fn handleRequest(gpa: std.mem.Allocator, text: []const u8) ![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const summary = try summarise(arena.allocator(), text);
    return std.fmt.allocPrint(gpa, "{d} words, longest {s}", .{ summary.words, summary.longest });
}

test "arena_request: no leak although summarise never frees" {
    const out = try handleRequest(std.testing.allocator, "one two three four");
    defer std.testing.allocator.free(out);
    try std.testing.expectEqualStrings("4 words, longest three", out);
}

test "arena_request: an early error does not leak either" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(gpa: std.mem.Allocator) !void {
            const out = try handleRequest(gpa, "a bb ccc");
            gpa.free(out);
        }
    }.run, .{});
}

test "arena_request: reset keeps the memory for the next request" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    _ = try arena.allocator().alloc(u8, 4096);
    try std.testing.expect(arena.reset(.retain_capacity));
    _ = try arena.allocator().alloc(u8, 4096);
}
