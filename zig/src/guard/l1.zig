//! Guard level 1: decides an action from its text alone. Port of guard/l1.ts.
const std = @import("std");
const Allocator = std.mem.Allocator;
const core = @import("rules_core.zig");
const git_readonly = @import("git_readonly.zig");
const lexer = @import("lexer.zig");
const net = @import("rules_net.zig");
const rules = @import("rules.zig");
const secret = @import("rules_secret.zig");
const shell = @import("shell.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Cwd = core.Cwd;
const Result = core.Result;
const Verdict = core.Verdict;

pub const Scope = core.Scope;
pub const Env = core.Env;

/// `Throw` stands for a TypeError the TS evaluator raises (see runsProgram); callers fail closed.
pub const Error = core.Error || error{ RelativeScope, Throw };

pub const Kind = enum { execute, read, edit, delete, fetch, other };

pub const Action = struct {
    kind: Kind,
    command: ?[]const u8 = null,
    paths: []const []const u8 = &.{},
    tool_name: ?[]const u8 = null,
};

fn rank(r: Result) u8 {
    const base: u8 = switch (r.verdict) {
        .allow => 0,
        .ask => 2,
        .deny => 3,
    };
    return base + @intFromBool(r.verdict == .allow and r.rule != null);
}

fn stronger(hit: Result, best: ?Result) bool {
    return best == null or rank(hit) > rank(best.?);
}

fn isReadName(n: []const u8) bool {
    return core.oneOf(n, &.{ "ls", "cat", "head", "tail", "grep", "rg", "wc", "find", "stat", "file", "pwd", "echo", "printf", "diff", "sort", "uniq", "cut", "tr", "which", "jq" });
}

fn isNetworkName(n: []const u8) bool {
    return core.oneOf(n, &.{ "curl", "wget", "ssh", "scp", "rsync", "ping", "dig", "nslookup" });
}

// Names that are properties of Object.prototype: `RUNS_PROGRAM[name]` finds a function there and
// `.some` on it throws as soon as the command has an argument, so TS gives no verdict then.
fn isProtoName(n: []const u8) bool {
    return core.oneOf(n, &.{ "constructor", "__proto__", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__" });
}

// Flags that make an otherwise read-only command run another program. GNU getopt accepts any
// unambiguous prefix of a long option, so `sort --comp=x` counts too.
fn runsProgram(cmd: *const Cmd) Error!bool {
    const name = core.name0(cmd);
    if (isProtoName(name) and cmd.argv.len > 1) return error.Throw;
    const is_sort = std.mem.eql(u8, name, "sort");
    const flags: []const []const u8 = if (std.mem.eql(u8, name, "rg"))
        &.{ "--pre", "--hostname-bin" }
    else if (is_sort)
        &.{"--compress-program"}
    else if (std.mem.eql(u8, name, "find"))
        &.{ "-exec", "-execdir", "-ok", "-okdir" }
    else
        &.{};
    for (if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv) |arg| {
        const flag = arg[0 .. std.mem.findScalar(u8, arg, '=') orelse arg.len];
        for (flags) |f| {
            if (std.mem.eql(u8, flag, f) or (is_sort and flag.len >= 4 and std.mem.startsWith(u8, f, flag))) return true;
        }
    }
    return false;
}

/// `git` is never read-only as a whole; only the forms isReadOnlyGit knows are.
fn isReadCmd(ctx: Ctx, cmd: *const Cmd) core.Error!bool {
    if (!git_readonly.plainEnv(cmd)) return false;
    if (cmd.argv.len == 0) return true;
    const name = core.name0(cmd);
    return if (std.mem.eql(u8, name, "git")) git_readonly.isReadOnlyGit(ctx, cmd) else isReadName(name);
}

fn defaultCategory(ctx: Ctx, cmds: []const *const Cmd) Error!core.Category {
    var any_name = false;
    for (cmds) |c| {
        const n = core.name0(c);
        if (n.len > 0) any_name = true;
        if (isNetworkName(n)) return .network;
    }
    for (cmds) |c| if (try runsProgram(c)) return .shell;
    var reads = true;
    for (cmds) |c| if (c.mark == null and !try isReadCmd(ctx, c)) {
        reads = false;
    };
    return if (any_name and reads) .read else .shell;
}

/// The working directory as the line runs; `.unknown` once it depends on something unknowable.
const Walk = struct {
    cwd: Cwd,
    scopes: std.ArrayList(Cwd) = .empty,
    dirs: std.ArrayList(Cwd) = .empty,
    fetched: net.Fetched = .empty,
};

fn changeDir(a: Allocator, cmd: *const Cmd, ctx: Ctx, w: *Walk) core.Error!void {
    const name = core.name0(cmd);
    if (std.mem.eql(u8, name, "popd")) {
        w.cwd = w.dirs.pop() orelse .unknown;
        return;
    }
    if (core.oneOf(name, &.{ "source", "." })) w.cwd = .unknown;
    if (!core.oneOf(name, &.{ "cd", "pushd" })) return;
    var target: ?[]const u8 = null;
    for (cmd.argv[1..]) |arg| if (!core.oneOf(arg, &.{ "-L", "-P", "--" })) {
        target = arg;
        break;
    };
    if (std.mem.eql(u8, name, "pushd")) try w.dirs.append(a, w.cwd);
    w.cwd = if (target) |t|
        (if (std.mem.eql(u8, t, "-")) .unknown else if (try core.resolvePath(ctx, t, null)) |abs| .{ .dir = abs } else .unknown)
    else
        .{ .dir = ctx.env.scope.home };
}

fn step(cmd: *const Cmd, env: *const core.Env, w: *Walk) core.Error!?Result {
    const a = env.a;
    if (cmd.mark) |m| {
        switch (m) {
            .open => try w.scopes.append(a, w.cwd),
            .close => if (w.scopes.pop()) |c| {
                w.cwd = c;
            },
        }
        return null;
    }
    const ctx: Ctx = .{ .env = env, .cwd = w.cwd };
    var best: ?Result = try net.runsFetched(cmd, ctx, &w.fetched);
    for (rules.rules) |rule| {
        if (try rule(cmd, ctx)) |hit| if (stronger(hit, best)) {
            best = hit;
        };
    }
    try net.recordFetch(cmd, ctx, &w.fetched);
    try changeDir(a, cmd, ctx, w);
    return best;
}

fn strictest(env: *const core.Env, cmds: []const *const Cmd) core.Error!?Result {
    var w: Walk = .{ .cwd = .{ .dir = env.scope.root } };
    var best: ?Result = null;
    for (cmds) |cmd| {
        if (try step(cmd, env, &w)) |hit| if (stronger(hit, best)) {
            best = hit;
        };
    }
    return best;
}

fn isBlank(s: []const u8) bool {
    var i: usize = 0;
    while (i < s.len) {
        const n = lexer.jsSpaceAt(s, i);
        if (n == 0) return false;
        i += n;
    }
    return true;
}

fn evaluateShell(gpa: Allocator, env: *const core.Env, command: ?[]const u8) Error!Result {
    const text = command orelse return core.ask("shell.empty", "no command to evaluate", .shell);
    if (isBlank(text)) return core.ask("shell.empty", "no command to evaluate", .shell);
    var outcome = try shell.parse(gpa, text);
    defer outcome.deinit();
    const ctx: Ctx = .{ .env = env };
    switch (outcome) {
        .unparseable => |u| {
            const why = try std.fmt.allocPrint(env.a, "cannot parse command: {s}", .{u.message()});
            return core.ask("shell.unparseable", why, .shell);
        },
        .parsed => |p| {
            if (try strictest(env, p.cmds)) |r| return r;
            return core.allow(null, "no rule matched", try defaultCategory(ctx, p.cmds));
        },
    }
}

// A symlink inside the skills dir can point anywhere, so compare real paths, not the lexical ones.
fn inInstalledSkills(ctx: Ctx, abs: []const u8) core.Error!bool {
    const dir = try core.resolve(ctx.env.a, ctx.env.scope.home, ".agents/skills");
    const skills = (try core.realpath(ctx, dir)) orelse return false;
    const real = (try core.realpath(ctx, abs)) orelse return false;
    return core.isInsideRoot(real, try core.resolve(ctx.env.a, "/", skills));
}

fn evaluatePaths(env: *const core.Env, action: Action) core.Error!Result {
    const ctx: Ctx = .{ .env = env };
    const paths = action.paths;
    if (paths.len == 0) return core.ask("path.none", "request names no path", .other);
    const category: core.Category = switch (action.kind) {
        .read => .read,
        .delete => .delete,
        else => .edit,
    };
    const reading = action.kind == .read;
    if (reading) for (paths) |p| if (try secret.isSecretPath(ctx, p)) {
        return try secret.secretPathDeny(ctx, p);
    };
    for (paths) |p| {
        const abs = try core.resolvePath(ctx, p, null);
        // Codex reads its installed skills from here on every run; reading them is harmless, editing stays denied.
        const outside = abs == null or !((reading and try inInstalledSkills(ctx, abs.?)) or core.isInside(ctx, abs.?));
        if (!outside) continue;
        const why = try core.fmt(ctx, "{s} is outside the task root", .{p});
        return if (reading) core.ask("read.outside-root", why, category) else core.deny("write.outside-root", why, category);
    }
    if (!reading) for (paths) |p| {
        if (core.isGitInternals((try core.resolvePath(ctx, p, null)) orelse "")) {
            return core.deny("write.git-internals", "git hooks and config run code", category);
        }
    };
    return core.allow(null, "inside the task root", category);
}

// Claude names its MCP tools mcp__harness__x and Codex mcp.harness.x; Codex files them under kind
// execute with no command, which L1 would otherwise ask about. ACP tool names are display titles
// that can carry model-chosen text, so the whole name must be a registered tool, and the action
// must name no path and no command.
const harness_tools = [_][]const u8{
    "whoami",         "report",           "chat_channels",   "chat_read",           "chat_post",
    "chat_dm",        "board_list",       "task_get",        "task_create",         "task_update",
    "task_checkout",  "task_release",     "task_move",       "task_comment",        "task_depend",
    "approvals_list", "approvals_decide", "profile_get",     "profile_card_submit", "team_roster",
    "task_delegate",  "task_estimate",    "hire_request",    "hire_list",           "interview_answer",
    "interview_ask",  "interview_pass",   "interview_score", "hire_decide",         "policy_get",
    "policy_propose", "policy_review",    "policy_decide",
};

fn isHarnessTool(action: Action) bool {
    if (action.command != null or action.paths.len != 0) return false;
    if (action.kind != .other and action.kind != .execute) return false;
    const name = action.tool_name orelse return false;
    for ([_][]const u8{ "mcp__harness__", "mcp.harness." }) |prefix| {
        if (!std.mem.startsWith(u8, name, prefix)) continue;
        if (core.contains(&harness_tools, name[prefix.len..])) return true;
    }
    return false;
}

/// `a` owns the reasons and resolved paths in the result; `gpa` backs the parser, which frees its own.
pub fn evaluate(a: Allocator, gpa: Allocator, io: std.Io, action: Action, scope: Scope) Error!Result {
    var env = try Env.init(a, io, scope);
    return evaluateIn(gpa, &env, action);
}

pub fn evaluateIn(gpa: Allocator, env: *const Env, action: Action) Error!Result {
    if (isHarnessTool(action)) return core.allow(null, "harness tool, scoped by the run token", .other);
    switch (action.kind) {
        .execute => return evaluateShell(gpa, env, action.command),
        .read, .edit, .delete => return evaluatePaths(env, action),
        .fetch => return core.ask("fetch.any", "network fetch needs approval", .network),
        .other => {
            // Claude loads the harness MCP tool schemas through ToolSearch, which only reads tool
            // definitions. The harness's own tools are already limited by the run token's scopes.
            // Asking for either would stop every unattended agent before its first board call.
            if (action.tool_name) |t| if (std.mem.eql(u8, t, "ToolSearch")) return core.allow(null, "tool schema lookup", .other);
            return core.ask("other.any", "unclassified action", .other);
        },
    }
}

test {
    _ = @import("l1_fixtures_test.zig");
    _ = @import("l1_test.zig");
}
