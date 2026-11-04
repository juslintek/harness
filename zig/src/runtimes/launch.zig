//! Minimal, unsandboxed launch of an agent: its argv from the spec, a scrubbed environment and the
//! repository as the working directory. Port of the env part of createLaunch in
//! code/src/server/features/runtimes/launch.ts. Worktrees, srt wrapping, the run token, the codex
//! home and the Claude settings belong to the sandbox slice (Z16), which extends this file.
const std = @import("std");
const types = @import("types.zig");

const Allocator = std.mem.Allocator;

/// SCRUB_KEEP in code/src/server/features/guard/sandbox.ts. Everything else, including every
/// repo-locating GIT_* variable a git hook exports and any credential in the server's own
/// environment, stays out of the agent.
pub fn keepsVariable(key: []const u8) bool {
    const exact = [_][]const u8{ "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR" };
    for (exact) |name| {
        if (std.mem.eql(u8, key, name)) return true;
    }
    return std.mem.startsWith(u8, key, "LC_");
}

pub const Extra = struct { key: []const u8, value: []const u8 };

/// The values of every run: git must not page, because the guard treats git log, diff and show
/// as read-only only while no pager runs.
pub const run_env = [_]Extra{
    .{ .key = "GIT_PAGER", .value = "cat" },
    .{ .key = "PAGER", .value = "cat" },
};

pub const Launch = struct {
    argv: []const []const u8,
    env: std.process.Environ.Map,
    cwd: []const u8,
    gpa: Allocator,

    pub fn deinit(launch: *Launch) void {
        for (launch.argv) |arg| launch.gpa.free(arg);
        launch.gpa.free(launch.argv);
        launch.gpa.free(launch.cwd);
        launch.env.deinit();
    }
};

/// `parent` is the server's environment; `extra` is added last and wins, like the `...extra` of
/// scrubEnv. Everything in the result is copied.
pub fn build(
    gpa: Allocator,
    spec: types.Spec,
    repo: []const u8,
    parent: *const std.process.Environ.Map,
    extra: []const Extra,
) Allocator.Error!Launch {
    var env = std.process.Environ.Map.init(gpa);
    errdefer env.deinit();
    var it = parent.iterator();
    while (it.next()) |entry| {
        if (keepsVariable(entry.key_ptr.*)) try env.put(entry.key_ptr.*, entry.value_ptr.*);
    }
    for (extra) |item| try env.put(item.key, item.value);

    const argv = try gpa.alloc([]const u8, spec.argv.len);
    var made: usize = 0;
    errdefer {
        for (argv[0..made]) |arg| gpa.free(arg);
        gpa.free(argv);
    }
    for (spec.argv, argv) |arg, *dst| {
        dst.* = try gpa.dupe(u8, arg);
        made += 1;
    }
    const cwd = try gpa.dupe(u8, repo);
    return .{ .argv = argv, .env = env, .cwd = cwd, .gpa = gpa };
}

const testing = std.testing;

test "launch: only the allow-listed variables survive the scrub" {
    var parent = std.process.Environ.Map.init(testing.allocator);
    defer parent.deinit();
    for ([_][2][]const u8{
        .{ "PATH", "/bin" },           .{ "HOME", "/h" },        .{ "LC_ALL", "C" },
        .{ "GIT_DIR", "/repo" },       .{ "GIT_PAGER", "less" }, .{ "ANTHROPIC_API_KEY", "sk" },
        .{ "HARNESS_RUN_TOKEN", "t" },
    }) |pair| try parent.put(pair[0], pair[1]);
    var launch = try build(testing.allocator, .{ .id = "x", .argv = &.{ "agent", "--acp" } }, "/repo", &parent, &run_env);
    defer launch.deinit();
    try testing.expectEqualStrings("/bin", launch.env.get("PATH").?);
    try testing.expectEqualStrings("C", launch.env.get("LC_ALL").?);
    try testing.expect(launch.env.get("GIT_DIR") == null);
    try testing.expect(launch.env.get("ANTHROPIC_API_KEY") == null);
    try testing.expect(launch.env.get("HARNESS_RUN_TOKEN") == null);
    try testing.expectEqualStrings("cat", launch.env.get("GIT_PAGER").?);
    try testing.expectEqualStrings("cat", launch.env.get("PAGER").?);
    try testing.expectEqual(@as(usize, 2), launch.argv.len);
    try testing.expectEqualStrings("--acp", launch.argv[1]);
    try testing.expectEqualStrings("/repo", launch.cwd);
}

test "launch: allocation failures leave nothing behind" {
    const Run = struct {
        fn run(gpa: Allocator) !void {
            var parent = std.process.Environ.Map.init(testing.allocator);
            defer parent.deinit();
            try parent.put("PATH", "/bin");
            var launch = try build(gpa, .{ .id = "x", .argv = &.{ "a", "b", "c" } }, "/repo", &parent, &run_env);
            launch.deinit();
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Run.run, .{});
}
