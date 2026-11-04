//! Exit codes of the built harness-hook binary, which is what Claude acts on. The build passes the
//! path of the installed artifact as `hook_exe`; the in-process hook tests cover the decisions.
const std = @import("std");
const options = @import("build_options");

const gpa = std.testing.allocator;
const io = std.testing.io;

const Ran = struct { code: u8, stdout: []u8, stderr: []u8 };

fn runHook(stdin_text: []const u8, with_env: bool, extra_args: []const []const u8) !Ran {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "in.json", .data = stdin_text });
    var dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const n = try tmp.dir.realPath(io, &dir_buf);
    const input = try std.fmt.allocPrint(gpa, "{s}/in.json", .{dir_buf[0..n]});
    defer gpa.free(input);
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    if (with_env) {
        try env.put("HARNESS_SCOPE_ROOT", "/work/tree");
        try env.put("HOME", "/home/u");
        try env.put("HARNESS_DEFAULT_BRANCH", "main");
    }
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(gpa);
    try argv.appendSlice(gpa, &.{ "/bin/sh", "-c", "exec \"$0\" \"$@\" < \"$HOOK_INPUT\"", options.hook_exe });
    try argv.appendSlice(gpa, extra_args);
    try env.put("HOOK_INPUT", input);
    const r = try std.process.run(gpa, io, .{ .argv = argv.items, .environ_map = &env });
    const code: u8 = switch (r.term) {
        .exited => |c| c,
        else => 255,
    };
    return .{ .code = code, .stdout = r.stdout, .stderr = r.stderr };
}

fn expectRun(stdin_text: []const u8, with_env: bool, args: []const []const u8, code: u8, out_has: []const u8) !void {
    const r = try runHook(stdin_text, with_env, args);
    defer gpa.free(r.stdout);
    defer gpa.free(r.stderr);
    try std.testing.expectEqual(code, r.code);
    try std.testing.expect(std.mem.find(u8, r.stdout, out_has) != null);
}

const sub: []const []const u8 = &.{"claude-pretooluse"};

test "hook binary: deny exits 2, allow exits 0 silently, ask exits 0 with the decision" {
    try expectRun("{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf ~\"},\"cwd\":\"/work/tree\"}", true, sub, 2, "");
    try expectRun("{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"},\"cwd\":\"/work/tree\"}", true, sub, 0, "");
    try expectRun("{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin feature/x\"}}", true, sub, 0, "\"permissionDecision\":\"ask\"");
}

test "hook binary: every failure exits 2" {
    const ok = "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}";
    try expectRun(ok, false, sub, 2, "");
    try expectRun("", true, sub, 2, "");
    try expectRun("not json", true, sub, 2, "");
    try expectRun("{}", true, sub, 2, "");
    try expectRun(ok, true, &.{}, 2, "");
    try expectRun(ok, true, &.{"other"}, 2, "");
    try expectRun(ok, true, &.{ "claude-pretooluse", "extra" }, 2, "");
    try expectRun("[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[", true, sub, 2, "");
}
