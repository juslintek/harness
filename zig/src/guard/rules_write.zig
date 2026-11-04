//! Writes outside the task root, git internals and permission changes. Port of guard/rules-write.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const secret = @import("rules_secret.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

const Placement = enum { sink, internals, unknown, outside, inside };

// TS: REMOTE = /^[^/.][^/]*:/
fn isRemote(p: []const u8) bool {
    if (p.len < 2 or p[0] == '/' or p[0] == '.') return false;
    const colon = std.mem.findScalar(u8, p[1..], ':') orelse return false;
    return std.mem.findScalar(u8, p[1 .. 1 + colon], '/') == null;
}

fn place(ctx: Ctx, p: []const u8) Error!Placement {
    const abs = (if (isRemote(p)) null else try core.resolvePath(ctx, p, null)) orelse return .unknown;
    if (core.oneOf(abs, &.{ "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty" })) return .sink;
    if (core.isGitInternals(abs)) return .internals;
    return if (core.isInside(ctx, abs)) .inside else .outside;
}

/// Destructive writes outside the task root are denied, softer ones are asked; unknown targets are asked.
fn judge(ctx: Ctx, paths: []const []const u8, destructive: bool, label: []const u8) Error!?Result {
    var outside = false;
    var unknown = false;
    for (paths) |p| switch (try place(ctx, p)) {
        .internals => return core.deny("write.git-internals", "git hooks and config run code", .edit),
        .outside => outside = true,
        .unknown => unknown = true,
        else => {},
    };
    if (destructive and outside) {
        return core.deny("write.outside-root", try core.fmt(ctx, "{s} changes files outside the task root", .{label}), .edit);
    }
    if (!outside and !unknown) return null;
    return core.ask("write.outside-root", try core.fmt(ctx, "{s} writes where the guard cannot confirm the root", .{label}), .edit);
}

fn optionValue(argv: []const []const u8, short: []const u8, long: []const u8) ?[]const u8 {
    for (argv, 0..) |a, i| {
        const eq_long = std.mem.startsWith(u8, a, long) and a.len > long.len and a[long.len] == '=';
        if (!(std.mem.eql(u8, a, short) or std.mem.eql(u8, a, long) or eq_long)) continue;
        if (std.mem.findScalar(u8, a, '=')) |eq| return a[eq + 1 ..];
        return if (i + 1 < argv.len) argv[i + 1] else null;
    }
    return null;
}

fn lastOf(rest: []const []const u8) []const []const u8 {
    return rest[rest.len -| 1..];
}

fn copyLike(ctx: Ctx, cmd: *const Cmd, name: []const u8) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, cmd.argv[1..]);
    const dir = optionValue(cmd.argv, "-t", "--target-directory");
    const target: [1][]const u8 = .{dir orelse ""};
    const dest: []const []const u8 = if (dir != null) &target else lastOf(o.rest);
    if (std.mem.eql(u8, name, "mv")) return judge(ctx, o.rest, true, name);
    if (std.mem.eql(u8, name, "ln")) {
        const forced = o.hasShort('f') or o.hasLong("force");
        if (try judge(ctx, dest, forced, name)) |r| return r;
        return judge(ctx, o.rest[0..@min(1, o.rest.len)], false, name);
    }
    return judge(ctx, dest, true, name);
}

fn rsync(ctx: Ctx, cmd: *const Cmd) Error!?Result {
    const o = try core.parseOpts(ctx.env.a, cmd.argv[1..]);
    var deleting = false;
    for (cmd.argv) |a| if (std.mem.startsWith(u8, a, "--delete") or std.mem.eql(u8, a, "--remove-source-files")) {
        deleting = true;
    };
    return judge(ctx, lastOf(o.rest), deleting, "rsync");
}

/// The first operand is the script (or the -e value), the rest are files edited in place.
fn inPlaceTargets(ctx: Ctx, cmd: *const Cmd) Error![]const []const u8 {
    const o = try core.parseOpts(ctx.env.a, cmd.argv[1..]);
    if (!o.hasShort('i') and !o.hasLong("in-place")) return &.{};
    var kept: std.ArrayList([]const u8) = .empty;
    for (o.rest) |a| if (a.len > 0) try kept.append(ctx.env.a, a);
    return if (kept.items.len > 0) kept.items[1..] else &.{};
}

// TS: /^-[a-zA-Z]+$/
fn isShortCluster(a: []const u8) bool {
    if (a.len < 2 or a[0] != '-') return false;
    for (a[1..]) |c| if (!std.ascii.isAlphabetic(c)) return false;
    return true;
}

// TS: the capture of an unanchored `(.+)`, which stops at the first line terminator and may not be empty.
fn dotPlus(s: []const u8) ?[]const u8 {
    var end: usize = 0;
    while (end < s.len and s[end] != '\n' and s[end] != '\r') end += 1;
    if (std.mem.find(u8, s[0..end], "\u{2028}")) |i| end = i;
    if (std.mem.find(u8, s[0..end], "\u{2029}")) |i| end = i;
    return if (end == 0) null else s[0..end];
}

fn tar(ctx: Ctx, cmd: *const Cmd) Error!?Result {
    const args = cmd.argv[1..];
    var letters: std.ArrayList(u8) = .empty;
    if (args.len > 0 and !std.mem.startsWith(u8, args[0], "-")) try letters.appendSlice(ctx.env.a, args[0]);
    for (args) |a| if (isShortCluster(a)) try letters.appendSlice(ctx.env.a, a[1..]);
    const extract = std.mem.findScalar(u8, letters.items, 'x') != null or core.contains(args, "--extract") or core.contains(args, "--get");
    var dirs: std.ArrayList([]const u8) = .empty;
    var cur = ctx;
    for (args, 0..) |a, i| {
        const dir: ?[]const u8 = if (core.oneOf(a, &.{ "-C", "--directory" }))
            (if (i + 1 < args.len) args[i + 1] else null)
        else if (std.mem.startsWith(u8, a, "--directory="))
            dotPlus(a["--directory=".len..])
        else if (std.mem.startsWith(u8, a, "-C"))
            dotPlus(a[2..])
        else
            null;
        if (dir) |d| {
            try dirs.append(ctx.env.a, d);
            cur = ctx.withCwd(if (try core.resolvePath(ctx, d, null)) |abs| .{ .dir = abs } else .unknown);
        } else if (!std.mem.startsWith(u8, a, "-") and i > 0 and try secret.isSecretPath(cur, a)) {
            return try secret.secretPathDeny(ctx, a);
        }
    }
    if (!extract) return null;
    const dot: []const []const u8 = &.{"."};
    return judge(ctx, if (dirs.items.len > 0) dirs.items else dot, true, "tar");
}

fn dd(ctx: Ctx, cmd: *const Cmd) Error!?Result {
    var outs: std.ArrayList([]const u8) = .empty;
    for (cmd.argv) |a| if (std.mem.startsWith(u8, a, "of=")) try outs.append(ctx.env.a, a[3..]);
    return judge(ctx, outs.items, true, "dd");
}

fn redirects(ctx: Ctx, cmd: *const Cmd) Error!?Result {
    var targets: std.ArrayList([]const u8) = .empty;
    for (cmd.redirects) |r| if (r.op == .out) try targets.append(ctx.env.a, r.path);
    return judge(ctx, targets.items, true, "redirect");
}

fn byName(ctx: Ctx, cmd: *const Cmd, name: []const u8) Error!?Result {
    if (cmd.argv.len == 0) return null;
    if (core.oneOf(name, &.{ "tee", "touch", "mkdir" })) {
        return judge(ctx, (try core.parseOpts(ctx.env.a, cmd.argv[1..])).rest, false, name);
    }
    if (core.oneOf(name, &.{ "mv", "cp", "install", "ln" })) return copyLike(ctx, cmd, name);
    if (std.mem.eql(u8, name, "rsync")) return rsync(ctx, cmd);
    if (std.mem.eql(u8, name, "tar")) return tar(ctx, cmd);
    if (std.mem.eql(u8, name, "dd")) return dd(ctx, cmd);
    if (core.oneOf(name, &.{ "sed", "gsed", "perl" })) return judge(ctx, try inPlaceTargets(ctx, cmd), true, name);
    return null;
}

pub fn writes(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    if (try redirects(ctx, cmd)) |r| return r;
    return byName(ctx, cmd, core.name0(cmd));
}

// TS: /^(0?777|a\+rwx|ugo\+rwx|o\+w)$/
fn worldWritable(mode: []const u8) bool {
    return core.oneOf(mode, &.{ "777", "0777", "a+rwx", "ugo+rwx", "o+w" });
}

pub fn perms(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    if (!core.oneOf(name, &.{ "chmod", "chown", "chgrp" })) return null;
    const o = try core.parseOpts(ctx.env.a, cmd.argv[1..]);
    const recursive = o.hasShort('R') or o.hasLong("recursive");
    if (std.mem.eql(u8, name, "chmod") and recursive and o.rest.len > 0 and worldWritable(o.rest[0])) {
        return core.deny("perms.world-writable", "recursive world-writable chmod", .shell);
    }
    var hit = (try judge(ctx, o.rest, true, name)) orelse return null;
    hit.rule = "perms.outside-root";
    hit.category = .shell;
    return hit;
}
