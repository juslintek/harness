const std = @import("std");
const lexer = @import("lexer.zig");
const wrappers = @import("wrappers.zig");

const gpa = std.testing.allocator;

const Peeled = struct {
    arena: std.heap.ArenaAllocator,
    un: ?wrappers.Unwrapped,

    fn deinit(self: *Peeled) void {
        self.arena.deinit();
    }
};

fn peel(argv: []const []const u8) !Peeled {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    const un = try wrappers.unwrap(&ctx, argv);
    return .{ .arena = arena, .un = un };
}

fn expectRest(argv: []const []const u8, name: []const u8, rest: []const []const u8) !void {
    var p = try peel(argv);
    defer p.deinit();
    const un = p.un orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings(name, un.name);
    try std.testing.expectEqual(rest.len, un.rest.len);
    for (rest, un.rest) |e, a| try std.testing.expectEqualStrings(e, a);
}

test "wrappers: sudo and env peel options and assignments" {
    try expectRest(&.{ "sudo", "-u", "root", "A=1", "rm", "-rf", "/" }, "sudo", &.{ "rm", "-rf", "/" });
    try expectRest(&.{ "sudo", "-uroot", "ls" }, "sudo", &.{"ls"});
    try expectRest(&.{ "env", "-i", "FOO=1", "--", "ls" }, "env", &.{"ls"});
    try expectRest(&.{ "env", "-S", "ls  -l", "x" }, "env", &.{ "ls", "-l", "x" });
}

test "wrappers: timeout and nice skip their own operands" {
    try expectRest(&.{ "timeout", "-s", "KILL", "5", "ls" }, "timeout", &.{"ls"});
    try expectRest(&.{ "nice", "-n", "5", "ls" }, "nice", &.{"ls"});
}

test "wrappers: xargs marks stdin as unresolvable" {
    try expectRest(&.{ "xargs", "rm" }, "xargs", &.{ "rm", "<stdin>" });
    try expectRest(&.{ "xargs", "-I{}", "cp", "{}", "x" }, "xargs", &.{ "cp", "<stdin>", "x" });
    try expectRest(&.{ "xargs", "-I", "%", "echo" }, "xargs", &.{ "echo", "<stdin>" });
}

test "wrappers: package runners, including a local bin run through pnpm" {
    try expectRest(&.{ "npx", "-c", "ls /" }, "npx", &.{ "sh", "-c", "ls /" });
    try expectRest(&.{ "pnpm", "rimraf", "x" }, "pnpm exec", &.{ "rimraf", "x" });
    try expectRest(&.{ "npm", "exec", "--", "ls" }, "npm exec", &.{"ls"});
    var p = try peel(&.{ "pnpm", "install" });
    defer p.deinit();
    try std.testing.expect(p.un == null);
}

test "wrappers: refusals" {
    var v = try peel(&.{ "command", "-v", "ls" });
    defer v.deinit();
    try std.testing.expect(v.un == null);
    var s = try peel(&.{ "script", "-c", "ls", "f" });
    defer s.deinit();
    try std.testing.expect(s.un == null);
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    try std.testing.expectError(error.ShellParse, wrappers.unwrap(&ctx, &.{ "env", "-C", "/x", "ls" }));
    try std.testing.expectEqualStrings("env changes the working directory", ctx.reason);
    try std.testing.expectError(error.ShellParse, wrappers.unwrap(&ctx, &.{ "sudo", "--chdir=/x", "ls" }));
    try std.testing.expectError(error.ShellParse, wrappers.unwrap(&ctx, &.{ "sudo", "-D/x", "ls" }));
}

test "wrappers: shell scripts" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    try std.testing.expectEqualStrings("a b", (try wrappers.shellScript(&ctx, "eval", &.{ "eval", "a", "b" })).?);
    try std.testing.expectEqualStrings("ls", (try wrappers.shellScript(&ctx, "bash", &.{ "bash", "-o", "pipefail", "-lc", "ls" })).?);
    try std.testing.expect((try wrappers.shellScript(&ctx, "bash", &.{ "bash", "x.sh", "-c", "ls" })) == null);
    try std.testing.expectEqualStrings("ls", (try wrappers.shellScript(&ctx, "su", &.{ "su", "root", "--command", "ls" })).?);
    try std.testing.expect(wrappers.runsScript("fish") and !wrappers.runsScript("python"));
    try std.testing.expectEqualStrings("rm", wrappers.base("/usr/bin/rm"));
    try std.testing.expectEqualStrings("", wrappers.base(null));
}
