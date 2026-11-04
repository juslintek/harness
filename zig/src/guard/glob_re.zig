//! The one JS regular expression the guard builds at run time: rules-secret.ts turns a path segment
//! into `^...$` (flag i) after escaping some punctuation and rewriting `*` and `?`. This file runs
//! that exact source text, so unescaped `[`, `]` and `-` keep the meaning they have in JS, and a
//! source JS refuses (unterminated class, reversed range) reports `null` like the caught SyntaxError.
const std = @import("std");
const Allocator = std.mem.Allocator;

const Op = union(enum) {
    lit: u21,
    any,
    star,
    set: []const Range,
};
const Range = struct { lo: u21, hi: u21 };

/// The regex source TS builds from `pattern`.
fn source(a: Allocator, pattern: []const u8) Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);
    for (pattern) |c| switch (c) {
        '.', '+', '^', '$', '{', '}', '(', ')', '|', '\\' => try out.appendSlice(a, &.{ '\\', c }),
        '*' => try out.appendSlice(a, ".*"),
        '?' => try out.append(a, '.'),
        else => try out.append(a, c),
    };
    return out.toOwnedSlice(a);
}

const Cursor = struct {
    s: []const u8,
    i: usize = 0,

    fn next(self: *Cursor) ?u21 {
        if (self.i >= self.s.len) return null;
        const l = std.unicode.utf8ByteSequenceLength(self.s[self.i]) catch 1;
        const end = @min(self.i + l, self.s.len);
        const cp = std.unicode.utf8Decode(self.s[self.i..end]) catch self.s[self.i];
        self.i = end;
        return cp;
    }
};

const Syntax = error{Syntax};

fn parseSet(a: Allocator, cur: *Cursor, ops: *std.ArrayList(Op)) (Allocator.Error || Syntax)!void {
    var ranges: std.ArrayList(Range) = .empty;
    errdefer ranges.deinit(a);
    var pending: ?u21 = null;
    var dash = false;
    while (true) {
        var cp = cur.next() orelse return error.Syntax;
        if (cp == ']') break;
        if (cp == '-' and pending != null and !dash) {
            // A dash right before `]` is a literal dash, so decide on the next code point.
            if (cur.i < cur.s.len and cur.s[cur.i] != ']') {
                dash = true;
                continue;
            }
        }
        if (cp == '\\') cp = cur.next() orelse return error.Syntax;
        if (dash) {
            const lo = pending.?;
            if (lo > cp) return error.Syntax;
            try ranges.append(a, .{ .lo = lo, .hi = cp });
            pending = null;
            dash = false;
        } else {
            if (pending) |p| try ranges.append(a, .{ .lo = p, .hi = p });
            pending = cp;
        }
    }
    if (pending) |p| try ranges.append(a, .{ .lo = p, .hi = p });
    try ops.append(a, .{ .set = try ranges.toOwnedSlice(a) });
}

fn compile(a: Allocator, src: []const u8) (Allocator.Error || Syntax)![]Op {
    var ops: std.ArrayList(Op) = .empty;
    errdefer ops.deinit(a);
    var cur: Cursor = .{ .s = src };
    while (cur.next()) |cp| switch (cp) {
        '\\' => try ops.append(a, .{ .lit = cur.next() orelse return error.Syntax }),
        '[' => try parseSet(a, &cur, &ops),
        '.' => if (cur.i < src.len and src[cur.i] == '*') {
            cur.i += 1;
            try ops.append(a, .star);
        } else try ops.append(a, .any),
        else => try ops.append(a, .{ .lit = cp }),
    };
    return ops.toOwnedSlice(a);
}

fn isLineTerminator(cp: u21) bool {
    return cp == '\n' or cp == '\r' or cp == 0x2028 or cp == 0x2029;
}

fn lower(cp: u21) u21 {
    return if (cp < 128) std.ascii.toLower(@intCast(cp)) else cp;
}

fn upper(cp: u21) u21 {
    return if (cp < 128) std.ascii.toUpper(@intCast(cp)) else cp;
}

fn inSet(ranges: []const Range, cp: u21) bool {
    for (ranges) |r| {
        for ([_]u21{ cp, lower(cp), upper(cp) }) |c| if (c >= r.lo and c <= r.hi) return true;
    }
    return false;
}

fn one(op: Op, cp: u21) bool {
    return switch (op) {
        .lit => |l| l == cp or (l < 128 and cp < 128 and lower(l) == lower(cp)),
        .any => !isLineTerminator(cp),
        .set => |r| inSet(r, cp),
        .star => unreachable,
    };
}

/// Wildcard matching with one backtrack point, the usual linear-space glob walk.
fn run(ops: []const Op, text: []const u21) bool {
    var o: usize = 0;
    var t: usize = 0;
    var star_op: ?usize = null;
    var star_t: usize = 0;
    while (t < text.len) {
        if (o < ops.len and ops[o] == .star) {
            star_op = o;
            star_t = t;
            o += 1;
        } else if (o < ops.len and one(ops[o], text[t])) {
            o += 1;
            t += 1;
        } else if (star_op) |s| {
            if (isLineTerminator(text[star_t])) return false;
            star_t += 1;
            t = star_t;
            o = s + 1;
        } else return false;
    }
    while (o < ops.len and ops[o] == .star) o += 1;
    return o == ops.len;
}

/// `new RegExp(source(pattern), "i").test(literal)`; null when the constructor would throw.
pub fn matches(gpa: Allocator, pattern: []const u8, literal: []const u8) Allocator.Error!?bool {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const ops = compile(a, try source(a, pattern)) catch |e| switch (e) {
        error.Syntax => return null,
        error.OutOfMemory => return error.OutOfMemory,
    };
    var text: std.ArrayList(u21) = .empty;
    var cur: Cursor = .{ .s = literal };
    while (cur.next()) |cp| try text.append(a, cp);
    return run(ops, text.items);
}
