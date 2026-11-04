//! Shared types and path helpers for the L1 rules, a port of guard/rules-core.ts. Everything a rule
//! allocates (resolved paths, reason strings) comes from `Env.a`, an arena the caller owns.
const std = @import("std");
const Allocator = std.mem.Allocator;
const shell = @import("shell.zig");

pub const Cmd = shell.Cmd;
pub const base = shell.base;
pub const Error = Allocator.Error;

pub const Verdict = enum { allow, ask, deny };
pub const Category = enum { read, edit, shell, network, delete, git_push, secret, other };

pub const Result = struct {
    verdict: Verdict,
    rule: ?[]const u8,
    reason: []const u8,
    category: Category,
};

pub fn deny(rule: []const u8, reason: []const u8, category: Category) Result {
    return .{ .verdict = .deny, .rule = rule, .reason = reason, .category = category };
}

pub fn ask(rule: []const u8, reason: []const u8, category: Category) Result {
    return .{ .verdict = .ask, .rule = rule, .reason = reason, .category = category };
}

pub fn allow(rule: ?[]const u8, reason: []const u8, category: Category) Result {
    return .{ .verdict = .allow, .rule = rule, .reason = reason, .category = category };
}

pub const Scope = struct {
    root: []const u8,
    home: []const u8,
    /// HARNESS_HOME when it is not ~/.harness; its secrets.json is a credential location too.
    harness_home: ?[]const u8 = null,
    default_branch: []const u8,
};

/// The working directory as the line runs: `.root` is TS `undefined`, `.unknown` is `null`.
pub const Cwd = union(enum) { root, unknown, dir: []const u8 };

const secret_paths = [_][]const u8{
    ".ssh",              ".aws",                      ".config/gh",       ".gnupg",                ".netrc",
    "Library/Keychains", ".docker/config.json",       ".kube",            ".git-credentials",      ".npmrc",
    ".config/gcloud",    ".claude/.credentials.json", ".codex/auth.json", ".harness/secrets.json",
};

pub const Env = struct {
    /// An arena owned by the caller. Rules allocate freely from it and never free; the caller frees
    /// the whole arena after it has copied out the result.
    a: Allocator,
    io: std.Io,
    scope: Scope,
    /// `resolve(scope.root)`.
    root: []const u8,
    /// The credential locations of `secretLocations(scope)`.
    secrets: []const []const u8,

    /// A relative root or home would be resolved against the process directory in TS; the port
    /// refuses them instead, so the caller denies.
    pub fn init(a: Allocator, io: std.Io, scope: Scope) (Error || error{RelativeScope})!Env {
        if (!isAbs(scope.root) or !isAbs(scope.home)) return error.RelativeScope;
        if (scope.harness_home) |h| if (!isAbs(h)) return error.RelativeScope;
        const home = try resolve(a, "/", scope.home);
        const n = secret_paths.len + @intFromBool(scope.harness_home != null);
        const locs = try a.alloc([]const u8, n);
        for (secret_paths, 0..) |p, i| locs[i] = try resolve(a, home, p);
        if (scope.harness_home) |h| locs[n - 1] = try resolve(a, try resolve(a, "/", h), "secrets.json");
        return .{ .a = a, .io = io, .scope = scope, .root = try resolve(a, "/", scope.root), .secrets = locs };
    }
};

pub const Ctx = struct {
    env: *const Env,
    cwd: Cwd = .root,

    pub fn withCwd(self: Ctx, cwd: Cwd) Ctx {
        return .{ .env = self.env, .cwd = cwd };
    }
};

pub fn isAbs(p: []const u8) bool {
    return p.len > 0 and p[0] == '/';
}

/// `path.resolve(dir, p)` on posix for an absolute `dir`: segments are normalised and `..` stops at
/// the root.
pub fn resolve(a: Allocator, dir: []const u8, p: []const u8) Error![]const u8 {
    var segs: std.ArrayList([]const u8) = .empty;
    defer segs.deinit(a);
    if (!isAbs(p)) try pushSegments(a, &segs, dir);
    try pushSegments(a, &segs, p);
    var len: usize = 0;
    for (segs.items) |s| len += s.len + 1;
    if (len == 0) return "/";
    const out = try a.alloc(u8, len);
    var at: usize = 0;
    for (segs.items) |s| {
        out[at] = '/';
        @memcpy(out[at + 1 ..][0..s.len], s);
        at += s.len + 1;
    }
    return out;
}

fn pushSegments(a: Allocator, segs: *std.ArrayList([]const u8), p: []const u8) Error!void {
    var it = std.mem.splitScalar(u8, p, '/');
    while (it.next()) |s| {
        if (s.len == 0 or std.mem.eql(u8, s, ".")) continue;
        if (std.mem.eql(u8, s, "..")) {
            _ = segs.pop();
        } else try segs.append(a, s);
    }
}

pub fn basename(p: []const u8) []const u8 {
    var end = p.len;
    while (end > 0 and p[end - 1] == '/') end -= 1;
    const head = p[0..end];
    return if (std.mem.findScalarLast(u8, head, '/')) |i| head[i + 1 ..] else head;
}

// TS: HOME_PREFIX = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/, applied once.
fn expandHome(a: Allocator, raw: []const u8, home: []const u8) Error![]const u8 {
    const prefixes = [_][]const u8{ "~", "$HOME", "${HOME}" };
    for (prefixes) |p| {
        if (!std.mem.startsWith(u8, raw, p)) continue;
        const rest = raw[p.len..];
        if (rest.len == 0 or rest[0] == '/') return std.mem.concat(a, u8, &.{ home, rest });
    }
    return raw;
}

// TS: UNKNOWN_WORD = /[$`]|^<\(|<stdin>|^~[^/]|\{[^}]*(,|\.\.)[^}]*\}/
fn unknownWord(s: []const u8) bool {
    if (std.mem.findAny(u8, s, "$`") != null) return true;
    if (std.mem.startsWith(u8, s, "<(") or std.mem.find(u8, s, "<stdin>") != null) return true;
    if (s.len >= 2 and s[0] == '~' and s[1] != '/') return true;
    // Per run of text between closing braces only the first `{` can win: it sees the longest span.
    var from: usize = 0;
    while (std.mem.findScalarPos(u8, s, from, '}')) |close| {
        const chunk = s[from..close];
        if (std.mem.findScalar(u8, chunk, '{')) |open| {
            const span = chunk[open + 1 ..];
            if (std.mem.findScalar(u8, span, ',') != null or std.mem.find(u8, span, "..") != null) return true;
        }
        from = close + 1;
    }
    return false;
}

/// Null means the path depends on something we cannot evaluate statically ($VAR, ~user, brace
/// expansion, substitution, xargs stdin, or a relative path after a cd to an unknown place).
pub fn resolvePath(ctx: Ctx, raw: []const u8, dir_override: ?[]const u8) Error!?[]const u8 {
    const a = ctx.env.a;
    const expanded = try expandHome(a, raw, ctx.env.scope.home);
    if (unknownWord(expanded)) return null;
    if (isAbs(expanded)) return try resolve(a, "/", expanded);
    const dir: []const u8 = dir_override orelse switch (ctx.cwd) {
        .root => ctx.env.scope.root,
        .unknown => return null,
        .dir => |d| d,
    };
    return try resolve(a, try resolve(a, "/", dir), expanded);
}

pub fn isInsideRoot(abs: []const u8, root: []const u8) bool {
    if (std.mem.eql(u8, abs, root)) return true;
    if (std.mem.eql(u8, root, "/")) return abs.len > 0 and abs[0] == '/';
    return abs.len > root.len and std.mem.startsWith(u8, abs, root) and abs[root.len] == '/';
}

pub fn isInside(ctx: Ctx, abs: []const u8) bool {
    return isInsideRoot(abs, ctx.env.root);
}

// TS: GIT_INTERNALS = /(^|\/)\.git(\/(hooks|config)(\/|$)|$)/
pub fn isGitInternals(s: []const u8) bool {
    var from: usize = 0;
    while (std.mem.find(u8, s[from..], ".git")) |rel| {
        const at = from + rel;
        from = at + 1;
        if (at != 0 and s[at - 1] != '/') continue;
        const rest = s[at + 4 ..];
        if (rest.len == 0) return true;
        if (rest[0] != '/') continue;
        for ([_][]const u8{ "hooks", "config" }) |name| {
            if (!std.mem.startsWith(u8, rest[1..], name)) continue;
            const tail = rest[1 + name.len ..];
            if (tail.len == 0 or tail[0] == '/') return true;
        }
    }
    return false;
}

pub const Opts = struct {
    /// ASCII flag letters; a non-ASCII letter never equals one the rules look for.
    short: u128 = 0,
    long: []const []const u8 = &.{},
    rest: []const []const u8 = &.{},

    pub fn hasShort(self: Opts, c: u8) bool {
        return c < 128 and (self.short >> @intCast(c)) & 1 == 1;
    }

    pub fn hasLong(self: Opts, name: []const u8) bool {
        for (self.long) |l| if (std.mem.eql(u8, l, name)) return true;
        return false;
    }

    pub fn anyShort(self: Opts, comptime letters: []const u8) bool {
        inline for (letters) |c| if (self.hasShort(c)) return true;
        return false;
    }
};

pub fn parseOpts(a: Allocator, args: []const []const u8) Error!Opts {
    var o: Opts = .{};
    var long: std.ArrayList([]const u8) = .empty;
    var rest: std.ArrayList([]const u8) = .empty;
    errdefer long.deinit(a);
    errdefer rest.deinit(a);
    for (args, 0..) |arg, i| {
        if (std.mem.eql(u8, arg, "--")) {
            try rest.appendSlice(a, args[i + 1 ..]);
            break;
        }
        if (std.mem.startsWith(u8, arg, "--")) {
            const name = arg[2..];
            try long.append(a, name[0 .. std.mem.findScalar(u8, name, '=') orelse name.len]);
        } else if (arg.len > 1 and arg[0] == '-') {
            for (arg[1..]) |c| if (c < 128) {
                o.short |= @as(u128, 1) << @intCast(c);
            };
        } else try rest.append(a, arg);
    }
    o.long = try long.toOwnedSlice(a);
    o.rest = try rest.toOwnedSlice(a);
    return o;
}

pub fn argv0(cmd: *const Cmd) ?[]const u8 {
    return if (cmd.argv.len > 0) cmd.argv[0] else null;
}

pub fn name0(cmd: *const Cmd) []const u8 {
    return base(argv0(cmd));
}

pub fn oneOf(s: []const u8, comptime names: []const []const u8) bool {
    inline for (names) |n| if (std.mem.eql(u8, s, n)) return true;
    return false;
}

pub fn contains(list: []const []const u8, s: []const u8) bool {
    for (list) |x| if (std.mem.eql(u8, x, s)) return true;
    return false;
}

pub fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

/// Length of the leading `\w*` run.
pub fn wordRun(s: []const u8) usize {
    var i: usize = 0;
    while (i < s.len and isWordChar(s[i])) i += 1;
    return i;
}

/// JS `.` refuses these four code points.
pub fn hasLineTerminator(s: []const u8) bool {
    return std.mem.findAny(u8, s, "\n\r") != null or std.mem.find(u8, s, "\u{2028}") != null or
        std.mem.find(u8, s, "\u{2029}") != null;
}

pub fn startsWithIgnoreCase(s: []const u8, prefix: []const u8) bool {
    return s.len >= prefix.len and std.ascii.eqlIgnoreCase(s[0..prefix.len], prefix);
}

pub fn fmt(ctx: Ctx, comptime f: []const u8, args: anytype) Error![]const u8 {
    return std.fmt.allocPrint(ctx.env.a, f, args);
}

/// `realpathSync`: the real path of an absolute path, or null when it cannot be resolved.
pub fn realpath(ctx: Ctx, abs: []const u8) Error!?[]const u8 {
    if (!isAbs(abs) or std.mem.findScalar(u8, abs, 0) != null) return null;
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const n = std.Io.Dir.realPathFileAbsolute(ctx.env.io, abs, &buf) catch return null;
    return try ctx.env.a.dupe(u8, buf[0..n]);
}
