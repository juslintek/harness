//! Interpreters, inline code, stdin scripts, sourcing and privilege wrappers. Port of
//! guard/rules-exec.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

fn digitsAndDots(s: []const u8) bool {
    for (s) |c| if (!std.ascii.isDigit(c) and c != '.') return false;
    return true;
}

fn isPython(n: []const u8) bool {
    return std.mem.startsWith(u8, n, "python") and digitsAndDots(n["python".len..]);
}

fn isNode(n: []const u8) bool {
    return core.oneOf(n, &.{ "node", "nodejs" });
}

/// Interpreters that take a program from stdin when no script operand is given.
// TS: RUNNER = /^(sh|bash|zsh|dash|ksh|fish|python[\d.]*|node(?:js)?|perl|ruby|php|deno|bun|osascript)$/
pub fn isRunner(n: []const u8) bool {
    return isPython(n) or isNode(n) or
        core.oneOf(n, &.{ "sh", "bash", "zsh", "dash", "ksh", "fish", "perl", "ruby", "php", "deno", "bun", "osascript" });
}

fn lettersContain(a: []const u8, comptime wanted: []const u8) bool {
    if (a.len == 0 or a[0] != '-') return false;
    for (a[1..]) |c| {
        if (!std.ascii.isAlphabetic(c)) return false;
        if (std.mem.findScalar(u8, wanted, c) != null) return true;
    }
    return false;
}

// TS: /^(--eval|--print)(=|$)/
fn evalLong(a: []const u8) bool {
    inline for (.{ "--eval", "--print" }) |f| {
        if (std.mem.startsWith(u8, a, f) and (a.len == f.len or a[f.len] == '=')) return true;
    }
    return false;
}

fn inlineFlag(name: []const u8, a: []const u8) bool {
    if (isPython(name)) return lettersContain(a, "c");
    if (std.mem.eql(u8, name, "perl")) return lettersContain(a, "eE");
    if (std.mem.eql(u8, name, "ruby") or std.mem.eql(u8, name, "osascript")) return lettersContain(a, "e");
    if (isNode(name)) return evalLong(a) or lettersContain(a, "ep");
    if (std.mem.eql(u8, name, "bun")) return evalLong(a) or (a.len >= 2 and a[0] == '-' and (a[1] == 'e' or a[1] == 'p'));
    if (std.mem.eql(u8, name, "php")) return lettersContain(a, "r");
    return false;
}

// TS: STDIN_PATH = /^(\/dev\/(stdin|fd\/\d+)|\/proc\/self\/fd\/\d+)$/
fn isStdinPath(s: []const u8) bool {
    if (std.mem.eql(u8, s, "/dev/stdin")) return true;
    for ([_][]const u8{ "/dev/fd/", "/proc/self/fd/" }) |p| {
        if (!std.mem.startsWith(u8, s, p)) continue;
        const d = s[p.len..];
        if (d.len > 0 and std.mem.findNone(u8, d, "0123456789") == null) return true;
    }
    return false;
}

/// Names that expand or split in the shell cannot be judged from the text.
pub fn dynamicName(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.argv0(cmd) orelse "";
    const glob = std.mem.findScalar(u8, name, '[') != null and !core.oneOf(name, &.{ "[", "[[" });
    const dynamic = glob or std.mem.findAny(u8, name, "$`{}*?") != null or
        std.mem.find(u8, name, "<stdin>") != null or std.mem.find(u8, name, "<(") != null;
    if (!dynamic) return null;
    return core.ask("exec.dynamic-command", try core.fmt(ctx, "cannot tell which command {s} runs", .{name}), .shell);
}

fn flagsBeforeOperand(a: std.mem.Allocator, args: []const []const u8) Error![]const []const u8 {
    var flags: std.ArrayList([]const u8) = .empty;
    errdefer flags.deinit(a);
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--") or !std.mem.startsWith(u8, arg, "-") or std.mem.eql(u8, arg, "-")) break;
        try flags.append(a, arg);
        if (core.oneOf(arg, &.{ "-W", "-X", "-Q" })) i += 1;
    }
    return flags.toOwnedSlice(a);
}

// TS: /^[gmn]?awk$/
fn isAwk(n: []const u8) bool {
    return std.mem.eql(u8, n, "awk") or (n.len == 4 and std.mem.endsWith(u8, n, "awk") and std.mem.findScalar(u8, "gmn", n[0]) != null);
}

pub fn inlineCode(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    const args = if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv;
    var inline_code = std.mem.eql(u8, name, "deno") and args.len > 0 and std.mem.eql(u8, args[0], "eval");
    if (isAwk(name)) for (args) |a| if (std.mem.find(u8, a, "system(") != null) {
        inline_code = true;
    };
    if (!inline_code) for (try flagsBeforeOperand(ctx.env.a, args)) |a| if (inlineFlag(name, a)) {
        inline_code = true;
    };
    if (!inline_code) return null;
    return core.ask("exec.inline-code", try core.fmt(ctx, "{s} runs code given on the command line", .{name}), .shell);
}

fn startsRedirectOperator(s: []const u8) bool {
    return s.len >= 2 and (s[0] == '<' or s[0] == '>') and s[1] == '(';
}

pub fn stdinScript(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    if (!isRunner(name)) return null;
    const args = if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv;
    var operand: ?[]const u8 = null;
    for (args) |a| if (!std.mem.startsWith(u8, a, "-") or std.mem.eql(u8, a, "-")) {
        operand = a;
        break;
    };
    const why = try core.fmt(ctx, "{s} would run a script it receives on stdin", .{name});
    if (operand) |o| if (isStdinPath(o) or startsRedirectOperator(o)) return core.ask("exec.stdin-script", why, .shell);
    var reads = cmd.from_pipe or cmd.here_string;
    for (cmd.redirects) |r| if (r.op == .in) {
        reads = true;
    };
    const dash = operand == null or std.mem.eql(u8, operand.?, "-") or core.contains(args, "-s");
    var marker = false;
    for (args) |a| if (std.mem.find(u8, a, "<stdin>") != null) {
        marker = true;
    };
    return if ((dash and reads) or marker) core.ask("exec.stdin-script", why, .shell) else null;
}

pub fn sourceOutside(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    if (!core.oneOf(name, &.{ "source", "." })) return null;
    const abs = try core.resolvePath(ctx, if (cmd.argv.len > 1) cmd.argv[1] else "", null);
    if (abs != null and core.isInside(ctx, abs.?)) return null;
    return core.ask("exec.source-outside", "sourcing a script from outside the task root", .shell);
}

pub fn escalate(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    if (!core.oneOf(name, &.{ "su", "parallel", "chroot", "nsenter", "unshare", "sandbox-exec" })) return null;
    return core.ask("exec.escalate", try core.fmt(ctx, "{s} runs other commands the guard cannot see", .{name}), .shell);
}
