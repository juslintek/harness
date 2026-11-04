//! Destructive and code-running git invocations. Port of guard/rules-git.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

const GitCall = struct {
    cfg: []const []const u8,
    redirected: bool,
    dir: ?[]const u8,
    sub: []const u8,
    rest: []const []const u8,
};

fn isValueFlag(a: []const u8) bool {
    return core.oneOf(a, &.{ "--git-dir", "--work-tree", "--namespace", "--exec-path" });
}

// TS: /^--(git-dir|work-tree)\b/
fn redirects(a: []const u8) bool {
    inline for (.{ "--git-dir", "--work-tree" }) |f| {
        if (std.mem.startsWith(u8, a, f) and (a.len == f.len or !core.isWordChar(a[f.len]))) return true;
    }
    return false;
}

// Every global option that TS handles in globalOption also swallows the next token, `--config-env=x`
// included; only a flag it does not know is skipped alone.
fn parseGit(a: std.mem.Allocator, argv: []const []const u8) Error!GitCall {
    var cfg: std.ArrayList([]const u8) = .empty;
    errdefer cfg.deinit(a);
    var g: GitCall = .{ .cfg = &.{}, .redirected = false, .dir = null, .sub = "", .rest = &.{} };
    var i: usize = 1;
    while (i < argv.len and std.mem.startsWith(u8, argv[i], "-")) {
        const arg = argv[i];
        const next: ?[]const u8 = if (i + 1 < argv.len) argv[i + 1] else null;
        if (redirects(arg)) g.redirected = true;
        if (core.oneOf(arg, &.{ "-c", "--config-env" })) {
            try cfg.append(a, next orelse "");
            i += 1;
        } else if (std.mem.startsWith(u8, arg, "--config-env=")) {
            try cfg.append(a, arg["--config-env=".len..]);
            i += 1;
        } else if (std.mem.eql(u8, arg, "-C")) {
            g.dir = next;
            i += 1;
        } else if (isValueFlag(arg)) i += 1;
        i += 1;
    }
    g.cfg = try cfg.toOwnedSlice(a);
    g.sub = if (i < argv.len) argv[i] else "";
    g.rest = argv[@min(i + 1, argv.len)..];
    return g;
}

fn isForce(o: core.Opts) bool {
    return o.hasShort('f') or o.hasLong("force") or o.hasLong("force-with-lease") or o.hasLong("force-if-includes");
}

fn push(ctx: Ctx, g: GitCall) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, g.rest);
    if (isForce(o)) return core.deny("git.push-force", "force push rewrites remote history", .shell);
    if (o.hasLong("mirror") or o.hasLong("delete") or o.hasLong("prune") or o.hasLong("all") or o.hasShort('d')) {
        return core.deny("git.push-destructive", "push mode deletes or overwrites remote refs", .shell);
    }
    var has_repo = false;
    for (g.rest) |a| if (std.mem.startsWith(u8, a, "--repo=")) {
        has_repo = true;
    };
    const refspecs = if (has_repo) o.rest else o.rest[@min(1, o.rest.len)..];
    for (refspecs) |spec| {
        if (std.mem.startsWith(u8, spec, "+")) return core.deny("git.push-force", "+refspec forces the update", .shell);
        if (std.mem.startsWith(u8, spec, ":")) return core.deny("git.push-destructive", "empty source deletes the remote ref", .shell);
        const dst = if (std.mem.findScalarLast(u8, spec, ':')) |c| spec[c + 1 ..] else spec;
        if (std.mem.eql(u8, std.mem.cutPrefix(u8, dst, "refs/heads/") orelse dst, ctx.env.scope.default_branch)) {
            return core.deny("git.push-default-branch", try core.fmt(ctx, "push to {s} needs a manager", .{ctx.env.scope.default_branch}), .shell);
        }
    }
    return core.ask("git.push", "git push publishes commits", .git_push);
}

/// Discarding uncommitted work: denied outside the task root, asked inside it.
fn discard(ctx: Ctx, g: GitCall, paths: []const []const u8) Error!?Result {
    if (paths.len == 0) return null;
    const dir: ?[]const u8 = if (g.dir) |d| try core.resolvePath(ctx, d, null) else ctx.env.scope.root;
    var outside = dir == null or !core.isInside(ctx, dir.?);
    if (!outside) for (paths) |p| {
        const abs = try core.resolvePath(ctx, p, dir.?);
        if (abs == null or !core.isInside(ctx, abs.?)) outside = true;
    };
    if (outside) return core.deny("git.discard-outside-root", "discards changes outside the task root", .shell);
    return core.ask("git.discard-changes", "discards uncommitted changes", .shell);
}

fn checkout(ctx: Ctx, g: GitCall) Error!?Result {
    const sep = for (g.rest, 0..) |a, i| {
        if (std.mem.eql(u8, a, "--")) break i;
    } else null;
    const head = try core.parseOpts(ctx.env.a, if (sep) |s| g.rest[0..s] else g.rest);
    if (head.hasShort('f') or head.hasLong("force")) {
        return core.deny("git.checkout-force", "forced checkout discards local changes", .shell);
    }
    if (sep) |s| return discard(ctx, g, g.rest[s + 1 ..]);
    var dots: std.ArrayList([]const u8) = .empty;
    for (g.rest) |a| if (std.mem.eql(u8, a, ".")) try dots.append(ctx.env.a, a);
    return discard(ctx, g, dots.items);
}

fn restore(ctx: Ctx, g: GitCall) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, g.rest);
    const staged = o.hasLong("staged") or o.hasShort('S');
    const worktree = o.hasLong("worktree") or o.hasShort('W');
    return if (staged and !worktree) null else discard(ctx, g, o.rest);
}

fn branch(ctx: Ctx, g: GitCall) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, g.rest);
    const dflt = ctx.env.scope.default_branch;
    const force = o.hasShort('D') or ((o.hasShort('d') or o.hasLong("delete")) and (o.hasShort('f') or o.hasLong("force")));
    if ((o.hasShort('M') or o.hasShort('m')) and core.contains(o.rest, dflt)) {
        return core.deny("git.branch-overwrite-default", try core.fmt(ctx, "renaming over {s} is blocked", .{dflt}), .shell);
    }
    const removes = force or o.hasShort('d') or o.hasLong("delete");
    if (removes and core.contains(o.rest, dflt)) {
        return core.deny("git.branch-delete-default", try core.fmt(ctx, "deleting {s} is blocked", .{dflt}), .shell);
    }
    return if (force) core.ask("git.branch-force-delete", "force delete drops unmerged commits", .shell) else null;
}

fn reset(ctx: Ctx, g: GitCall) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, g.rest);
    return if (o.hasLong("hard") or o.hasLong("merge")) core.deny("git.reset-hard", "hard reset discards local changes", .shell) else null;
}

fn clean(ctx: Ctx, g: GitCall) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, g.rest);
    const dry_run = o.hasShort('n') or o.hasLong("dry-run");
    const forced = o.hasShort('f') or o.hasLong("force");
    return if (forced and !dry_run) core.deny("git.clean-force", "git clean -f deletes untracked files", .shell) else null;
}

// Keys whose value makes git run an arbitrary program or load more config.
// TS: RISKY_KEY, flag i, so ASCII case is ignored; `.+` refuses line terminators.
pub fn riskyKey(k: []const u8) bool {
    const eq = std.ascii.eqlIgnoreCase;
    const starts = core.startsWithIgnoreCase;
    if (starts(k, "core.")) {
        const v = k["core.".len..];
        for ([_][]const u8{ "hookspath", "sshcommand", "fsmonitor", "pager", "editor", "gitproxy" }) |n| if (eq(v, n)) return true;
        return false;
    }
    if (eq(k, "include.path") or eq(k, "diff.external") or eq(k, "uploadpack.packobjectshook")) return true;
    for ([_][]const u8{ "includeif.", "filter." }) |p| {
        if (starts(k, p) and k.len > p.len and !core.hasLineTerminator(k[p.len..])) return true;
    }
    if (starts(k, "credential")) {
        const rest = k["credential".len..];
        if (eq(rest, ".helper")) return true;
        const tail = ".helper";
        if (rest.len >= 2 + tail.len and rest[0] == '.' and eq(rest[rest.len - tail.len ..], tail)) {
            return !core.hasLineTerminator(rest[1 .. rest.len - tail.len]);
        }
    }
    return false;
}

fn isAliasKey(k: []const u8) bool {
    return core.startsWithIgnoreCase(k, "alias.");
}

fn riskyConfig(key: []const u8, value: ?[]const u8) bool {
    const k = key[0 .. std.mem.findScalar(u8, key, '=') orelse key.len];
    if (isAliasKey(k)) {
        const v = if (k.len < key.len) key[k.len + 1 ..] else (value orelse "");
        return std.mem.startsWith(u8, v, "!");
    }
    return riskyKey(k);
}

fn configDeny(ctx: Ctx, key: []const u8) Error!Result {
    const k = key[0 .. std.mem.findScalar(u8, key, '=') orelse key.len];
    return core.deny("git.config-override", try core.fmt(ctx, "git config {s} can run arbitrary code", .{k}), .shell);
}

fn config(ctx: Ctx, g: GitCall) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, g.rest);
    if (o.hasLong("get") or o.hasLong("get-all") or o.hasLong("list") or o.hasLong("l") or o.hasLong("unset") or o.hasShort('l')) return null;
    for (o.rest, 0..) |k, i| {
        if (i + 1 < o.rest.len and riskyConfig(k, o.rest[i + 1])) return try configDeny(ctx, k);
    }
    return null;
}

fn hasFlag(rest: []const []const u8, comptime flags: []const []const u8) bool {
    inline for (flags) |f| if (core.contains(rest, f)) return true;
    return false;
}

fn first(rest: []const []const u8) []const u8 {
    return if (rest.len > 0) rest[0] else "";
}

// TS: GIT_ENV, flag s. The name part holds no `=`, so it ends at the first one.
fn isGitEnvName(n: []const u8) bool {
    if (core.oneOf(n, &.{
        "GIT_DIR",                          "GIT_WORK_TREE",         "GIT_COMMON_DIR",    "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
        "GIT_EXEC_PATH",                    "GIT_SSH",               "GIT_SSH_COMMAND",   "GIT_EXTERNAL_DIFF",
        "GIT_PAGER",                        "GIT_ASKPASS",           "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR",
    })) return true;
    const prefix = "GIT_CONFIG_KEY_";
    if (!std.mem.startsWith(u8, n, prefix) or n.len == prefix.len) return false;
    return std.mem.findNone(u8, n[prefix.len..], "0123456789") == null;
}

/// Environment-based config injection: `GIT_CONFIG_KEY_0=core.hooksPath` or a program path variable.
pub fn gitEnvironment(ctx: Ctx, assigns: []const []const u8, argv: []const []const u8, name: []const u8) Error!?Result {
    const extra: []const []const u8 = if (std.mem.eql(u8, name, "env") and argv.len > 0) argv[1..] else &.{};
    const lists = [_][]const []const u8{ assigns, extra };
    for (lists) |words| for (words) |w| {
        const eq = std.mem.findScalar(u8, w, '=') orelse continue;
        const var_name = w[0..eq];
        if (!isGitEnvName(var_name)) continue;
        const value = w[eq + 1 ..];
        const keyed = std.mem.startsWith(u8, var_name, "GIT_CONFIG_KEY_");
        if (!keyed or riskyKey(value) or isAliasKey(value)) {
            return core.deny("git.env-override", try core.fmt(ctx, "{s} makes git run attacker-chosen code", .{var_name}), .shell);
        }
    };
    return null;
}

fn handle(ctx: Ctx, g: GitCall) Error!?Result {
    const E = enum { push, checkout, restore, branch, reset, clean, stash, @"filter-branch", @"filter-repo", config, @"update-ref", @"checkout-index", @"switch", worktree, reflog, gc, rm };
    const h = std.meta.stringToEnum(E, g.sub) orelse return null;
    const rest = g.rest;
    return switch (h) {
        .push => push(ctx, g),
        .checkout => checkout(ctx, g),
        .restore => restore(ctx, g),
        .branch => branch(ctx, g),
        .reset => reset(ctx, g),
        .clean => clean(ctx, g),
        .stash => if (std.mem.eql(u8, first(rest), "clear")) core.deny("git.stash-clear", "drops every stash", .shell) else null,
        .@"filter-branch", .@"filter-repo" => core.deny("git.filter-branch", "rewrites the whole history", .shell),
        .config => config(ctx, g),
        .@"update-ref" => if (core.contains(rest, "-d")) core.deny("git.update-ref-delete", "deletes a ref without a trace", .shell) else null,
        .@"checkout-index" => if (hasFlag(rest, &.{ "-f", "--force" })) core.deny("git.checkout-force", "forced checkout-index overwrites local changes", .shell) else null,
        .@"switch" => if (hasFlag(rest, &.{ "-f", "--force", "--discard-changes" })) core.deny("git.switch-force", "forced switch discards local changes", .shell) else null,
        .worktree => if (std.mem.eql(u8, first(rest), "remove") and hasFlag(rest, &.{ "-f", "--force" })) core.deny("git.worktree-force", "forced worktree removal drops uncommitted work", .shell) else null,
        .reflog => if (core.oneOf(first(rest), &.{ "expire", "delete" })) core.deny("git.reflog-expire", "reflog is the recovery path", .shell) else null,
        .gc => if (core.contains(rest, "--prune=now")) core.deny("git.gc-prune-now", "prune now makes unreachable commits unrecoverable", .shell) else null,
        .rm => blk: {
            const o = try core.parseOpts(ctx.env.a, rest);
            break :blk if (o.hasShort('f') or o.hasLong("force")) core.deny("git.rm-force", "forced git rm deletes files with local changes", .shell) else null;
        },
    };
}

pub fn gitRule(ctx: Ctx, argv: []const []const u8) Error!?Result {
    const g = try parseGit(ctx.env.a, argv);
    if (g.redirected) {
        return core.deny("git.dir-override", "--git-dir and --work-tree point git at a repo the guard cannot vouch for", .shell);
    }
    for (g.cfg) |c| if (riskyConfig(c, null)) return try configDeny(ctx, c);
    return handle(ctx, g);
}
