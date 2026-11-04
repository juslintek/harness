//! Scanning helpers under the lexer: the shared parse context, UTF-16 and white space rules of JS,
//! and the skippers that find where a substitution, quote or heredoc body ends.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Error = error{ ShellParse, OutOfMemory };

/// Nesting of `$(` inside `"` inside `$(`, and of resolve calls. TS recurses without a limit there
/// and overflows the JS stack; this keeps the native stack bounded.
pub const max_nest = 256;
/// Total bytes lexed over one parse including re-parses of inner scripts. TS has no such limit; it
/// stops the quadratic-looking blowup of nested `eval` and `$(...)` copies on hostile input.
pub const max_work_bytes: usize = 1_000_000;
/// Total statements resolved over one parse. TS has no limit, and `find a b c -exec find {} ...`
/// nests multiplicatively there.
pub const max_resolves: u32 = 200_000;
/// Work spent copying words (their bytes plus 16 per word) over one parse. TS has no limit; without
/// one, `find a b c ... -delete -delete ...` builds a copy of every start path per `-delete`.
pub const max_word_work: usize = 8_000_000;

/// State shared by every module for one parse. `arena` owns everything in the result; `scratch`
/// holds temporary lists and is always balanced by defer.
pub const Ctx = struct {
    arena: Allocator,
    scratch: Allocator,
    reason: []const u8 = "",
    reason_buf: [64]u8 = undefined,
    nest: u32 = 0,
    bytes_left: usize = max_work_bytes,
    resolves_left: u32 = max_resolves,
    word_work_left: usize = max_word_work,

    pub fn fail(self: *Ctx, reason: []const u8) error{ShellParse} {
        self.reason = reason;
        return error.ShellParse;
    }

    /// `name` is a wrapper table key, so the message always fits the buffer.
    pub fn failChdir(self: *Ctx, name: []const u8) error{ShellParse} {
        self.reason = std.fmt.bufPrint(&self.reason_buf, "{s} changes the working directory", .{name}) catch "too complex";
        return error.ShellParse;
    }

    /// Charges the cost of copying `words`.
    pub fn chargeWords(self: *Ctx, words: []const []const u8) error{ShellParse}!void {
        var cost: usize = 16 * words.len;
        for (words) |w| cost += w.len;
        if (cost > self.word_work_left) return self.fail("too complex");
        self.word_work_left -= cost;
    }

    pub fn enter(self: *Ctx) error{ShellParse}!void {
        self.nest += 1;
        if (self.nest > max_nest) {
            self.nest -= 1;
            return self.fail("too complex");
        }
    }

    pub fn leave(self: *Ctx) void {
        self.nest -= 1;
    }
};

pub const Heredoc = struct { delim: []const u8, strip: bool };

fn seqLen(b: u8) usize {
    return std.unicode.utf8ByteSequenceLength(b) catch 1;
}

/// Length in UTF-16 units, as JS `String.length` for the same text.
pub fn utf16Len(s: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const l = seqLen(s[i]);
        n += if (l == 4) 2 else 1;
        i += @min(l, s.len - i);
    }
    return n;
}

fn windowEnd(s: []const u8, from: usize, units: usize) usize {
    var p = from;
    var n: usize = 0;
    while (p < s.len) {
        const l = seqLen(s[p]);
        const u: usize = if (l == 4) 2 else 1;
        if (n + u > units) break;
        n += u;
        p += @min(l, s.len - p);
    }
    return p;
}

/// Byte length of the JS `\s` character at `s[i]`, or 0 when it is not white space.
pub fn jsSpaceAt(s: []const u8, i: usize) usize {
    switch (s[i]) {
        ' ', '\t', '\n', 0x0b, 0x0c, '\r' => return 1,
        0x80...0xff => {},
        else => return 0,
    }
    const l = seqLen(s[i]);
    if (l < 2 or i + l > s.len) return 0;
    const cp = std.unicode.utf8Decode(s[i..][0..l]) catch return 0;
    return switch (cp) {
        0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => l,
        else => 0,
    };
}

pub const HeredocMatch = struct { delim: []const u8, strip: bool, len: usize };

// TS: /^<<(-?)[ \t]*(['"])([^'"\n]+)\2/ applied to src.slice(i, i + 200). Only a quoted delimiter
// makes the body static text; an unquoted one expands substitutions.
pub fn matchHeredoc(src: []const u8, i: usize) ?HeredocMatch {
    const w = src[i..windowEnd(src, i, 200)];
    if (!std.mem.startsWith(u8, w, "<<")) return null;
    var p: usize = 2;
    const strip = p < w.len and w[p] == '-';
    if (strip) p += 1;
    while (p < w.len and (w[p] == ' ' or w[p] == '\t')) p += 1;
    if (p >= w.len or (w[p] != '\'' and w[p] != '"')) return null;
    const q = w[p];
    p += 1;
    const start = p;
    while (p < w.len and w[p] != '\'' and w[p] != '"' and w[p] != '\n') p += 1;
    if (p == start or p >= w.len or w[p] != q) return null;
    return .{ .delim = w[start..p], .strip = strip, .len = p + 1 };
}

pub fn skipBody(ctx: *Ctx, src: []const u8, from: usize, doc: Heredoc) Error!usize {
    var i = from;
    while (i < src.len) {
        const nl = std.mem.findScalarPos(u8, src, i, '\n');
        var line = src[i .. nl orelse src.len];
        i = if (nl) |n| n + 1 else src.len;
        if (doc.strip) line = std.mem.trimStart(u8, line, "\t");
        if (std.mem.eql(u8, line, doc.delim)) return i;
    }
    return ctx.fail("unterminated heredoc");
}

fn skipDouble(ctx: *Ctx, src: []const u8, from: usize) Error!usize {
    var i = from;
    while (i < src.len) : (i += 1) {
        if (src[i] == '\\') {
            i += 1;
        } else if (std.mem.startsWith(u8, src[i..], "$(")) {
            i = try closeParen(ctx, src, i + 2);
        } else if (src[i] == '"') return i;
    }
    return ctx.fail("unterminated double quote");
}

// Jumps over quotes, escapes and heredoc bodies; returns i unchanged for any other character.
fn skipOpaque(ctx: *Ctx, src: []const u8, i: usize, pending: *std.ArrayList(Heredoc)) Error!usize {
    switch (src[i]) {
        '<' => {
            const m = matchHeredoc(src, i) orelse return i;
            try pending.append(ctx.scratch, .{ .delim = m.delim, .strip = m.strip });
            return i + m.len - 1;
        },
        '\\' => return i + 1,
        // TS: src.indexOf("'", i + 1) returns -1 here and the caller's loop then restarts at 0 and
        // never ends. An unterminated quote is a parse error.
        '\'' => return std.mem.findScalarPos(u8, src, i + 1, '\'') orelse
            ctx.fail("unterminated substitution"),
        '"' => return skipDouble(ctx, src, i + 1),
        '\n' => {
            var end = i;
            for (pending.items) |d| end = try skipBody(ctx, src, end + 1, d) - 1;
            pending.clearRetainingCapacity();
            return end;
        },
        else => return i,
    }
}

pub fn closeParen(ctx: *Ctx, src: []const u8, from: usize) Error!usize {
    try ctx.enter();
    defer ctx.leave();
    var depth: usize = 1;
    var pending: std.ArrayList(Heredoc) = .empty;
    defer pending.deinit(ctx.scratch);
    var i = from;
    while (i < src.len) : (i += 1) {
        const next = try skipOpaque(ctx, src, i, &pending);
        if (next != i) {
            i = next;
        } else if (src[i] == '(') {
            depth += 1;
        } else if (src[i] == ')') {
            depth -= 1;
            if (depth == 0) return i;
        }
    }
    return ctx.fail("unterminated substitution");
}

pub fn closeBacktick(ctx: *Ctx, src: []const u8, from: usize) Error!usize {
    var i = from;
    while (i < src.len) : (i += 1) {
        if (src[i] == '\\') {
            i += 1;
        } else if (src[i] == '`') return i;
    }
    return ctx.fail("unterminated backtick");
}
