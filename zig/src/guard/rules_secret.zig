//! Credential locations, environment dumps and tree sweeps. Port of guard/rules-secret.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const glob_re = @import("glob_re.zig");
const wrappers = @import("wrappers.zig");
const lexer = @import("lexer.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

// A word we cannot resolve but that still names a credential location is not safe to pass.
const secret_words = [_][]const u8{ ".ssh", ".aws", ".gnupg", ".netrc", ".config/gh", "Keychains", ".git-credentials" };
const sensitive_names = [_][]const u8{ "KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL" };

fn containsIgnoreCase(s: []const u8, needle: []const u8) bool {
    return std.ascii.findIgnoreCase(s, needle) != null;
}

fn anyIgnoreCase(s: []const u8, needles: []const []const u8) bool {
    for (needles) |n| if (containsIgnoreCase(s, n)) return true;
    return false;
}

/// Simple lowercase for the scripts a home directory name realistically uses. JS `toLowerCase`
/// has the full Unicode table; a character outside this one compares as itself.
fn lowerCp(cp: u21) [2]u21 {
    const one = struct {
        fn f(c: u21) [2]u21 {
            return .{ c, 0 };
        }
    }.f;
    return switch (cp) {
        'A'...'Z' => one(cp + 32),
        0xC0...0xD6, 0xD8...0xDE => one(cp + 32),
        0x130 => .{ 'i', 0x307 },
        0x100...0x12F, 0x132...0x137, 0x14A...0x177 => one(if (cp % 2 == 0) cp + 1 else cp),
        0x139...0x148, 0x179...0x17E => one(if (cp % 2 == 1) cp + 1 else cp),
        0x178 => one(0xFF),
        0x391...0x3A1, 0x3A3...0x3A9 => one(cp + 32),
        0x3C2 => one(0x3C3),
        0x400...0x40F => one(cp + 80),
        0x410...0x42F => one(cp + 32),
        0xFF21...0xFF3A => one(cp + 32),
        0x212A => one('k'),
        0x212B => one(0xE5),
        0x2126 => one(0x3C9),
        else => one(cp),
    };
}

const Lowered = struct {
    s: []const u8,
    i: usize = 0,
    queued: u21 = 0,

    fn next(self: *Lowered) ?u21 {
        if (self.queued != 0) {
            defer self.queued = 0;
            return self.queued;
        }
        if (self.i >= self.s.len) return null;
        const l = std.unicode.utf8ByteSequenceLength(self.s[self.i]) catch 1;
        const end = @min(self.i + l, self.s.len);
        const cp = std.unicode.utf8Decode(self.s[self.i..end]) catch self.s[self.i];
        self.i = end;
        const low = lowerCp(cp);
        self.queued = low[1];
        return low[0];
    }
};

fn lowerEq(a: []const u8, b: []const u8) bool {
    var x: Lowered = .{ .s = a };
    var y: Lowered = .{ .s = b };
    while (true) {
        const p = x.next();
        const q = y.next();
        if (p == null or q == null) return p == null and q == null;
        if (p.? != q.?) return false;
    }
}

// TS: GLOB = /[*?[]/; a glob segment may expand to the credential directory.
fn segmentMatches(ctx: Ctx, pattern: []const u8, literal: []const u8) Error!bool {
    if (std.mem.findAny(u8, pattern, "*?[") == null) return lowerEq(pattern, literal);
    if (std.mem.startsWith(u8, literal, ".") and !std.mem.startsWith(u8, pattern, ".")) return false;
    // A source JS rejects makes TS answer true.
    return (try glob_re.matches(ctx.env.a, pattern, literal)) orelse true;
}

fn underSecret(ctx: Ctx, abs: []const u8, secret: []const u8) Error!bool {
    var want = std.mem.splitScalar(u8, secret, '/');
    var got = std.mem.splitScalar(u8, abs, '/');
    if (std.mem.count(u8, abs, "/") < std.mem.count(u8, secret, "/")) return false;
    while (want.next()) |w| {
        // The count check above makes `got` at least as long as `want`; TS answers false for fewer.
        const g = got.next() orelse return false;
        if (!try segmentMatches(ctx, g, w)) return false;
    }
    return true;
}

fn stripped(a: std.mem.Allocator, raw: []const u8, list: *std.ArrayList([]const u8)) Error!void {
    try list.append(a, raw);
    // /^-{1,2}[\w-]*=/
    if (raw.len > 0 and raw[0] == '-') {
        var j: usize = 1;
        while (j < raw.len and (core.isWordChar(raw[j]) or raw[j] == '-')) j += 1;
        if (j < raw.len and raw[j] == '=') try list.append(a, raw[j + 1 ..]);
    }
    // /^-[A-Za-z](?=[@~/$])/
    if (raw.len > 2 and raw[0] == '-' and std.ascii.isAlphabetic(raw[1]) and std.mem.findScalar(u8, "@~/$", raw[2]) != null) {
        try list.append(a, raw[2..]);
    }
    // /^[\w.-]+=/
    var k: usize = 0;
    while (k < raw.len and (core.isWordChar(raw[k]) or raw[k] == '.' or raw[k] == '-')) k += 1;
    if (k > 0 and k < raw.len and raw[k] == '=') try list.append(a, raw[k + 1 ..]);
    // /^[^/\s:]+:/
    var m: usize = 0;
    while (m < raw.len and raw[m] != '/' and raw[m] != ':') {
        if (lexer.jsSpaceAt(raw, m) != 0) break;
        m += 1;
    }
    if (m > 0 and m < raw.len and raw[m] == ':') try list.append(a, raw[m + 1 ..]);
}

/// curl `-d @file`, `-d@file`, `--data=@file`, `-F name=@file` hide the path behind a prefix.
fn candidates(a: std.mem.Allocator, raw: []const u8) Error![]const []const u8 {
    var base_list: std.ArrayList([]const u8) = .empty;
    defer base_list.deinit(a);
    try stripped(a, raw, &base_list);
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(a);
    for (base_list.items) |c| {
        try out.append(a, c);
        try out.append(a, if (std.mem.startsWith(u8, c, "@")) c[1..] else c);
    }
    return out.toOwnedSlice(a);
}

// TS: /\/proc\/[^/]+\/environ$/
fn isProcEnviron(s: []const u8) bool {
    const tail = "/environ";
    if (!std.mem.endsWith(u8, s, tail)) return false;
    const head = s[0 .. s.len - tail.len];
    const slash = std.mem.findScalarLast(u8, head, '/') orelse return false;
    return slash + 1 < head.len and std.mem.endsWith(u8, head[0..slash], "/proc");
}

fn isSecretCandidate(ctx: Ctx, candidate: []const u8) Error!bool {
    if (isProcEnviron(candidate)) return true;
    const abs = (try core.resolvePath(ctx, candidate, null)) orelse {
        for (secret_words) |w| if (containsIgnoreCase(candidate, w)) return true;
        return false;
    };
    for (ctx.env.secrets) |secret| if (try underSecret(ctx, abs, secret)) return true;
    return core.startsWithIgnoreCase(core.basename(abs), ".env") and !core.isInside(ctx, abs);
}

/// Allocation contract: everything allocated here (the candidate list, resolved paths) comes from
/// `ctx.env.a`, which is an arena owned by the caller and freed as a whole, so nothing is freed here.
pub fn isSecretPath(ctx: Ctx, raw: []const u8) Error!bool {
    for (try candidates(ctx.env.a, raw)) |c| if (try isSecretCandidate(ctx, c)) return true;
    return false;
}

fn dumpsEnvironment(name: []const u8, args: []const []const u8) bool {
    var flags_only = true;
    for (args) |a| if (!(wrappers.isAssign(a) or std.mem.startsWith(u8, a, "-"))) {
        flags_only = false;
    };
    if (core.oneOf(name, &.{ "env", "printenv" })) return flags_only;
    if (std.mem.eql(u8, name, "set")) return args.len == 0;
    if (!core.oneOf(name, &.{ "export", "declare", "typeset" })) return false;
    for (args) |a| if (!std.mem.startsWith(u8, a, "-")) return false;
    return true;
}

// TS: /^(find-.*password|dump-keychain)$/
fn keychainRead(a: []const u8) bool {
    if (std.mem.eql(u8, a, "dump-keychain")) return true;
    const head = "find-";
    const tail = "password";
    if (a.len < head.len + tail.len or !std.mem.startsWith(u8, a, head) or !std.mem.endsWith(u8, a, tail)) return false;
    return !core.hasLineTerminator(a[head.len .. a.len - tail.len]);
}

pub fn secrets(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    const args = if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv;
    if (dumpsEnvironment(name, args)) return core.deny("secret.env-dump", "dumps the whole environment", .secret);
    if (std.mem.eql(u8, name, "printenv")) {
        for (args) |a| if (anyIgnoreCase(a, &sensitive_names)) return core.deny("secret.env-var", "reads a credential variable", .secret);
    }
    if (std.mem.eql(u8, name, "security")) {
        for (args) |a| if (keychainRead(a)) return core.deny("secret.keychain", "reads the keychain", .secret);
    }
    for ([_][]const []const u8{ args, cmd.assigns }) |words| {
        if (try firstSecret(ctx, words)) |hit| return try secretPathDeny(ctx, hit);
    }
    for (cmd.redirects) |r| if (try isSecretPath(ctx, r.path)) return try secretPathDeny(ctx, r.path);
    return null;
}

fn firstSecret(ctx: Ctx, words: []const []const u8) Error!?[]const u8 {
    for (words) |w| if (try isSecretPath(ctx, w)) return w;
    return null;
}

pub fn secretPathDeny(ctx: Ctx, path: []const u8) Error!Result {
    return core.deny("secret.path", try core.fmt(ctx, "{s} is a credential location", .{path}), .secret);
}

fn isExfil(s: []const u8) bool {
    return core.oneOf(s, &.{ "curl", "wget", "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp" });
}

fn isSearcher(name: []const u8) bool {
    return core.oneOf(name, &.{ "grep", "egrep", "fgrep", "rg", "ag", "ack" });
}

fn lettersHaveC(s: []const u8) bool {
    for (s) |c| {
        if (!std.ascii.isAlphabetic(c)) return false;
        if (c == 'c') return true;
    }
    return false;
}

fn recursiveRead(name: []const u8, cmd: *const Cmd, o: core.Opts) bool {
    if (core.oneOf(name, &.{ "grep", "egrep", "fgrep" })) return o.anyShort("rR") or o.hasLong("recursive");
    if (std.mem.eql(u8, name, "cp")) return o.anyShort("rRa") or o.hasLong("recursive");
    if (std.mem.eql(u8, name, "tar")) return o.hasShort('c') or lettersHaveC(if (cmd.argv.len > 1) cmd.argv[1] else "");
    if (std.mem.eql(u8, name, "find")) {
        for (cmd.argv) |a| if (core.oneOf(a, &.{ "-exec", "-execdir", "-ok", "-okdir" })) return true;
        return cmd.piped;
    }
    return core.oneOf(name, &.{ "rg", "ag", "ack", "zip", "ditto", "rsync", "scp" });
}

fn coversSecret(ctx: Ctx, abs: []const u8) Error!bool {
    const prefix = if (std.mem.eql(u8, abs, "/")) "/" else try core.fmt(ctx, "{s}/", .{abs});
    for (ctx.env.secrets) |s| if (std.mem.eql(u8, s, abs) or std.mem.startsWith(u8, s, prefix)) return true;
    return false;
}

/// Walking a tree that contains credentials reads them even though no secret path is named.
pub fn sweep(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    const o = try core.parseOpts(ctx.env.a, if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv);
    if (!recursiveRead(name, cmd, o)) return null;
    const dot: []const []const u8 = &.{"."};
    const targets = if (isSearcher(name) and o.rest.len <= 1) try std.mem.concat(ctx.env.a, []const u8, &.{ o.rest, dot }) else o.rest;
    var hit = false;
    for (targets) |t| {
        const abs = (try core.resolvePath(ctx, t, null)) orelse continue;
        if (try coversSecret(ctx, abs)) hit = true;
    }
    if (!hit) return null;
    var leaves = false;
    if (cmd.piped) for (cmd.after) |c| if (isExfil(core.name0(c))) {
        leaves = true;
    };
    for (cmd.argv) |a| if (isExfil(a)) {
        leaves = true;
    };
    if (leaves) return core.deny("secret.sweep-exfil", "a tree holding credentials is read and sent out", .secret);
    return core.ask("secret.sweep", "reads a directory tree that holds credentials", .secret);
}
