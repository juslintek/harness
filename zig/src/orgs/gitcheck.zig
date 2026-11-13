//! `assertGitRepo` of projects.ts: a project's repo must be an absolute path that git accepts.
//! It runs before the state lock is taken, with the repo-locating variables git hooks export
//! removed from the environment, as git-env.ts does, and with a time limit that TS lacks.
const std = @import("std");
const git = @import("../git.zig");
const runner_mod = @import("../agents/runner.zig");

const Allocator = std.mem.Allocator;

const timeout_ms: i64 = 10_000;

fn scrubbed(gpa: Allocator, base: *const std.process.Environ.Map) Allocator.Error!std.process.Environ.Map {
    var env = std.process.Environ.Map.init(gpa);
    errdefer env.deinit();
    var it = base.iterator();
    while (it.next()) |entry| {
        if (!git.isRepoLocating(entry.key_ptr.*)) try env.put(entry.key_ptr.*, entry.value_ptr.*);
    }
    return env;
}

/// The message TS answers 400 with, or null when `repo` is a git repository.
pub fn refusal(gpa: Allocator, io: std.Io, arena: Allocator, base_env: ?*const std.process.Environ.Map, repo: []const u8) Allocator.Error!?[]const u8 {
    if (repo.len == 0 or repo[0] != '/') return try std.fmt.allocPrint(arena, "repo must be an absolute path: {s}", .{repo});
    const refused = try std.fmt.allocPrint(arena, "not a git repo: {s}", .{repo});
    // execve stops reading an argument at a NUL, so git would check a shorter path than the row keeps.
    if (std.mem.findScalar(u8, repo, 0) != null) return refused;
    var env = try scrubbed(gpa, base_env orelse return refused);
    defer env.deinit();
    var process: runner_mod.ProcessRunner = .{ .gpa = gpa, .io = io, .base_env = &env };
    const out = process.runner().run(arena, &.{ "git", "-C", repo, "rev-parse", "--git-dir" }, timeout_ms, &.{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return refused,
    };
    return if (out.code == 0) null else refused;
}

test "orgs: a NUL byte hides nothing from the git check" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("PATH", "/usr/bin:/bin");
    // The tests run inside the checkout, so the working directory is a git repository.
    const here = try std.process.currentPathAlloc(std.testing.io, arena.allocator());
    try std.testing.expect(try refusal(std.testing.allocator, std.testing.io, arena.allocator(), &env, here) == null);
    // execve would stop at the NUL and accept `here`, while the row would keep the whole string.
    const smuggled = try std.fmt.allocPrint(arena.allocator(), "{s}\x00/not-a-repo", .{here});
    try std.testing.expect(try refusal(std.testing.allocator, std.testing.io, arena.allocator(), &env, smuggled) != null);
}
