//! Agreement with the TS L1 evaluator on every row of fixtures/l1.json (command lines: the corpus,
//! hand-written edge cases and a seeded generator) and fixtures/l1_actions.json (read, edit, delete,
//! fetch and other actions), made by tools/gen-guard-fixtures.ts.
const std = @import("std");
const l1 = @import("l1.zig");
const Value = std.json.Value;

const gpa = std.testing.allocator;

const scopes = [_]l1.Scope{
    .{ .root = "/work/wt", .home = "/home/u", .default_branch = "main" },
    .{ .root = "/work/wt", .home = "/home/u", .harness_home = "/data/h", .default_branch = "trunk" },
};

fn field(row: Value, key: []const u8) ?Value {
    return row.object.get(key);
}

fn parseKind(s: []const u8) !l1.Kind {
    return std.meta.stringToEnum(l1.Kind, s) orelse error.TestUnexpectedResult;
}

fn actionOf(arena: std.mem.Allocator, row: Value) !l1.Action {
    if (field(row, "in")) |src| return .{ .kind = .execute, .command = src.string };
    const a = field(row, "a").?;
    const raw = field(a, "paths").?.array.items;
    const paths = try arena.alloc([]const u8, raw.len);
    for (raw, paths) |p, *d| d.* = p.string;
    return .{
        .kind = try parseKind(field(a, "kind").?.string),
        .command = if (field(a, "command")) |c| c.string else null,
        .paths = paths,
        .tool_name = if (field(a, "toolName")) |t| t.string else null,
    };
}

fn describe(row: Value) void {
    const what = field(row, "in") orelse field(row, "a").?;
    std.debug.print("L1 disagrees on {f} (scope {d})\n", .{ std.json.fmt(what, .{}), field(row, "s").?.integer });
}

fn checkRow(row: Value) !void {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const action = try actionOf(arena.allocator(), row);
    const scope = scopes[@intCast(field(row, "s").?.integer)];
    const got = l1.evaluate(arena.allocator(), gpa, std.testing.io, action, scope);
    if (field(row, "err") != null) {
        try std.testing.expectError(error.Throw, got);
        return;
    }
    const r = try got;
    try std.testing.expectEqualStrings(field(row, "v").?.string, @tagName(r.verdict));
    const want_rule = field(row, "r").?;
    if (want_rule == .null) try std.testing.expect(r.rule == null) else try std.testing.expectEqualStrings(want_rule.string, r.rule.?);
    try std.testing.expectEqualStrings(field(row, "c").?.string, @tagName(r.category));
    try std.testing.expectEqualStrings(field(row, "why").?.string, r.reason);
}

fn checkFile(comptime name: []const u8) !usize {
    const parsed = try std.json.parseFromSlice(Value, gpa, @embedFile("fixtures/" ++ name), .{});
    defer parsed.deinit();
    for (parsed.value.array.items) |row| {
        checkRow(row) catch |e| {
            describe(row);
            return e;
        };
    }
    return parsed.value.array.items.len;
}

test "guard fixtures: L1 verdicts on command lines equal TS" {
    const n = try checkFile("l1.json");
    std.debug.print("l1.json: {d} of {d} rows agree\n", .{ n, n });
}

test "guard fixtures: L1 verdicts on actions equal TS" {
    const n = try checkFile("l1_actions.json");
    std.debug.print("l1_actions.json: {d} of {d} rows agree\n", .{ n, n });
}
