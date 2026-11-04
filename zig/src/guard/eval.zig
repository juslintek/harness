//! `harness guard-eval`: one L1 verdict per stdin line, for differential fuzzing against the TS
//! evaluator. Without a flag each line is a command line (kind execute, the corpus scope). With
//! `--json` each line is an object `{kind, command?, paths?, toolName?, scope?}` in the shape of the
//! TS ActionRequest, where `scope` is `{root, home, harnessHome?, defaultBranch}`.
//! Output is one JSON object per line: `{"verdict","rule","category","reason"}`, or `{"error":...}`
//! (`throw` is a TypeError the TS evaluator raises, `scope` a relative root or home, `input` a
//! line that is not an action).
const std = @import("std");
const Allocator = std.mem.Allocator;
const l1 = @import("l1.zig");

const max_line_bytes = 4 * 1024 * 1024;

const corpus_scope: l1.Scope = .{ .root = "/work/wt", .home = "/home/u", .default_branch = "main" };

const Parsed = struct { action: l1.Action, scope: l1.Scope };

fn str(v: std.json.Value) ?[]const u8 {
    return if (v == .string) v.string else null;
}

fn parseScope(obj: std.json.ObjectMap) ?l1.Scope {
    return .{
        .root = str(obj.get("root") orelse return null) orelse return null,
        .home = str(obj.get("home") orelse return null) orelse return null,
        .harness_home = if (obj.get("harnessHome")) |h| str(h) else null,
        .default_branch = str(obj.get("defaultBranch") orelse return null) orelse return null,
    };
}

fn parseAction(a: Allocator, line: []const u8) ?Parsed {
    const v = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch return null;
    if (v != .object) return null;
    const kind = std.meta.stringToEnum(l1.Kind, str(v.object.get("kind") orelse return null) orelse return null) orelse return null;
    var paths: std.ArrayList([]const u8) = .empty;
    if (v.object.get("paths")) |p| {
        if (p != .array) return null;
        for (p.array.items) |item| paths.append(a, str(item) orelse return null) catch return null;
    }
    const scope = if (v.object.get("scope")) |s| (if (s == .object) parseScope(s.object) orelse return null else return null) else corpus_scope;
    return .{
        .action = .{
            .kind = kind,
            .command = if (v.object.get("command")) |c| str(c) orelse return null else null,
            .paths = paths.items,
            .tool_name = if (v.object.get("toolName")) |t| str(t) orelse return null else null,
        },
        .scope = scope,
    };
}

pub fn writeVerdict(w: *std.Io.Writer, r: anytype) std.Io.Writer.Error!void {
    try w.print("{{\"verdict\":\"{s}\",\"rule\":{f},\"category\":\"{s}\",\"reason\":{f}}}\n", .{
        @tagName(r.verdict), std.json.fmt(r.rule, .{}), @tagName(r.category), std.json.fmt(r.reason, .{}),
    });
}

/// Evaluates one input line and writes its answer line.
pub fn evalLine(gpa: Allocator, io: std.Io, json: bool, line: []const u8, w: *std.Io.Writer) !void {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const parsed: Parsed = if (json) parseAction(a, line) orelse return w.writeAll("{\"error\":\"input\"}\n") else .{
        .action = .{ .kind = .execute, .command = line },
        .scope = corpus_scope,
    };
    const result = l1.evaluate(a, gpa, io, parsed.action, parsed.scope) catch |e| switch (e) {
        error.Throw => return w.writeAll("{\"error\":\"throw\"}\n"),
        error.RelativeScope => return w.writeAll("{\"error\":\"scope\"}\n"),
        error.OutOfMemory => return error.OutOfMemory,
    };
    try writeVerdict(w, result);
}

pub fn run(init: std.process.Init) u8 {
    const args = init.minimal.args.toSlice(init.arena.allocator()) catch return 1;
    const json = args.len > 2 and std.mem.eql(u8, args[2], "--json");
    return loop(init.gpa, init.io, json) catch |e| {
        std.debug.print("harness guard-eval: {t}\n", .{e});
        return 1;
    };
}

fn loop(gpa: Allocator, io: std.Io, json: bool) !u8 {
    const buffer = try gpa.alloc(u8, max_line_bytes);
    defer gpa.free(buffer);
    var reader = std.Io.File.stdin().readerStreaming(io, buffer);
    var out_buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &out_buffer);
    const w = &writer.interface;
    while (true) {
        const line = reader.interface.takeDelimiter('\n') catch |e| switch (e) {
            error.StreamTooLong => {
                _ = reader.interface.discardDelimiterInclusive('\n') catch {};
                try w.writeAll("{\"error\":\"input\"}\n");
                continue;
            },
            error.ReadFailed => return error.ReadFailed,
        } orelse break;
        try evalLine(gpa, io, json, std.mem.trimEnd(u8, line, "\r"), w);
        try w.flush();
    }
    try w.flush();
    return 0;
}

test "guard-eval: a command line becomes one verdict line" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try evalLine(std.testing.allocator, std.testing.io, false, "rm -rf /", &out.writer);
    try evalLine(std.testing.allocator, std.testing.io, false, "ls", &out.writer);
    try std.testing.expectEqualStrings(
        "{\"verdict\":\"deny\",\"rule\":\"rm.outside-root\",\"category\":\"delete\",\"reason\":\"/ is outside or cannot be placed in the task root\"}\n" ++
            "{\"verdict\":\"allow\",\"rule\":null,\"category\":\"read\",\"reason\":\"no rule matched\"}\n",
        out.written(),
    );
}

test "guard-eval: json lines carry an action and an optional scope" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    try evalLine(gpa, io, true, "{\"kind\":\"edit\",\"paths\":[\"/etc/hosts\"]}", &out.writer);
    try evalLine(gpa, io, true, "{\"kind\":\"edit\",\"paths\":[\"/a/b\"],\"scope\":{\"root\":\"/a\",\"home\":\"/h\",\"defaultBranch\":\"x\"}}", &out.writer);
    try evalLine(gpa, io, true, "{\"kind\":\"constructor\",\"paths\":[]}", &out.writer);
    try evalLine(gpa, io, true, "{\"kind\":\"execute\",\"command\":\"constructor a\"}", &out.writer);
    try evalLine(gpa, io, true, "{\"kind\":\"edit\",\"paths\":[\"/a\"],\"scope\":{\"root\":\"a\",\"home\":\"/h\",\"defaultBranch\":\"x\"}}", &out.writer);
    var lines = std.mem.splitScalar(u8, out.written(), '\n');
    try std.testing.expect(std.mem.find(u8, lines.next().?, "\"verdict\":\"deny\"") != null);
    try std.testing.expect(std.mem.find(u8, lines.next().?, "\"verdict\":\"allow\"") != null);
    try std.testing.expectEqualStrings("{\"error\":\"input\"}", lines.next().?);
    try std.testing.expectEqualStrings("{\"error\":\"throw\"}", lines.next().?);
    try std.testing.expectEqualStrings("{\"error\":\"scope\"}", lines.next().?);
}

test "guard-eval: hostile lines never crash" {
    var prng = std.Random.DefaultPrng.init(0x9a11);
    const rand = prng.random();
    var buf: [200]u8 = undefined;
    const alphabet = "'\"`$(){}<>|&;\\ \n\t~*?[]!#=-ab/.\xc3\xa9\xff";
    const gpa = std.testing.allocator;
    var sink: std.Io.Writer.Allocating = .init(gpa);
    defer sink.deinit();
    for (0..3000) |_| {
        const n = rand.uintLessThan(usize, buf.len);
        for (buf[0..n]) |*c| c.* = alphabet[rand.uintLessThan(usize, alphabet.len)];
        sink.clearRetainingCapacity();
        try evalLine(gpa, std.testing.io, false, buf[0..n], &sink.writer);
        try evalLine(gpa, std.testing.io, true, buf[0..n], &sink.writer);
    }
}
