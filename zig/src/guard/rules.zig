//! The rule list and the rules that need no file of their own. Port of guard/rules.ts, whose rule
//! set is adapted from cc-safety-net (MIT, Copyright (c) 2026 J Liew,
//! https://github.com/kenryu42/claude-code-safety-net).
const std = @import("std");
const core = @import("rules_core.zig");
const container = @import("rules_container.zig");
const exec = @import("rules_exec.zig");
const git = @import("rules_git.zig");
const net = @import("rules_net.zig");
const secret = @import("rules_secret.zig");
const write = @import("rules_write.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

// TS: BYPASS_ASSIGN = /^(\w*_BYPASS|SAFETY_NET_\w*|DCG_\w*|HARNESS_\w*)=/, BYPASS_NAME the same
// with `(=|$)`.
fn bypassName(s: []const u8, end_ok: bool) bool {
    const p = core.wordRun(s);
    if (if (p < s.len) s[p] != '=' else !end_ok) return false;
    const w = s[0..p];
    return std.mem.endsWith(u8, w, "_BYPASS") or std.mem.startsWith(u8, w, "SAFETY_NET_") or
        std.mem.startsWith(u8, w, "DCG_") or std.mem.startsWith(u8, w, "HARNESS_");
}

// TS: INJECTION = /^(BASH_ENV|ENV|PROMPT_COMMAND|CDPATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+)=/
fn injection(s: []const u8) bool {
    const p = core.wordRun(s);
    if (p >= s.len or s[p] != '=') return false;
    const w = s[0..p];
    return core.oneOf(w, &.{ "BASH_ENV", "ENV", "PROMPT_COMMAND", "CDPATH", "LD_PRELOAD", "LD_LIBRARY_PATH" }) or
        (std.mem.startsWith(u8, w, "DYLD_") and w.len > "DYLD_".len);
}

fn isEnvSetter(name: []const u8) bool {
    return core.oneOf(name, &.{ "export", "declare", "typeset", "readonly", "local", "env", "read" });
}

fn envTricks(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    const setter = isEnvSetter(name);
    const args = if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv;
    var bypass = false;
    for (cmd.assigns) |w| if (bypassName(w, false)) {
        bypass = true;
    };
    if (setter) for (args) |w| if (bypassName(w, true)) {
        bypass = true;
    };
    if (bypass) return core.deny("env.bypass", "setting a guard bypass variable is blocked", .other);
    if (try git.gitEnvironment(ctx, cmd.assigns, cmd.argv, name)) |r| return r;
    var injected = false;
    for (cmd.assigns) |w| if (injection(w)) {
        injected = true;
    };
    if (setter) for (args) |w| if (injection(w)) {
        injected = true;
    };
    return if (injected) core.ask("env.injection", "this variable makes a shell load or redirect code", .other) else null;
}

fn isAlwaysDestructive(name: []const u8) bool {
    return core.oneOf(name, &.{ "unlink", "shred", "srm", "rmdir", "truncate", "rimraf", "del", "del-cli" });
}

const RmPlace = enum { unknown, cwd, outside, root, inside };

fn rmPlace(ctx: Ctx, p: []const u8) Error!RmPlace {
    const abs = (try core.resolvePath(ctx, p, null)) orelse {
        const known = ctx.cwd == .unknown and (try core.resolvePath(ctx, p, ctx.env.scope.root)) != null;
        return if (known) .cwd else .unknown;
    };
    if (!core.isInside(ctx, abs)) return .outside;
    // TS: abs === root || /(^|\/)\.\*$/.test(raw)
    const star = std.mem.eql(u8, p, ".*") or std.mem.endsWith(u8, p, "/.*");
    return if (std.mem.eql(u8, abs, ctx.env.scope.root) or star) .root else .inside;
}

fn rm(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    if (!std.mem.eql(u8, name, "rm") and !isAlwaysDestructive(name)) return null;
    const o = try core.parseOpts(ctx.env.a, cmd.argv[1..]);
    const heavy = !std.mem.eql(u8, name, "rm") or o.anyShort("rRf") or o.hasLong("recursive") or o.hasLong("force");
    var bad: ?[]const u8 = null;
    var has: struct { outside: bool = false, unknown: bool = false, root: bool = false, cwd: bool = false } = .{};
    for (o.rest) |p| {
        const w = try rmPlace(ctx, p);
        switch (w) {
            .outside => has.outside = true,
            .unknown => has.unknown = true,
            .root => has.root = true,
            .cwd => has.cwd = true,
            .inside => {},
        }
        if (bad == null and (w == .outside or (heavy and w == .unknown))) bad = p;
    }
    if (has.outside or (heavy and has.unknown)) {
        return core.deny("rm.outside-root", try core.fmt(ctx, "{s} is outside or cannot be placed in the task root", .{bad.?}), .delete);
    }
    if (heavy and !o.hasLong("find") and has.root) return core.ask("rm.task-root", "removes the whole task root", .delete);
    if (has.cwd) return core.ask("rm.cwd-unknown", "working directory is not known", .delete);
    return if (has.unknown)
        core.ask("rm.unresolvable-path", "rm target depends on a variable", .delete)
    else
        core.allow("rm.in-root", "delete inside the task root", .delete);
}

fn disk(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    _ = ctx;
    const name = core.name0(cmd);
    const sub = if (cmd.argv.len > 1) cmd.argv[1] else "";
    if (std.mem.eql(u8, name, "dd")) for (cmd.argv) |a| if (std.mem.startsWith(u8, a, "of=/dev/")) {
        return core.deny("disk.dd-device", "dd writes to a device", .shell);
    };
    if (std.mem.startsWith(u8, name, "mkfs") or std.mem.startsWith(u8, name, "newfs")) {
        return core.deny("disk.mkfs", "formats a filesystem", .shell);
    }
    if (!std.mem.eql(u8, name, "diskutil")) return null;
    var erase = false;
    for ([_][]const u8{ "erase", "zero", "secure", "partition", "repartition", "reformat" }) |p| {
        if (core.startsWithIgnoreCase(sub, p)) erase = true;
    }
    const third = if (cmd.argv.len > 2) cmd.argv[2] else "";
    const apfs = std.mem.eql(u8, sub, "apfs") and (core.startsWithIgnoreCase(third, "delete") or core.startsWithIgnoreCase(third, "erase"));
    return if (erase or apfs) core.deny("disk.diskutil-erase", "diskutil destroys volumes", .shell) else null;
}

fn gitRule(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    return if (std.mem.eql(u8, core.name0(cmd), "git")) git.gitRule(ctx, cmd.argv) else null;
}

pub const Rule = *const fn (*const Cmd, Ctx) Error!?Result;

pub const rules = [_]Rule{
    envTricks,
    exec.dynamicName,
    container.container,
    secret.sweep,
    gitRule,
    rm,
    disk,
    write.perms,
    net.network,
    secret.secrets,
    write.writes,
    exec.inlineCode,
    exec.stdinScript,
    exec.sourceOutside,
    exec.escalate,
};
