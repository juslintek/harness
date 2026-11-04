//! Wrapper commands the guard peels off (sudo, env, timeout, xargs, npx ...), a port of
//! guard/wrappers.ts. The wrapped command is judged as if typed directly.
const std = @import("std");
const lexer = @import("lexer.zig");
const Ctx = lexer.Ctx;
const Error = lexer.Error;

const Wrapper = struct {
    name: []const u8,
    arg_opts: []const []const u8 = &.{},
    skip: usize = 0,
    assigns: bool = false,
};

const pkg_call: []const []const u8 = &.{ "-p", "--package", "-c", "--call" };

const wrappers = [_]Wrapper{
    .{ .name = "sudo", .arg_opts = &.{ "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t" }, .assigns = true },
    .{ .name = "doas", .arg_opts = &.{ "-u", "-C" } },
    .{ .name = "env", .arg_opts = &.{ "-u", "-C", "-S" }, .assigns = true },
    .{ .name = "nice", .arg_opts = &.{"-n"} },
    .{ .name = "timeout", .arg_opts = &.{ "-s", "-k" }, .skip = 1 },
    .{ .name = "xargs", .arg_opts = &.{ "-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a" } },
    .{ .name = "exec", .arg_opts = &.{"-a"} },
    .{ .name = "caffeinate", .arg_opts = &.{ "-t", "-w" } },
    .{ .name = "stdbuf", .arg_opts = &.{ "-i", "-o", "-e" } },
    .{ .name = "flock", .arg_opts = &.{ "-w", "-E" }, .skip = 1 },
    .{ .name = "ionice", .arg_opts = &.{ "-c", "-n", "-p" } },
    .{ .name = "taskset", .arg_opts = &.{"-c"}, .skip = 1 },
    .{ .name = "chrt", .skip = 1 },
    .{ .name = "arch" },
    .{ .name = "command" },
    .{ .name = "nohup" },
    .{ .name = "time" },
    .{ .name = "builtin" },
    .{ .name = "setsid" },
    .{ .name = "busybox" },
    .{ .name = "npm x", .arg_opts = pkg_call },
    .{ .name = "pnpm exec", .arg_opts = &.{"-c"} },
    .{ .name = "yarn exec" },
    .{ .name = "npm exec", .arg_opts = pkg_call },
    .{ .name = "pnpm dlx", .arg_opts = &.{ "-p", "--package" } },
    .{ .name = "yarn dlx", .arg_opts = &.{ "-p", "--package" } },
    .{ .name = "bun x" },
    .{ .name = "uv run", .arg_opts = &.{ "--with", "--python", "-p", "--extra", "--group" } },
    .{ .name = "pipx run", .arg_opts = &.{ "--spec", "--python" } },
    .{ .name = "poetry run" },
    .{ .name = "npx", .arg_opts = pkg_call },
    .{ .name = "bunx" },
    .{ .name = "uvx", .arg_opts = &.{ "--with", "--from", "--python", "-p" } },
    .{ .name = "script", .skip = 1 },
};

fn lookup(name: []const u8) ?*const Wrapper {
    for (&wrappers) |*w| if (std.mem.eql(u8, w.name, name)) return w;
    return null;
}

const shells = std.StaticStringMap(void).initComptime(.{
    .{"sh"}, .{"bash"}, .{"zsh"}, .{"dash"}, .{"ksh"}, .{"fish"},
});

// `npm exec` and friends are two words; `name` is the table key they map to.
const compound = [_]struct { first: []const u8, second: []const u8, name: []const u8 }{
    .{ .first = "npm", .second = "exec", .name = "npm exec" },
    .{ .first = "npm", .second = "x", .name = "npm x" },
    .{ .first = "pnpm", .second = "exec", .name = "pnpm exec" },
    .{ .first = "yarn", .second = "exec", .name = "yarn exec" },
    .{ .first = "pnpm", .second = "dlx", .name = "pnpm dlx" },
    .{ .first = "yarn", .second = "dlx", .name = "yarn dlx" },
    .{ .first = "bun", .second = "x", .name = "bun x" },
    .{ .first = "uv", .second = "run", .name = "uv run" },
    .{ .first = "pipx", .second = "run", .name = "pipx run" },
    .{ .first = "poetry", .second = "run", .name = "poetry run" },
};

// `pnpm rimraf ~` and `yarn rimraf ~` run a local bin when the word is not a package-manager subcommand.
const pm_subcommands = std.StaticStringMap(void).initComptime(.{
    .{"install"}, .{"i"},        .{"add"},    .{"remove"},  .{"rm"},        .{"uninstall"},  .{"update"},
    .{"up"},      .{"upgrade"},  .{"run"},    .{"test"},    .{"t"},         .{"start"},      .{"build"},
    .{"init"},    .{"publish"},  .{"pack"},   .{"link"},    .{"unlink"},    .{"list"},       .{"ls"},
    .{"why"},     .{"outdated"}, .{"audit"},  .{"store"},   .{"config"},    .{"prune"},      .{"rebuild"},
    .{"import"},  .{"fetch"},    .{"patch"},  .{"deploy"},  .{"create"},    .{"env"},        .{"dlx"},
    .{"exec"},    .{"cache"},    .{"info"},   .{"version"}, .{"workspace"}, .{"workspaces"}, .{"global"},
    .{"login"},   .{"logout"},   .{"whoami"}, .{"help"},    .{"dedupe"},    .{"licenses"},   .{"ci"},
    .{"set"},     .{"bin"},      .{"root"},   .{"check"},   .{"lint"},
});

pub fn base(word: ?[]const u8) []const u8 {
    const w = word orelse return "";
    return if (std.mem.findScalarLast(u8, w, '/')) |i| w[i + 1 ..] else w;
}

pub fn isAssign(a: []const u8) bool {
    if (a.len == 0 or !(std.ascii.isAlphabetic(a[0]) or a[0] == '_')) return false;
    for (a[1..]) |c| {
        if (c == '=') return true;
        if (!(std.ascii.isAlphanumeric(c) or c == '_')) return false;
    }
    return false;
}

// TS: /^-[a-zA-Z]*c[a-zA-Z]*$/
fn isCommandFlag(a: []const u8) bool {
    if (a.len < 2 or a[0] != '-') return false;
    var has_c = false;
    for (a[1..]) |c| {
        if (!std.ascii.isAlphabetic(c)) return false;
        if (c == 'c') has_c = true;
    }
    return has_c;
}

// Values of the options the later steps read, keyed by option spelling.
const Vals = struct {
    dash_c: ?[]const u8 = null,
    call: ?[]const u8 = null,
    s_upper: ?[]const u8 = null,
    i_upper: ?[]const u8 = null,
    c_upper: ?[]const u8 = null,
    d_upper: ?[]const u8 = null,

    fn set(v: *Vals, opt: []const u8, value: []const u8) void {
        const e = std.meta.stringToEnum(enum { @"-c", @"--call", @"-S", @"-I", @"-C", @"-D" }, opt) orelse return;
        switch (e) {
            .@"-c" => v.dash_c = value,
            .@"--call" => v.call = value,
            .@"-S" => v.s_upper = value,
            .@"-I" => v.i_upper = value,
            .@"-C" => v.c_upper = value,
            .@"-D" => v.d_upper = value,
        }
    }
};

fn tail(argv: []const []const u8, from: usize) []const []const u8 {
    return argv[@min(from, argv.len)..];
}

// Value-taking option, either `-n 5` or attached `-n5`; returns the index of the last token consumed.
fn takeOption(argv: []const []const u8, i: usize, spec: *const Wrapper, vals: *Vals) usize {
    const a = argv[i];
    const opt = for (spec.arg_opts) |o| {
        if (std.mem.startsWith(u8, a, o)) break o;
    } else return i;
    if (a.len > opt.len) {
        vals.set(opt, a[opt.len..]);
        return i;
    }
    vals.set(opt, if (i + 1 < argv.len) argv[i + 1] else "");
    return i + 1;
}

const Scan = struct { next: usize, assigns: []const []const u8, vals: Vals };

fn scanOptions(ctx: *Ctx, argv: []const []const u8, spec: *const Wrapper, from: usize) Error!Scan {
    var assigns: std.ArrayList([]const u8) = .empty;
    defer assigns.deinit(ctx.scratch);
    var vals: Vals = .{};
    var i = from;
    while (i < argv.len) : (i += 1) {
        const a = argv[i];
        if (std.mem.eql(u8, a, "--")) {
            i += 1;
            break;
        }
        if (spec.assigns and isAssign(a)) {
            try assigns.append(ctx.scratch, a);
        } else if (!std.mem.startsWith(u8, a, "-") or a.len == 1) {
            break;
        } else i = takeOption(argv, i, spec, &vals);
    }
    return .{ .next = i, .assigns = try ctx.arena.dupe([]const u8, assigns.items), .vals = vals };
}

// xargs appends stdin to the command; model it as an unresolvable path so rules treat it as unknown.
fn markStdin(ctx: *Ctx, rest: []const []const u8, replstr: ?[]const u8) Error![]const []const u8 {
    const stdin_mark = "<stdin>";
    const r = replstr orelse "";
    if (r.len > 0) {
        const replaced = try ctx.arena.alloc([]const u8, rest.len);
        var changed = false;
        for (rest, replaced) |w, *dst| {
            const n = std.mem.replacementSize(u8, w, r, stdin_mark);
            const buf = try ctx.arena.alloc(u8, n);
            _ = std.mem.replace(u8, w, r, stdin_mark, buf);
            dst.* = buf;
            if (!std.mem.eql(u8, w, buf)) changed = true;
        }
        if (changed) return replaced;
    }
    const out = try ctx.arena.alloc([]const u8, rest.len + 1);
    @memcpy(out[0..rest.len], rest);
    out[rest.len] = stdin_mark;
    return out;
}

fn rejectChdir(ctx: *Ctx, name: []const u8, opts: []const []const u8, vals: Vals) Error!void {
    const flag_set = if (std.mem.eql(u8, name, "env")) vals.c_upper != null else if (std.mem.eql(u8, name, "sudo")) vals.d_upper != null else false;
    var long_form = false;
    for (opts) |a| {
        if (!std.mem.startsWith(u8, a, "--")) continue;
        const r = a[2..];
        if (std.mem.startsWith(u8, r, "chdir") or std.mem.startsWith(u8, r, "directory") or std.mem.startsWith(u8, r, "cwd")) long_form = true;
    }
    if (flag_set or long_form) return ctx.failChdir(name);
}

const Key = struct { name: []const u8, from: usize };

// Wrapper table key and the index where its options start (`npm exec` skips two words).
fn wrapperKey(argv: []const []const u8) Key {
    const plain = base(if (argv.len > 0) argv[0] else null);
    const sub = if (argv.len > 1) argv[1] else "";
    for (compound) |c| {
        if (std.mem.eql(u8, c.first, plain) and std.mem.eql(u8, c.second, sub)) return .{ .name = c.name, .from = 2 };
    }
    const pm = std.mem.eql(u8, plain, "pnpm") or std.mem.eql(u8, plain, "yarn");
    const bin = pm and sub.len > 0 and sub[0] != '-';
    if (bin and !pm_subcommands.has(sub)) {
        return .{ .name = if (std.mem.eql(u8, plain, "pnpm")) "pnpm exec" else "yarn exec", .from = 1 };
    }
    return .{ .name = plain, .from = 1 };
}

fn isOneOf(name: []const u8, comptime names: []const []const u8) bool {
    inline for (names) |n| if (std.mem.eql(u8, name, n)) return true;
    return false;
}

fn finishRest(ctx: *Ctx, name: []const u8, rest: []const []const u8, vals: Vals) Error![]const []const u8 {
    if (vals.dash_c orelse vals.call) |call| {
        if (isOneOf(name, &.{ "npx", "npm x", "npm exec", "pnpm exec" })) {
            return ctx.arena.dupe([]const u8, &.{ "sh", "-c", call });
        }
    }
    if (std.mem.eql(u8, name, "env")) {
        if (vals.s_upper) |s| if (s.len > 0) return splitS(ctx, s, rest);
    }
    return if (std.mem.eql(u8, name, "xargs")) markStdin(ctx, rest, vals.i_upper) else rest;
}

// TS: [...vals["-S"].split(/\s+/).filter(Boolean), ...rest]
fn splitS(ctx: *Ctx, s: []const u8, rest: []const []const u8) Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    defer out.deinit(ctx.scratch);
    var start: usize = 0;
    var i: usize = 0;
    while (i <= s.len) {
        const sp = if (i < s.len) lexer.jsSpaceAt(s, i) else 1;
        if (sp == 0) {
            i += 1;
            continue;
        }
        if (i > start) try out.append(ctx.scratch, s[start..i]);
        i += sp;
        start = i;
    }
    try out.appendSlice(ctx.scratch, rest);
    return ctx.arena.dupe([]const u8, out.items);
}

pub const Unwrapped = struct { rest: []const []const u8, assigns: []const []const u8, name: []const u8 };

pub fn unwrap(ctx: *Ctx, argv: []const []const u8) Error!?Unwrapped {
    const key = wrapperKey(argv);
    const name = key.name;
    const spec = lookup(name) orelse return null;
    if (std.mem.eql(u8, name, "command") and argv.len > 1 and
        (std.mem.eql(u8, argv[1], "-v") or std.mem.eql(u8, argv[1], "-V"))) return null;
    if (std.mem.eql(u8, name, "script") or std.mem.eql(u8, name, "flock")) {
        for (argv) |a| if (isCommandFlag(a)) return null;
    }
    const scan = try scanOptions(ctx, argv, spec, key.from);
    try rejectChdir(ctx, name, argv[0..@min(scan.next, argv.len)], scan.vals);
    const rest = try finishRest(ctx, name, tail(argv, scan.next + spec.skip), scan.vals);
    if (rest.len == 0) return null;
    return .{ .rest = rest, .assigns = scan.assigns, .name = name };
}

pub fn runsScript(name: []const u8) bool {
    return shells.has(name) or isOneOf(name, &.{ "eval", "su", "script", "flock" });
}

fn dashC(argv: []const []const u8) ?[]const u8 {
    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        const a = argv[i];
        if (std.mem.eql(u8, a, "-o") or std.mem.eql(u8, a, "-O")) {
            i += 1;
        } else if (isCommandFlag(a)) {
            return if (i + 1 < argv.len) argv[i + 1] else null;
        } else if (!std.mem.startsWith(u8, a, "-") and !std.mem.startsWith(u8, a, "+")) return null;
    }
    return null;
}

/// The script text a shell-like command runs, or null when it runs none.
pub fn shellScript(ctx: *Ctx, name: []const u8, argv: []const []const u8) Error!?[]const u8 {
    if (std.mem.eql(u8, name, "eval")) return try std.mem.join(ctx.arena, " ", tail(argv, 1));
    if (!isOneOf(name, &.{ "su", "script", "flock" })) return dashC(argv);
    for (argv, 0..) |a, i| {
        if (isCommandFlag(a) or std.mem.eql(u8, a, "--command")) return if (i + 1 < argv.len) argv[i + 1] else null;
    }
    return null;
}

test {
    _ = @import("wrappers_test.zig");
}
