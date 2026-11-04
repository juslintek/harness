const std = @import("std");
const lexer = @import("lexer.zig");
const launchers = @import("launchers.zig");

const gpa = std.testing.allocator;

const Run = struct {
    arena: std.heap.ArenaAllocator,
    l: launchers.Launched,

    fn deinit(self: *Run) void {
        self.arena.deinit();
    }
};

fn run(argv: []const []const u8) !Run {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    const l = try launchers.launched(&ctx, argv);
    return .{ .arena = arena, .l = l };
}

test "launchers: git rebase --exec value stops at a line terminator" {
    var r = try run(&.{ "git", "rebase", "--exec=make test\nrm -rf /", "-x", "ls" });
    defer r.deinit();
    try std.testing.expectEqual(@as(usize, 2), r.l.scripts.len);
    try std.testing.expectEqualStrings("make test", r.l.scripts[0]);
    try std.testing.expectEqualStrings("ls", r.l.scripts[1]);
}

test "launchers: git global options with values are skipped" {
    var r = try run(&.{ "git", "-C", "dir", "-c", "a=b", "bisect", "run", "make", "t" });
    defer r.deinit();
    try std.testing.expectEqual(@as(usize, 1), r.l.argvs.len);
    try std.testing.expectEqual(@as(usize, 2), r.l.argvs[0].len);
}

test "launchers: trap, watch, alias and fd" {
    var t = try run(&.{ "trap", "--", "rm x", "EXIT" });
    defer t.deinit();
    try std.testing.expectEqualStrings("rm x", t.l.scripts[0]);
    var w = try run(&.{ "watch", "-n", "2", "ls", "-l" });
    defer w.deinit();
    try std.testing.expectEqualStrings("ls -l", w.l.scripts[0]);
    var a = try run(&.{ "alias", "a=ls", "b", "c=x=y" });
    defer a.deinit();
    try std.testing.expectEqual(@as(usize, 2), a.l.scripts.len);
    try std.testing.expectEqualStrings("x=y", a.l.scripts[1]);
    var f = try run(&.{ "fd", ".", "-x", "rm", "{}" });
    defer f.deinit();
    try std.testing.expectEqual(@as(usize, 2), f.l.argvs[0].len);
}

test "launchers: other commands launch nothing" {
    var r = try run(&.{ "ls", "-x" });
    defer r.deinit();
    try std.testing.expectEqual(@as(usize, 0), r.l.scripts.len + r.l.argvs.len);
    var e = try run(&.{});
    defer e.deinit();
    try std.testing.expectEqual(@as(usize, 0), e.l.scripts.len + e.l.argvs.len);
}
