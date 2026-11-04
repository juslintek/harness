//! Brace expansion for plain words, a port of guard/braces.ts. `{a,b}` lists are static; sequences
//! (`{1..3}`) and anything that would need more than `max_words` alternatives stay one word.
const std = @import("std");
const Allocator = std.mem.Allocator;
const lexer = @import("lexer.zig");

const max_words = 64;
const unmatched = std.math.maxInt(usize);

// TS: /^[^\s$`"'\\]*$/. Quotes and substitutions make the text ambiguous, so only plain words are
// expanded.
fn isPlain(word: []const u8) bool {
    for (word, 0..) |c, i| {
        switch (c) {
            '$', '`', '"', '\'', '\\' => return false,
            else => if (lexer.jsSpaceAt(word, i) > 0) return false,
        }
    }
    return true;
}

const Open = struct { pos: usize, close: usize = unmatched, has_comma: bool = false };

// TS rescans from every `{` (groupAt), which is quadratic on `{{{{}}}}`. One pass with a stack finds
// the same partner for every `{`; a comma is at depth 1 of a group exactly when that group is the
// innermost open one.
fn opensOf(scratch: Allocator, word: []const u8) Allocator.Error!std.ArrayList(Open) {
    var opens: std.ArrayList(Open) = .empty;
    errdefer opens.deinit(scratch);
    var stack: std.ArrayList(usize) = .empty;
    defer stack.deinit(scratch);
    for (word, 0..) |c, pos| switch (c) {
        '{' => {
            try stack.append(scratch, opens.items.len);
            try opens.append(scratch, .{ .pos = pos });
        },
        '}' => if (stack.pop()) |k| {
            opens.items[k].close = pos;
        },
        ',' => if (stack.items.len > 0) {
            opens.items[stack.items[stack.items.len - 1]].has_comma = true;
        },
        else => {},
    };
    return opens;
}

const ExpandError = Allocator.Error || error{TooMany};

// The leftmost `{` that has a partner and a depth-1 comma. A `{` with no partner ends the search:
// the word stays as it is.
fn firstList(scratch: Allocator, word: []const u8) Allocator.Error!?Open {
    var opens = try opensOf(scratch, word);
    defer opens.deinit(scratch);
    for (opens.items) |g| {
        if (g.close == unmatched) return null;
        if (g.has_comma) return g;
    }
    return null;
}

fn expand(a: Allocator, scratch: Allocator, word: []const u8, left: *i32, out: *std.ArrayList([]const u8)) ExpandError!void {
    const g = try firstList(scratch, word) orelse return out.append(scratch, word);
    const pre = word[0..g.pos];
    const post = word[g.close + 1 ..];
    var start = g.pos;
    var depth: usize = 0;
    // Every depth-1 comma and the closing brace end one alternative.
    for (word[g.pos .. g.close + 1], g.pos..) |c, pos| {
        if (c == '{') depth += 1;
        if (c == '}') depth -= 1;
        if (!((c == ',' and depth == 1) or pos == g.close)) continue;
        left.* -= 1;
        if (left.* < 0) return error.TooMany;
        const next = try std.mem.concat(a, u8, &.{ pre, word[start + 1 .. pos], post });
        try expand(a, scratch, next, left, out);
        start = pos;
    }
}

/// Appends the expansions of `word` to `out` (a scratch list); the strings live in `a`.
pub fn expandBraces(a: Allocator, scratch: Allocator, word: []const u8, out: *std.ArrayList([]const u8)) Allocator.Error!void {
    if (std.mem.findScalar(u8, word, '{') == null or !isPlain(word)) return out.append(scratch, word);
    const mark = out.items.len;
    var left: i32 = max_words;
    expand(a, scratch, word, &left, out) catch |e| switch (e) {
        error.TooMany => {
            out.shrinkRetainingCapacity(mark);
            return out.append(scratch, word);
        },
        error.OutOfMemory => return error.OutOfMemory,
    };
}

test {
    _ = @import("braces_test.zig");
}
