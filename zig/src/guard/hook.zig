//! The Claude PreToolUse hook: hook JSON in, a decision out. Port of scripts/guard-hook.ts. Claude
//! treats every exit code except 2 as a non-blocking hook error, so each failure path here is a deny.
const std = @import("std");
const Allocator = std.mem.Allocator;
const core = @import("rules_core.zig");
const hook_http = @import("hook_http.zig");
const l1 = @import("l1.zig");

pub const max_input_bytes: usize = 32 * 1024 * 1024;
const max_string_bytes: usize = 16 * 1024 * 1024;
/// No real path is longer than PATH_MAX; a longer one is refused so that the glob matching of
/// credential locations stays bounded.
const max_path_bytes: usize = 64 * 1024;

pub const Input = struct {
    tool_name: []const u8,
    command: ?[]const u8 = null,
    file_path: ?[]const u8 = null,
    path: ?[]const u8 = null,
    notebook_path: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
};

pub const ParseError = error{InvalidJson} || error{InvalidInput} || Allocator.Error;

const Walker = struct {
    sc: std.json.Scanner,
    a: Allocator,

    fn fail(e: anyerror) ParseError {
        return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidJson;
    }

    fn peek(self: *Walker) ParseError!std.json.TokenType {
        return self.sc.peekNextTokenType() catch |e| fail(e);
    }

    fn skip(self: *Walker) ParseError!void {
        self.sc.skipValue() catch |e| return fail(e);
    }

    fn text(self: *Walker) ParseError![]const u8 {
        const tok = self.sc.nextAllocMax(self.a, .alloc_if_needed, max_string_bytes) catch |e| return fail(e);
        return switch (tok) {
            .string => |s| s,
            .allocated_string => |s| s,
            else => error.InvalidJson,
        };
    }

    /// The string at the cursor, or null (the value is consumed) when it is anything else.
    fn optString(self: *Walker) ParseError!?[]const u8 {
        if (try self.peek() != .string) {
            try self.skip();
            return null;
        }
        return try self.text();
    }

    /// The next object key, or null at the closing brace.
    fn key(self: *Walker) ParseError!?[]const u8 {
        if (try self.peek() == .object_end) {
            _ = self.sc.next() catch |e| return fail(e);
            return null;
        }
        return try self.text();
    }
};

const CwdState = enum { absent, string, bad };

/// What guard-hook.ts reads from `HookInput`: a JSON object with a string `tool_name`, an object
/// `tool_input` and an optional string `cwd`. Duplicate keys: the last one wins, as in JSON.parse.
/// The walk is iterative, so nesting depth cannot overflow the stack.
pub fn parseInput(a: Allocator, bytes: []const u8) ParseError!Input {
    if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidJson;
    var w: Walker = .{ .sc = std.json.Scanner.initCompleteInput(a, bytes), .a = a };
    defer w.sc.deinit();
    if (try w.peek() != .object_begin) {
        try w.skip();
        return error.InvalidInput;
    }
    _ = w.sc.next() catch |e| return Walker.fail(e);
    var in: Input = .{ .tool_name = "" };
    var have_name = false;
    var have_input = false;
    var cwd_state: CwdState = .absent;
    while (try w.key()) |k| {
        if (std.mem.eql(u8, k, "tool_name")) {
            const v = try w.optString();
            have_name = v != null;
            in.tool_name = v orelse "";
        } else if (std.mem.eql(u8, k, "cwd")) {
            const v = try w.optString();
            cwd_state = if (v == null) .bad else .string;
            in.cwd = v;
        } else if (std.mem.eql(u8, k, "tool_input")) {
            have_input = try toolInput(&w, &in);
        } else try w.skip();
    }
    const end = w.sc.next() catch |e| return Walker.fail(e);
    if (end != .end_of_document) return error.InvalidJson;
    if (!have_name or !have_input or cwd_state == .bad) return error.InvalidInput;
    for ([_]?[]const u8{ in.file_path, in.path, in.notebook_path, in.cwd }) |p| {
        if (p) |text| if (text.len > max_path_bytes) return error.InvalidInput;
    }
    return in;
}

/// Reads the `tool_input` object into `in`; false when the value is not an object.
fn toolInput(w: *Walker, in: *Input) ParseError!bool {
    in.command = null;
    in.file_path = null;
    in.path = null;
    in.notebook_path = null;
    if (try w.peek() != .object_begin) {
        try w.skip();
        return false;
    }
    _ = w.sc.next() catch |e| return Walker.fail(e);
    while (try w.key()) |k| {
        if (std.mem.eql(u8, k, "command")) {
            in.command = try w.optString();
        } else if (std.mem.eql(u8, k, "file_path")) {
            in.file_path = try w.optString();
        } else if (std.mem.eql(u8, k, "path")) {
            in.path = try w.optString();
        } else if (std.mem.eql(u8, k, "notebook_path")) {
            in.notebook_path = try w.optString();
        } else try w.skip();
    }
    return true;
}

/// TS `str`: only a non-empty string counts.
fn nonEmpty(v: ?[]const u8) ?[]const u8 {
    const s = v orelse return null;
    return if (s.len == 0) null else s;
}

fn isOneOf(s: []const u8, comptime names: []const []const u8) bool {
    return core.oneOf(s, names);
}

/// A relative `cwd` or none at all means the hook's own working directory, as `process.cwd()`.
const Dir = struct { given: []const u8, abs: []const u8 };

fn workingDir(a: Allocator, io: std.Io, cwd: ?[]const u8) !Dir {
    if (nonEmpty(cwd)) |c| {
        if (core.isAbs(c)) return .{ .given = c, .abs = c };
        const here = try std.process.currentPathAlloc(io, a);
        return .{ .given = c, .abs = try core.resolve(a, here, c) };
    }
    const here = try std.process.currentPathAlloc(io, a);
    return .{ .given = here, .abs = here };
}

fn absolute(a: Allocator, cwd: []const u8, p: []const u8) Allocator.Error![]const u8 {
    return if (std.mem.startsWith(u8, p, "~")) p else core.resolve(a, cwd, p);
}

// With no path named the default is `cwd` itself, resolved against `cwd` again like TS does, so a
// relative cwd ends up under itself.
fn paths(a: Allocator, dir: Dir, found: []const ?[]const u8) Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    for (found) |f| if (nonEmpty(f)) |p| try out.append(a, try absolute(a, dir.abs, p));
    if (out.items.len == 0) try out.append(a, try absolute(a, dir.abs, dir.given));
    return out.items;
}

/// guard-hook.ts toAction.
pub fn toAction(a: Allocator, io: std.Io, in: Input) !l1.Action {
    const tool = in.tool_name;
    const dir = try workingDir(a, io, in.cwd);
    if (std.mem.eql(u8, tool, "Bash")) return .{ .kind = .execute, .command = nonEmpty(in.command) };
    if (isOneOf(tool, &.{ "Read", "Glob", "Grep" })) {
        return .{ .kind = .read, .paths = try paths(a, dir, &.{ in.file_path, in.path }) };
    }
    if (isOneOf(tool, &.{ "Write", "Edit", "MultiEdit", "NotebookEdit" })) {
        return .{ .kind = .edit, .paths = try paths(a, dir, &.{ in.file_path, in.notebook_path }) };
    }
    if (isOneOf(tool, &.{ "WebFetch", "WebSearch" })) return .{ .kind = .fetch };
    return .{ .kind = .other };
}

pub const Report = struct {
    verdict: core.Verdict,
    rule: ?[]const u8,
    command: []const u8,
};

pub const Decision = struct {
    exit: u8,
    stdout: []const u8 = "",
    stderr: []const u8 = "",
    report: ?Report = null,
};

const ask_output = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\"}}\n";

fn envValue(env: *const std.process.Environ.Map, name: []const u8) ?[]const u8 {
    const v = env.get(name) orelse return null;
    return if (v.len == 0) null else v;
}

fn closed(a: Allocator, comptime f: []const u8, args: anytype) Decision {
    const msg = std.fmt.allocPrint(a, "harness guard: " ++ f ++ "\n", args) catch "harness guard: out of memory\n";
    return .{ .exit = 2, .stderr = msg };
}

/// Every error is a deny. `a` owns the strings in the decision.
pub fn decide(a: Allocator, gpa: Allocator, io: std.Io, env: *const std.process.Environ.Map, stdin: []const u8) Decision {
    const root = envValue(env, "HARNESS_SCOPE_ROOT");
    const home = envValue(env, "HOME");
    if (root == null or home == null) return closed(a, "HARNESS_SCOPE_ROOT or HOME is not set", .{});
    const in = parseInput(a, stdin) catch |e| return switch (e) {
        error.InvalidJson => closed(a, "hook input is not valid JSON", .{}),
        error.InvalidInput => closed(a, "hook input needs tool_name and tool_input", .{}),
        error.OutOfMemory => closed(a, "out of memory", .{}),
    };
    const action = toAction(a, io, in) catch |e| return closed(a, "{t}", .{e});
    const scope: l1.Scope = .{
        .root = root.?,
        .home = home.?,
        // TS: process.env.HARNESS_DEFAULT_BRANCH ?? "main"; an empty value stays empty.
        .default_branch = env.get("HARNESS_DEFAULT_BRANCH") orelse "main",
    };
    const result = l1.evaluate(a, gpa, io, action, scope) catch |e| return closed(a, "{t}", .{e});
    const command = action.command orelse std.mem.join(a, " ", action.paths) catch return closed(a, "out of memory", .{});
    const report: Report = .{ .verdict = result.verdict, .rule = result.rule, .command = command };
    return switch (result.verdict) {
        .deny => .{ .exit = 2, .stderr = std.fmt.allocPrint(a, "harness guard: {s}\n", .{result.reason}) catch "harness guard: denied\n", .report = report },
        .ask => .{ .exit = 0, .stdout = ask_output, .report = report },
        .allow => .{ .exit = 0, .report = report },
    };
}

/// The telemetry body guard-hook.ts posts: `runId` is left out when HARNESS_RUN_ID is unset.
pub fn reportBody(a: Allocator, run_id: ?[]const u8, r: Report) Allocator.Error![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    const w = &out.writer;
    w.writeAll("{") catch return error.OutOfMemory;
    if (run_id) |id| w.print("\"runId\":{f},", .{std.json.fmt(id, .{})}) catch return error.OutOfMemory;
    w.print("\"verdict\":\"{s}\",\"rule\":{f},\"command\":{f}}}", .{
        @tagName(r.verdict), std.json.fmt(r.rule, .{}), std.json.fmt(r.command, .{}),
    }) catch return error.OutOfMemory;
    return out.written();
}

/// Best effort: nothing in here changes the decision.
pub fn sendReport(a: Allocator, io: std.Io, env: *const std.process.Environ.Map, r: Report) void {
    const url = env.get("HARNESS_HOOK_URL") orelse return;
    if (url.len == 0) return;
    const body = reportBody(a, env.get("HARNESS_RUN_ID"), r) catch return;
    hook_http.run(io, url, env.get("HARNESS_RUN_TOKEN") orelse "", body);
}

test {
    _ = @import("hook_test.zig");
}
