//! Commands that run a string or argv later or elsewhere (git rebase -x, trap, watch, alias, fd -x);
//! the inner command is judged like a typed one. Port of guard/launchers.ts.
const std = @import("std");
const lexer = @import("lexer.zig");
const wrappers = @import("wrappers.zig");
const Ctx = lexer.Ctx;
const Error = lexer.Error;

pub const Launched = struct {
    scripts: []const []const u8 = &.{},
    argvs: []const []const []const u8 = &.{},
};

fn isOneOf(s: []const u8, comptime names: []const []const u8) bool {
    inline for (names) |n| if (std.mem.eql(u8, s, n)) return true;
    return false;
}

fn tail(argv: []const []const u8, from: usize) []const []const u8 {
    return argv[@min(from, argv.len)..];
}

const GitSub = struct { sub: []const u8, rest: []const []const u8 };

fn gitSub(argv: []const []const u8) GitSub {
    var i: usize = 1;
    while (i < argv.len and std.mem.startsWith(u8, argv[i], "-")) {
        i += if (isOneOf(argv[i], &.{ "-c", "-C", "--git-dir", "--work-tree", "--namespace" })) 2 else 1;
    }
    return .{ .sub = if (i < argv.len) argv[i] else "", .rest = tail(argv, i + 1) };
}

// TS: /^--exec=(.*)/. `.` stops at a line terminator, so the capture ends at the first one.
fn execValue(a: []const u8) ?[]const u8 {
    const prefix = "--exec=";
    if (!std.mem.startsWith(u8, a, prefix)) return null;
    const v = a[prefix.len..];
    var i: usize = 0;
    while (i < v.len) : (i += 1) {
        switch (v[i]) {
            '\n', '\r' => return v[0..i],
            0xe2 => if (i + 2 < v.len and v[i + 1] == 0x80 and (v[i + 2] == 0xa8 or v[i + 2] == 0xa9)) return v[0..i],
            else => {},
        }
    }
    return v;
}

fn gitLaunch(ctx: *Ctx, argv: []const []const u8) Error!Launched {
    const g = gitSub(argv);
    if (std.mem.eql(u8, g.sub, "rebase")) {
        var scripts: std.ArrayList([]const u8) = .empty;
        defer scripts.deinit(ctx.scratch);
        for (g.rest, 0..) |a, i| {
            if (std.mem.eql(u8, a, "-x") or std.mem.eql(u8, a, "--exec")) {
                try scripts.append(ctx.scratch, if (i + 1 < g.rest.len) g.rest[i + 1] else "");
            } else if (execValue(a)) |v| try scripts.append(ctx.scratch, v);
        }
        return .{ .scripts = try ctx.arena.dupe([]const u8, scripts.items) };
    }
    if (std.mem.eql(u8, g.sub, "bisect") and g.rest.len > 0 and std.mem.eql(u8, g.rest[0], "run")) {
        return .{ .argvs = try ctx.arena.dupe([]const []const u8, &.{tail(g.rest, 1)}) };
    }
    if (std.mem.eql(u8, g.sub, "submodule") and g.rest.len > 0 and std.mem.eql(u8, g.rest[0], "foreach")) {
        var words: std.ArrayList([]const u8) = .empty;
        defer words.deinit(ctx.scratch);
        for (g.rest) |a| if (!std.mem.startsWith(u8, a, "-")) try words.append(ctx.scratch, a);
        const script = try std.mem.join(ctx.arena, " ", tail(words.items, 1));
        return .{ .scripts = try ctx.arena.dupe([]const u8, &.{script}) };
    }
    return .{};
}

fn watchScript(ctx: *Ctx, args: []const []const u8) Error![]const u8 {
    var words: std.ArrayList([]const u8) = .empty;
    defer words.deinit(ctx.scratch);
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (words.items.len == 0 and std.mem.startsWith(u8, a, "-")) {
            if (isOneOf(a, &.{ "-n", "--interval" })) i += 1;
        } else try words.append(ctx.scratch, a);
    }
    return std.mem.join(ctx.arena, " ", words.items);
}

fn single(ctx: *Ctx, script: []const u8) Error!Launched {
    return .{ .scripts = try ctx.arena.dupe([]const u8, &.{script}) };
}

/// Inner scripts and argvs of a command that launches them; empty for every other command.
pub fn launched(ctx: *Ctx, argv: []const []const u8) Error!Launched {
    const name = wrappers.base(if (argv.len > 0) argv[0] else null);
    if (std.mem.eql(u8, name, "git")) return gitLaunch(ctx, argv);
    if (std.mem.eql(u8, name, "trap")) {
        const action: ?[]const u8 = if (argv.len > 1 and std.mem.eql(u8, argv[1], "--"))
            (if (argv.len > 2) argv[2] else null)
        else if (argv.len > 1) argv[1] else null;
        if (action) |a| if (a.len > 0 and a[0] != '-') return single(ctx, a);
        return .{};
    }
    if (std.mem.eql(u8, name, "watch")) return single(ctx, try watchScript(ctx, tail(argv, 1)));
    if (std.mem.eql(u8, name, "alias")) {
        var values: std.ArrayList([]const u8) = .empty;
        defer values.deinit(ctx.scratch);
        for (tail(argv, 1)) |a| {
            if (std.mem.findScalar(u8, a, '=')) |eq| try values.append(ctx.scratch, a[eq + 1 ..]);
        }
        return .{ .scripts = try ctx.arena.dupe([]const u8, values.items) };
    }
    if (std.mem.eql(u8, name, "fd") or std.mem.eql(u8, name, "fdfind")) {
        for (argv, 0..) |a, i| {
            if (isOneOf(a, &.{ "-x", "--exec", "-X", "--exec-batch" })) {
                return .{ .argvs = try ctx.arena.dupe([]const []const u8, &.{tail(argv, i + 1)}) };
            }
        }
    }
    return .{};
}

test {
    _ = @import("launchers_test.zig");
}
