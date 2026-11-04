//! Git helpers shared by slices. Port of the env scrub in code/src/server/git-env.ts.
const std = @import("std");

/// Variables git hooks export that would make a child `git` act on the hook's repository.
const repo_locating = [_][]const u8{
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
};

pub fn isRepoLocating(key: []const u8) bool {
    for (repo_locating) |name| {
        if (std.mem.eql(u8, key, name)) return true;
    }
    return false;
}

test "git: only repo-locating variables are scrubbed" {
    try std.testing.expect(isRepoLocating("GIT_DIR"));
    try std.testing.expect(isRepoLocating("GIT_PREFIX"));
    try std.testing.expect(!isRepoLocating("GIT_AUTHOR_NAME"));
    try std.testing.expect(!isRepoLocating("PATH"));
}
