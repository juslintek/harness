//! Agreement with the TS guard on every row of fixtures/*.json (made by tools/gen-guard-fixtures.ts
//! from the corpus, hand-written edge cases and a seeded generator).
const std = @import("std");
const lexer = @import("lexer.zig");
const shell = @import("shell.zig");
const braces = @import("braces.zig");
const wrappers = @import("wrappers.zig");
const launchers = @import("launchers.zig");
const Value = std.json.Value;

const gpa = std.testing.allocator;

fn load(comptime name: []const u8) !std.json.Parsed(Value) {
    return std.json.parseFromSlice(Value, gpa, @embedFile("fixtures/" ++ name), .{});
}

fn get(row: Value, key: []const u8) ?Value {
    return row.object.get(key);
}

fn str(v: Value) []const u8 {
    return v.string;
}

fn expectOpt(row: Value, key: []const u8, actual: []const []const u8) !void {
    const items: []const Value = if (get(row, key)) |v| v.array.items else &.{};
    try std.testing.expectEqual(items.len, actual.len);
    for (items, actual) |e, a| try std.testing.expectEqualStrings(e.string, a);
}

fn expectStrings(expected: Value, actual: []const []const u8) !void {
    try std.testing.expectEqual(expected.array.items.len, actual.len);
    for (expected.array.items, actual) |e, a| try std.testing.expectEqualStrings(e.string, a);
}

fn failRow(row: Value, what: []const u8) error{TestUnexpectedResult} {
    std.debug.print("{s} disagrees on input {f}\n", .{ what, std.json.fmt(str(get(row, "in").?), .{}) });
    return error.TestUnexpectedResult;
}

var checked: usize = 0;

test "guard fixtures: lexer tokens equal TS" {
    const parsed = try load("lex.json");
    defer parsed.deinit();
    for (parsed.value.array.items) |row| {
        lexRow(row) catch |e| return if (e == error.TestUnexpectedResult) failRow(row, "lex") else e;
    }
    checked += parsed.value.array.items.len;
}

fn lexRow(row: Value) !void {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    const src = str(get(row, "in").?);
    var toks = lexer.lex(&ctx, src) catch |e| switch (e) {
        error.ShellParse => {
            try std.testing.expectEqualStrings(str(get(row, "err") orelse return error.TestUnexpectedResult), ctx.reason);
            return;
        },
        error.OutOfMemory => return e,
    };
    defer toks.deinit(gpa);
    const want = (get(row, "toks") orelse return error.TestUnexpectedResult).array.items;
    try std.testing.expectEqual(want.len, toks.items.len);
    for (want, toks.items) |w, t| {
        const parts = w.array.items;
        try std.testing.expectEqual(parts[0].string[0] == 'w', t.kind == .word);
        try std.testing.expectEqualStrings(parts[1].string, t.v);
        if (t.kind == .word) try expectStrings(parts[2], t.subs);
    }
}

fn flag(cmd: Value, key: []const u8) bool {
    return if (get(cmd, key)) |v| v.bool else false;
}

fn expectCmd(want: Value, got: *const shell.Cmd) !void {
    if (get(want, "mark")) |m| {
        const expected: shell.Mark = if (m.string[0] == '(') .open else .close;
        try std.testing.expectEqual(expected, got.mark.?);
        return;
    }
    try std.testing.expect(got.mark == null);
    try expectStrings(get(want, "argv").?, got.argv);
    try expectOpt(want, "assigns", got.assigns);
    try expectOpt(want, "wrappers", got.wrappers);
    try std.testing.expectEqual(flag(want, "piped"), got.piped);
    try std.testing.expectEqual(flag(want, "fromPipe"), got.from_pipe);
    try std.testing.expectEqual(flag(want, "hereString"), got.here_string);
    try std.testing.expectEqual(flag(want, "downloadExec"), got.download_exec);
    const redirects = if (get(want, "redirects")) |r| r.array.items else &.{};
    try std.testing.expectEqual(redirects.len, got.redirects.len);
    for (redirects, got.redirects) |r, g| {
        try std.testing.expectEqual(r.array.items[0].string[0] == '>', g.op == .out);
        try std.testing.expectEqualStrings(r.array.items[1].string, g.path);
    }
    const after = if (get(want, "after")) |a| a.array.items else &.{};
    try std.testing.expectEqual(after.len, got.after.len);
    for (after, got.after) |a, g| try expectStrings(a, g.argv);
}

fn shellRow(row: Value) !void {
    var out = try shell.parse(gpa, str(get(row, "in").?));
    defer out.deinit();
    switch (out) {
        .unparseable => |u| try std.testing.expectEqualStrings(str(get(row, "err") orelse return error.TestUnexpectedResult), u.message()),
        .parsed => |p| {
            const want = (get(row, "cmds") orelse return error.TestUnexpectedResult).array.items;
            try std.testing.expectEqual(want.len, p.cmds.len);
            for (want, p.cmds) |w, c| try expectCmd(w, c);
        },
    }
}

test "guard fixtures: parsed commands equal TS" {
    const parsed = try load("shell.json");
    defer parsed.deinit();
    for (parsed.value.array.items) |row| {
        shellRow(row) catch |e| return if (e == error.TestUnexpectedResult) failRow(row, "parse") else e;
    }
    checked += parsed.value.array.items.len;
}

test "guard fixtures: brace expansion equals TS" {
    const parsed = try load("braces.json");
    defer parsed.deinit();
    for (parsed.value.array.items) |row| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        var out: std.ArrayList([]const u8) = .empty;
        defer out.deinit(gpa);
        try braces.expandBraces(arena.allocator(), gpa, str(get(row, "in").?), &out);
        expectStrings(get(row, "out").?, out.items) catch |e| return if (e == error.TestUnexpectedResult) failRow(row, "braces") else e;
    }
    checked += parsed.value.array.items.len;
}

fn argvOf(arena: std.mem.Allocator, v: Value) ![]const []const u8 {
    const out = try arena.alloc([]const u8, v.array.items.len);
    for (v.array.items, out) |s, *d| d.* = s.string;
    return out;
}

fn wrapperRow(row: Value) !void {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    const argv = try argvOf(arena.allocator(), get(row, "argv").?);
    const want = get(row, "unwrap").?;
    if (wrappers.unwrap(&ctx, argv)) |maybe| {
        if (want == .null) {
            try std.testing.expect(maybe == null);
        } else {
            const u = maybe orelse return error.TestUnexpectedResult;
            try expectStrings(get(want, "rest") orelse return error.TestUnexpectedResult, u.rest);
            try expectStrings(get(want, "assigns").?, u.assigns);
            try std.testing.expectEqualStrings(str(get(want, "name").?), u.name);
        }
    } else |e| switch (e) {
        error.ShellParse => try std.testing.expectEqualStrings(str(get(want, "err") orelse return error.TestUnexpectedResult), ctx.reason),
        error.OutOfMemory => return e,
    }
    const name = wrappers.base(if (argv.len > 0) argv[0] else null);
    try std.testing.expectEqual(get(row, "runs").?.bool, wrappers.runsScript(name));
    if (wrappers.runsScript(name)) {
        const script = try wrappers.shellScript(&ctx, name, argv);
        const ws = get(row, "script").?;
        if (ws == .null) try std.testing.expect(script == null) else try std.testing.expectEqualStrings(ws.string, script.?);
    }
}

test "guard fixtures: wrappers equal TS" {
    const parsed = try load("wrappers.json");
    defer parsed.deinit();
    for (parsed.value.array.items) |row| {
        wrapperRow(row) catch |e| return if (e == error.TestUnexpectedResult) failRowArgv(row, "wrapper") else e;
    }
    checked += parsed.value.array.items.len;
}

fn failRowArgv(row: Value, what: []const u8) error{TestUnexpectedResult} {
    std.debug.print("{s} disagrees on argv {f}\n", .{ what, std.json.fmt(get(row, "argv").?, .{}) });
    return error.TestUnexpectedResult;
}

fn launcherRow(row: Value) !void {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa };
    const argv = try argvOf(arena.allocator(), get(row, "argv").?);
    const l = try launchers.launched(&ctx, argv);
    try expectStrings(get(row, "scripts").?, l.scripts);
    const argvs = get(row, "argvs").?.array.items;
    try std.testing.expectEqual(argvs.len, l.argvs.len);
    for (argvs, l.argvs) |w, g| try expectStrings(w, g);
}

test "guard fixtures: launchers equal TS" {
    const parsed = try load("launchers.json");
    defer parsed.deinit();
    for (parsed.value.array.items) |row| {
        launcherRow(row) catch |e| return if (e == error.TestUnexpectedResult) failRowArgv(row, "launcher") else e;
    }
    checked += parsed.value.array.items.len;
}

test "guard fixtures: every row was checked" {
    // Tests of one binary run in declaration order on one thread; the count is only a sanity
    // check that the embedded files were not empty.
    try std.testing.expect(checked > 1000);
}
