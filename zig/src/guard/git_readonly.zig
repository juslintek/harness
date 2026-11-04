//! The git command lines that only read the repository. Port of guard/git-readonly.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Error = core.Error;

// Anything else in front of a command (GIT_PAGER, GIT_DIR, LD_PRELOAD, PATH, ...) can change what runs.
// TS: /^(LC_[A-Z_]+|LANG|TZ|NO_COLOR|TERM|COLUMNS)=/
fn harmlessEnv(a: []const u8) bool {
    const eq = std.mem.findScalar(u8, a, '=') orelse return false;
    const name = a[0..eq];
    if (core.oneOf(name, &.{ "LANG", "TZ", "NO_COLOR", "TERM", "COLUMNS" })) return true;
    if (!std.mem.startsWith(u8, name, "LC_") or name.len == 3) return false;
    for (name[3..]) |c| if (!(std.ascii.isUpper(c) or c == '_')) return false;
    return true;
}

/// `env -i cmd` and `env X=1 cmd` are stripped to `cmd` by the parser, so the wrapper name is the
/// only trace left of them.
pub fn plainEnv(cmd: *const Cmd) bool {
    for (cmd.assigns) |a| if (!harmlessEnv(a)) return false;
    return !core.contains(cmd.wrappers, "env");
}

// Long options that write a file, run a configured program, open a pager or read outside the repo.
// git accepts any unambiguous prefix, so a flag counts when either side is a prefix of the other.
const unsafe_long = [_][]const u8{
    "output",   "ext-diff",  "textconv", "filters",   "open-files-in-pager", "no-index",
    "contents", "exec-path", "git-dir",  "work-tree", "config-env",          "paginate",
};

fn unsafeFlag(sub: []const u8, arg: []const u8) bool {
    if (std.mem.startsWith(u8, arg, "--")) {
        const rest = arg[2..];
        const name = rest[0 .. std.mem.findScalar(u8, rest, '=') orelse rest.len];
        for (unsafe_long) |u| if (std.mem.startsWith(u8, u, name) or std.mem.startsWith(u8, name, u)) return true;
        return false;
    }
    // -O reads an orderfile or names a pager, and -o writes the diff to a file.
    const writes_file = core.oneOf(sub, &.{ "diff", "log", "show" });
    if (arg.len == 0 or arg[0] != '-') return false;
    for (arg[1..]) |c| {
        if (c == '-') return false;
        if (c == 'O' or (writes_file and c == 'o')) return true;
    }
    return false;
}

// Words the shell expands later cannot be judged from their text.
fn safeArgs(sub: []const u8, args: []const []const u8) bool {
    const end = for (args, 0..) |a, i| {
        if (std.mem.eql(u8, a, "--")) break i;
    } else args.len;
    for (args[0..end]) |a| if (std.mem.startsWith(u8, a, "-") and unsafeFlag(sub, a)) return false;
    return true;
}

fn isValueFlag(a: []const u8) bool {
    return core.oneOf(a, &.{ "--contains", "--merged", "--no-merged", "--format" });
}

fn branchFlag(a: []const u8) bool {
    return core.oneOf(a, &.{ "--list", "-a", "-r", "-v", "-vv", "--show-current", "--contains", "--merged", "--no-merged" }) or
        std.mem.startsWith(u8, a, "--format=");
}

/// A bare word is a branch to create, unless a listing flag turns it into a pattern or a commit.
fn listOnly(args: []const []const u8, comptime branch_flags: bool) bool {
    var positional = false;
    var listing = false;
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (!std.mem.startsWith(u8, a, "-")) {
            positional = true;
        } else if (core.oneOf(a, &.{ "--list", "-l" })) {
            listing = true;
        } else if (!(branch_flags and branchFlag(a))) {
            return false;
        } else if (isValueFlag(a)) i += 1;
    }
    if (!positional or listing) return true;
    for (args) |a| if (isValueFlag(a)) return true;
    return false;
}

fn tag(args: []const []const u8) bool {
    return args.len == 0 or (core.oneOf(args[0], &.{ "-l", "--list" }) and listOnly(args, false));
}

fn remote(args: []const []const u8) bool {
    if (args.len == 0 or (args.len == 1 and std.mem.eql(u8, args[0], "-v"))) return true;
    return args.len == 2 and std.mem.eql(u8, args[0], "get-url") and !std.mem.startsWith(u8, args[1], "-");
}

// `--list` prints every value, including remote URLs and helper settings that can hold credentials.
fn config(args: []const []const u8) bool {
    if (args.len == 0 or !core.oneOf(args[0], &.{ "--get", "--get-all", "--get-regexp" })) return false;
    for (args[1..]) |a| {
        if (std.mem.startsWith(u8, a, "-") and !core.oneOf(a, &.{ "--show-origin", "--show-scope", "--local", "--global", "--worktree" })) return false;
    }
    return true;
}

fn worktreeList(rest: []const []const u8) bool {
    if (rest.len == 0 or !std.mem.eql(u8, rest[0], "list")) return false;
    for (rest[1..]) |a| if (!std.mem.eql(u8, a, "--porcelain")) return false;
    return true;
}

fn isPlain(sub: []const u8) bool {
    return core.oneOf(sub, &.{
        "status",   "log",   "show",     "diff",     "rev-parse", "ls-files", "ls-tree",
        "cat-file", "blame", "describe", "shortlog", "grep",      "rev-list", "merge-base",
        "show-ref",
    });
}

/// Another directory may be an embedded repository whose config names programs git then runs, so
/// only the task root itself counts.
fn isRoot(ctx: Ctx, dir: []const u8) Error!bool {
    const abs = (try core.resolvePath(ctx.withCwd(.root), dir, null)) orelse return false;
    const real = (try core.realpath(ctx, abs)) orelse return false;
    const root = (try core.realpath(ctx, ctx.env.scope.root)) orelse return false;
    return std.mem.eql(u8, real, root);
}

const Parsed = struct { sub: []const u8, rest: []const []const u8 };

fn parseGlobals(ctx: Ctx, argv: []const []const u8) Error!?Parsed {
    var i: usize = 1;
    while (i < argv.len and std.mem.startsWith(u8, argv[i], "-")) : (i += 1) {
        const a = argv[i];
        if (std.mem.eql(u8, a, "-C")) {
            i += 1;
            if (!try isRoot(ctx, if (i < argv.len) argv[i] else "")) return null;
        } else if (!core.oneOf(a, &.{ "--no-pager", "-P", "--no-optional-locks" })) return null;
    }
    return .{ .sub = if (i < argv.len) argv[i] else "", .rest = if (i + 1 <= argv.len) argv[@min(i + 1, argv.len)..] else &.{} };
}

fn inertWrappers(cmd: *const Cmd) bool {
    for (cmd.wrappers) |w| if (!core.oneOf(w, &.{ "command", "nice", "timeout", "nohup", "time" })) return false;
    return true;
}

// TS: SHELL_SYNTAX = /[$`*?[{]|<stdin>/. The lexer does not keep quotes, so a quoted glob is refused
// too, and <stdin> is where xargs puts words nobody read.
fn shellSyntax(a: []const u8) bool {
    return std.mem.findAny(u8, a, "$`*?[{") != null or std.mem.find(u8, a, "<stdin>") != null;
}

pub fn isReadOnlyGit(ctx: Ctx, cmd: *const Cmd) Error!bool {
    const argv = cmd.argv;
    if (argv.len == 0 or !std.mem.eql(u8, argv[0], "git") or !inertWrappers(cmd)) return false;
    for (argv) |a| if (shellSyntax(a)) return false;
    const parsed = (try parseGlobals(ctx, argv)) orelse return false;
    const sub = parsed.sub;
    const rest = parsed.rest;
    if (isPlain(sub)) return safeArgs(sub, rest);
    if (std.mem.eql(u8, sub, "worktree")) return worktreeList(rest);
    if (std.mem.eql(u8, sub, "stash")) return rest.len > 0 and std.mem.eql(u8, rest[0], "list") and safeArgs("stash", rest);
    if (std.mem.eql(u8, sub, "branch")) return listOnly(rest, true);
    if (std.mem.eql(u8, sub, "tag")) return tag(rest);
    if (std.mem.eql(u8, sub, "remote")) return remote(rest);
    if (std.mem.eql(u8, sub, "config")) return config(rest);
    return false;
}
