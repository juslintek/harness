//! Statement parser and normalizer for the guard, a port of guard/shell.ts. It turns a command line
//! into a flat list of commands (pipelines linked through `after`, child shells bracketed by marks)
//! that the rules judge one by one.
const std = @import("std");
const Allocator = std.mem.Allocator;
const lexer = @import("lexer.zig");
const braces = @import("braces.zig");
const launchers = @import("launchers.zig");
const wrappers = @import("wrappers.zig");
const Ctx = lexer.Ctx;
const Error = lexer.Error;

pub const base = wrappers.base;

pub const Redirect = struct {
    op: enum { out, in },
    path: []const u8,
};

pub const Mark = enum { open, close };

pub const Cmd = struct {
    argv: []const []const u8 = &.{},
    assigns: []const []const u8 = &.{},
    wrappers: []const []const u8 = &.{},
    piped: bool = false,
    from_pipe: bool = false,
    here_string: bool = false,
    redirects: []const Redirect = &.{},
    download_exec: bool = false,
    /// The first command of every later stage of the same pipeline (a view into one shared array).
    after: []const *const Cmd = &.{},
    mark: ?Mark = null,
};

const Stmt = struct {
    words: []const []const u8 = &.{},
    redirects: []const Redirect = &.{},
    here_string: bool = false,
    piped: bool = false,
};

const Pending = enum { out, in, here };

const max_depth = 6;
const max_length = 100_000;
const reserved = std.StaticStringMap(void).initComptime(.{
    .{"if"}, .{"then"}, .{"else"}, .{"elif"}, .{"fi"}, .{"do"}, .{"done"}, .{"while"}, .{"until"}, .{"!"}, .{"{"}, .{"}"},
});

fn newCmd(ctx: *Ctx, init: Cmd) Allocator.Error!*Cmd {
    const c = try ctx.arena.create(Cmd);
    c.* = init;
    return c;
}

fn newMark(ctx: *Ctx, m: Mark) Allocator.Error!*Cmd {
    return newCmd(ctx, .{ .mark = m });
}

// `{}` is replaced by each start path so `find / -exec rm -rf {} \;` is judged as `rm -rf /`.
fn expandExec(ctx: *Ctx, out: *std.ArrayList(*Cmd), body: []const []const u8, starts: []const []const u8, depth: u32) Error!void {
    var has_placeholder = false;
    for (body) |w| {
        if (std.mem.find(u8, w, "{}") != null) has_placeholder = true;
    }
    const targets: []const []const u8 = if (has_placeholder) starts else &.{""};
    for (targets) |s| {
        try ctx.chargeWords(body);
        const words = try ctx.arena.alloc([]const u8, body.len);
        for (body, words) |w, *dst| dst.* = try replaceAll(ctx.arena, w, "{}", s);
        try out.appendSlice(ctx.scratch, try resolve(ctx, .{ .words = words }, depth));
    }
}

fn replaceAll(a: Allocator, s: []const u8, needle: []const u8, with: []const u8) Allocator.Error![]const u8 {
    const buf = try a.alloc(u8, std.mem.replacementSize(u8, s, needle, with));
    _ = std.mem.replace(u8, s, needle, with, buf);
    return buf;
}

const FindStarts = struct { starts: []const []const u8, from: usize };

fn findStarts(ctx: *Ctx, argv: []const []const u8) Error!FindStarts {
    var i: usize = 1;
    while (i < argv.len and (std.mem.eql(u8, argv[i], "-H") or std.mem.eql(u8, argv[i], "-L") or std.mem.eql(u8, argv[i], "-P"))) i += 1;
    const first = @min(i, argv.len);
    while (i < argv.len and !startsFilter(argv[i])) i += 1;
    if (i == first) return .{ .starts = try ctx.arena.dupe([]const u8, &.{"."}), .from = i };
    return .{ .starts = argv[first..i], .from = i };
}

// TS: /^(-|\(|!|\))/
fn startsFilter(a: []const u8) bool {
    return a.len > 0 and (a[0] == '-' or a[0] == '(' or a[0] == '!' or a[0] == ')');
}

fn findExtras(ctx: *Ctx, out: *std.ArrayList(*Cmd), argv: []const []const u8, depth: u32) Error!void {
    const fs = try findStarts(ctx, argv);
    var i = fs.from;
    while (i < argv.len) : (i += 1) {
        const a = argv[i];
        if (std.mem.eql(u8, a, "-delete")) {
            try ctx.chargeWords(fs.starts);
            const words = try ctx.arena.alloc([]const u8, 3 + fs.starts.len);
            words[0] = "rm";
            words[1] = "-r";
            words[2] = "--find";
            @memcpy(words[3..], fs.starts);
            try out.append(ctx.scratch, try newCmd(ctx, .{ .argv = words }));
        } else if (isFindExec(a)) {
            var end = i + 1;
            while (end < argv.len and !std.mem.eql(u8, argv[end], ";") and !std.mem.eql(u8, argv[end], "+")) end += 1;
            try expandExec(ctx, out, argv[i + 1 .. end], fs.starts, depth);
            i = end;
        }
    }
}

fn isFindExec(a: []const u8) bool {
    return std.mem.eql(u8, a, "-exec") or std.mem.eql(u8, a, "-execdir") or std.mem.eql(u8, a, "-ok") or std.mem.eql(u8, a, "-okdir");
}

const Prefix = struct { argv: []const []const u8, assigns: []const []const u8, wrappers: []const []const u8 };

fn stripPrefix(ctx: *Ctx, words: []const []const u8) Error!Prefix {
    var argv = words;
    while (argv.len > 0 and reserved.has(argv[0])) argv = argv[1..];
    var assigns: std.ArrayList([]const u8) = .empty;
    defer assigns.deinit(ctx.scratch);
    var names: std.ArrayList([]const u8) = .empty;
    defer names.deinit(ctx.scratch);
    while (argv.len > 0 and wrappers.isAssign(argv[0])) : (argv = argv[1..]) try assigns.append(ctx.scratch, argv[0]);
    var n: usize = 0;
    while (n < 8) : (n += 1) {
        const un = try wrappers.unwrap(ctx, argv) orelse break;
        argv = un.rest;
        try assigns.appendSlice(ctx.scratch, un.assigns);
        try names.append(ctx.scratch, un.name);
        while (argv.len > 0 and wrappers.isAssign(argv[0])) : (argv = argv[1..]) try assigns.append(ctx.scratch, argv[0]);
    }
    return .{
        .argv = argv,
        .assigns = try ctx.arena.dupe([]const u8, assigns.items),
        .wrappers = try ctx.arena.dupe([]const u8, names.items),
    };
}

// TS: /^\s*(\$\(|`|<\()\s*(curl|wget)\b/
fn isFetchSubst(a: []const u8) bool {
    var i: usize = 0;
    i = skipSpace(a, i);
    const opener: usize = if (std.mem.startsWith(u8, a[i..], "$(") or std.mem.startsWith(u8, a[i..], "<("))
        2
    else if (std.mem.startsWith(u8, a[i..], "`")) 1 else return false;
    i = skipSpace(a, i + opener);
    const rest = a[i..];
    const word_len: usize = if (std.mem.startsWith(u8, rest, "curl") or std.mem.startsWith(u8, rest, "wget")) 4 else return false;
    return word_len == rest.len or !isWordChar(rest[word_len]);
}

fn skipSpace(a: []const u8, from: usize) usize {
    var i = from;
    while (i < a.len) {
        const n = lexer.jsSpaceAt(a, i);
        if (n == 0) break;
        i += n;
    }
    return i;
}

fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

fn resolve(ctx: *Ctx, raw: Stmt, depth: u32) Error![]*Cmd {
    try ctx.enter();
    defer ctx.leave();
    if (ctx.resolves_left == 0) return ctx.fail("too complex");
    ctx.resolves_left -= 1;

    var expanded: std.ArrayList([]const u8) = .empty;
    defer expanded.deinit(ctx.scratch);
    try ctx.chargeWords(raw.words);
    for (raw.words) |w| try braces.expandBraces(ctx.arena, ctx.scratch, w, &expanded);
    try ctx.chargeWords(expanded.items);
    const words = try ctx.arena.dupe([]const u8, expanded.items);
    const pre = try stripPrefix(ctx, words);
    const argv = pre.argv;
    const name = base(if (argv.len > 0) argv[0] else null);
    const runs = wrappers.runsScript(name);
    var download_exec = false;
    if (runs) {
        for (argv) |a| {
            if (isFetchSubst(a)) download_exec = true;
        }
    }
    const cmd = try newCmd(ctx, .{
        .argv = argv,
        .assigns = pre.assigns,
        .wrappers = pre.wrappers,
        .piped = raw.piped,
        .here_string = raw.here_string,
        .redirects = raw.redirects,
        .download_exec = download_exec,
    });
    var out: std.ArrayList(*Cmd) = .empty;
    defer out.deinit(ctx.scratch);
    try out.append(ctx.scratch, cmd);
    const script = if (runs) try wrappers.shellScript(ctx, name, argv) else null;
    if (script) |s| {
        if (std.mem.find(u8, s, "<stdin>") != null) return ctx.fail("script comes from stdin");
        // eval runs in the current shell, so a `cd` inside it must stay visible to the rest of the line.
        if (std.mem.eql(u8, name, "eval")) {
            try out.appendSlice(ctx.scratch, try parseCommands(ctx, s, depth + 1));
        } else try scoped(ctx, &out, s, depth);
    }
    try launchedCmds(ctx, &out, argv, depth);
    if (std.mem.eql(u8, name, "find")) try findExtras(ctx, &out, argv, depth);
    return ctx.arena.dupe(*Cmd, out.items);
}

fn launchedCmds(ctx: *Ctx, out: *std.ArrayList(*Cmd), argv: []const []const u8, depth: u32) Error!void {
    const l = try launchers.launched(ctx, argv);
    for (l.scripts) |s| try out.appendSlice(ctx.scratch, try parseCommands(ctx, s, depth + 1));
    for (l.argvs) |words| try out.appendSlice(ctx.scratch, try resolve(ctx, .{ .words = words }, depth + 1));
}

// Child shells and substitutions get their own cwd scope.
fn scoped(ctx: *Ctx, out: *std.ArrayList(*Cmd), src: []const u8, depth: u32) Error!void {
    try out.append(ctx.scratch, try newMark(ctx, .open));
    try out.appendSlice(ctx.scratch, try parseCommands(ctx, src, depth + 1));
    try out.append(ctx.scratch, try newMark(ctx, .close));
}

/// Commands of `src` in execution order. Everything is allocated in `ctx.arena`.
pub fn parseCommands(ctx: *Ctx, src: []const u8, depth: u32) Error![]*Cmd {
    if (depth > max_depth or lexer.utf16Len(src) > max_length) return ctx.fail("too complex");
    if (src.len > ctx.bytes_left) return ctx.fail("too complex");
    ctx.bytes_left -= src.len;
    var toks = try lexer.lex(ctx, src);
    defer toks.deinit(ctx.scratch);

    var out: std.ArrayList(*Cmd) = .empty;
    defer out.deinit(ctx.scratch);
    var words: std.ArrayList([]const u8) = .empty;
    defer words.deinit(ctx.scratch);
    var redirects: std.ArrayList(Redirect) = .empty;
    defer redirects.deinit(ctx.scratch);
    var subs: std.ArrayList(*Cmd) = .empty;
    defer subs.deinit(ctx.scratch);
    // One backing array per pipeline so every stage's `after` is a view, not a copy.
    var group: std.ArrayList(*Cmd) = .empty;
    defer group.deinit(ctx.scratch);
    var here_string = false;
    var pending: ?Pending = null;

    for (toks.items) |t| {
        if (t.kind == .op) {
            const op = t.v;
            if (std.mem.eql(u8, op, ">")) {
                pending = .out;
            } else if (std.mem.eql(u8, op, "<")) {
                pending = .in;
            } else if (std.mem.eql(u8, op, "<<<")) {
                pending = .here;
            } else {
                try endStmt(ctx, depth, op, &out, &words, &redirects, &subs, &group, &here_string);
            }
            continue;
        }
        for (t.subs) |s| try scoped(ctx, &subs, s, depth);
        if (pending) |p| switch (p) {
            .here => here_string = true,
            .out => try redirects.append(ctx.scratch, .{ .op = .out, .path = t.v }),
            .in => try redirects.append(ctx.scratch, .{ .op = .in, .path = t.v }),
        } else try words.append(ctx.scratch, t.v);
        pending = null;
    }
    try endStmt(ctx, depth, ";", &out, &words, &redirects, &subs, &group, &here_string);

    var kept: std.ArrayList(*Cmd) = .empty;
    defer kept.deinit(ctx.scratch);
    for (out.items) |c| {
        if (c.mark != null or c.argv.len > 0 or c.assigns.len > 0 or c.redirects.len > 0) try kept.append(ctx.scratch, c);
    }
    return ctx.arena.dupe(*Cmd, kept.items);
}

fn endStmt(
    ctx: *Ctx,
    depth: u32,
    op: []const u8,
    out: *std.ArrayList(*Cmd),
    words: *std.ArrayList([]const u8),
    redirects: *std.ArrayList(Redirect),
    subs: *std.ArrayList(*Cmd),
    group: *std.ArrayList(*Cmd),
    here_string: *bool,
) Error!void {
    const piped = std.mem.eql(u8, op, "|");
    const cmds = try resolve(ctx, .{
        .words = try ctx.arena.dupe([]const u8, words.items),
        .redirects = try ctx.arena.dupe(Redirect, redirects.items),
        .here_string = here_string.*,
        .piped = piped,
    }, depth);
    try out.appendSlice(ctx.scratch, subs.items);
    try out.appendSlice(ctx.scratch, cmds);
    try group.append(ctx.scratch, cmds[0]);
    if (!piped) {
        try linkPipelines(ctx, group.items);
        group.clearRetainingCapacity();
    }
    subs.clearRetainingCapacity();
    words.clearRetainingCapacity();
    redirects.clearRetainingCapacity();
    here_string.* = false;
    if (std.mem.eql(u8, op, "(")) try out.append(ctx.scratch, try newMark(ctx, .open));
    if (std.mem.eql(u8, op, ")")) try out.append(ctx.scratch, try newMark(ctx, .close));
}

fn linkPipelines(ctx: *Ctx, group: []*Cmd) Allocator.Error!void {
    const shared = try ctx.arena.alloc(*const Cmd, group.len);
    for (group, shared) |c, *dst| dst.* = c;
    for (group, 0..) |c, i| {
        c.after = shared[i + 1 ..];
        c.from_pipe = i > 0;
    }
}

pub const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    cmds: []const *const Cmd,

    /// Frees the commands and every string they point at.
    pub fn deinit(self: *Parsed) void {
        self.arena.deinit();
    }
};

/// Why a command line could not be parsed; copied out of the parse state so it outlives it.
pub const Unparseable = struct {
    buf: [64]u8 = undefined,
    len: u8 = 0,

    pub fn message(self: *const Unparseable) []const u8 {
        return self.buf[0..self.len];
    }
};

pub const Outcome = union(enum) {
    parsed: Parsed,
    unparseable: Unparseable,

    pub fn deinit(self: *Outcome) void {
        if (self.* == .parsed) self.parsed.deinit();
    }
};

/// Parses a command line (valid UTF-8, as a JSON string always is). The TS ShellParseError cases
/// come back as `.unparseable` with the same message; only allocation failure is an error.
pub fn parse(gpa: Allocator, src: []const u8) Allocator.Error!Outcome {
    if (!std.unicode.utf8ValidateSlice(src)) return unparseable("invalid utf-8");
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    var ctx: Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    const cmds = parseCommands(&ctx, src, 0) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        error.ShellParse => {
            arena.deinit();
            return unparseable(ctx.reason);
        },
    };
    return .{ .parsed = .{ .arena = arena, .cmds = @ptrCast(cmds) } };
}

fn unparseable(reason: []const u8) Outcome {
    var u: Unparseable = .{};
    const n = @min(reason.len, u.buf.len);
    @memcpy(u.buf[0..n], reason[0..n]);
    u.len = @intCast(n);
    return .{ .unparseable = u };
}

test {
    _ = @import("shell_test.zig");
}
