//! Shell lexer for the guard, a port of code/src/server/features/guard/lexer.ts. It works on UTF-8
//! bytes where TS works on UTF-16 units; every character the lexer reacts to is ASCII, so indices
//! differ but results do not. Where the length of text is limited the limit counts UTF-16 units.
const std = @import("std");
const scan = @import("lexer_scan.zig");
const Heredoc = scan.Heredoc;

pub const Error = scan.Error;
pub const Ctx = scan.Ctx;
pub const max_nest = scan.max_nest;
pub const max_work_bytes = scan.max_work_bytes;
pub const max_resolves = scan.max_resolves;
pub const utf16Len = scan.utf16Len;
pub const jsSpaceAt = scan.jsSpaceAt;

pub const Tok = struct {
    kind: enum { word, op },
    v: []const u8,
    /// Inner text of each substitution in a word; slices of the lexed source.
    subs: []const []const u8 = &.{},
};

const Lexer = struct {
    ctx: *Ctx,
    src: []const u8,
    i: usize = 0,
    word: std.ArrayList(u8) = .empty,
    in_word: bool = false,
    toks: std.ArrayList(Tok) = .empty,
    word_subs: std.ArrayList([]const u8) = .empty,
    heredocs: std.ArrayList(Heredoc) = .empty,

    fn deinitLists(lx: *Lexer) void {
        const a = lx.ctx.scratch;
        lx.word.deinit(a);
        lx.word_subs.deinit(a);
        lx.heredocs.deinit(a);
    }

    fn flush(lx: *Lexer) Error!void {
        const ctx = lx.ctx;
        if (lx.in_word) {
            const v = try ctx.arena.dupe(u8, lx.word.items);
            const subs = try ctx.arena.dupe([]const u8, lx.word_subs.items);
            try lx.toks.append(ctx.scratch, .{ .kind = .word, .v = v, .subs = subs });
        }
        lx.word_subs.clearRetainingCapacity();
        lx.word.clearRetainingCapacity();
        lx.in_word = false;
    }

    fn pushOp(lx: *Lexer, v: []const u8, width: usize) Error!void {
        try lx.flush();
        try lx.toks.append(lx.ctx.scratch, .{ .kind = .op, .v = v });
        lx.i += width;
    }

    fn append(lx: *Lexer, bytes: []const u8) Error!void {
        try lx.word.appendSlice(lx.ctx.scratch, bytes);
        lx.in_word = true;
    }

    fn literal(lx: *Lexer) Error!void {
        try lx.append(lx.src[lx.i..][0..1]);
        lx.i += 1;
    }

    // The substituted text is kept verbatim in the word so a later `eval` / `sh -c` re-parse sees it.
    fn readSubst(lx: *Lexer, open: []const u8) Error!void {
        const start = lx.i + open.len;
        const backtick = open[0] == '`';
        const end = if (backtick) try scan.closeBacktick(lx.ctx, lx.src, start) else try scan.closeParen(lx.ctx, lx.src, start);
        const inner = lx.src[start..end];
        try lx.word_subs.append(lx.ctx.scratch, inner);
        try lx.append(open);
        try lx.append(inner);
        try lx.append(if (backtick) "`" else ")");
        lx.i = end + 1;
    }

    fn readSingle(lx: *Lexer) Error!void {
        const end = std.mem.findScalarPos(u8, lx.src, lx.i + 1, '\'') orelse
            return lx.ctx.fail("unterminated single quote");
        try lx.append(lx.src[lx.i + 1 .. end]);
        lx.i = end + 1;
    }

    fn doubleEscape(lx: *Lexer) Error!void {
        const next: ?u8 = if (lx.i + 1 < lx.src.len) lx.src[lx.i + 1] else null;
        if (next) |n| {
            if (std.mem.findScalar(u8, "$`\"\\", n) != null) {
                try lx.append(&.{n});
                lx.i += 2;
                return;
            }
            if (n == '\n') {
                lx.i += 2;
                return;
            }
        }
        try lx.literal();
    }

    fn readDouble(lx: *Lexer) Error!void {
        lx.in_word = true;
        lx.i += 1;
        while (lx.i < lx.src.len) {
            const c = lx.src[lx.i];
            if (c == '"') {
                lx.i += 1;
                return;
            }
            if (std.mem.startsWith(u8, lx.src[lx.i..], "$(")) {
                try lx.readSubst("$(");
            } else if (c == '`') {
                try lx.readSubst("`");
            } else if (c == '\\') {
                try lx.doubleEscape();
            } else try lx.literal();
        }
        return lx.ctx.fail("unterminated double quote");
    }

    fn digitsAt(s: []const u8) usize {
        var n: usize = 0;
        while (n < s.len and std.ascii.isDigit(s[n])) n += 1;
        return n;
    }

    fn readRedirect(lx: *Lexer) Error!void {
        const w = lx.word.items;
        if (lx.in_word and w.len > 0 and digitsAt(w) == w.len) {
            lx.word.clearRetainingCapacity();
            lx.in_word = false;
        } else try lx.flush();
        lx.i += 1;
        const rest = lx.src[@min(lx.i, lx.src.len)..];
        if (rest.len > 0 and (rest[0] == '>' or rest[0] == '|')) {
            lx.i += 1;
        } else if (rest.len > 0 and rest[0] == '&') {
            lx.i += 1;
            const after = lx.src[lx.i..];
            const fd = digitsAt(after);
            if (fd > 0) {
                lx.i += fd;
                return;
            }
            if (after.len > 0 and after[0] == '-') {
                lx.i += 1;
                return;
            }
        }
        try lx.toks.append(lx.ctx.scratch, .{ .kind = .op, .v = ">" });
    }

    fn at(lx: *Lexer, prefix: []const u8) bool {
        return std.mem.startsWith(u8, lx.src[lx.i..], prefix);
    }

    fn opAmp(lx: *Lexer) Error!void {
        if (lx.at("&&")) {
            try lx.pushOp("&&", 2);
        } else if (lx.at("&>")) {
            lx.i += 1;
            try lx.readRedirect();
        } else try lx.pushOp("&", 1);
    }

    fn opPipe(lx: *Lexer) Error!void {
        if (lx.at("||")) {
            try lx.pushOp("||", 2);
        } else if (lx.at("|&")) {
            try lx.pushOp("|", 2);
        } else try lx.pushOp("|", 1);
    }

    fn opLess(lx: *Lexer) Error!void {
        if (lx.at("<(") and !lx.in_word) {
            try lx.readSubst("<(");
        } else if (lx.at("<<<")) {
            try lx.pushOp("<<<", 3);
        } else if (lx.at("<<")) {
            try lx.quotedHeredoc();
        } else try lx.pushOp("<", 1);
    }

    // `cat <<'EOF'` reads static text: model it as a here-string so shells still ask and `cat` does not.
    fn quotedHeredoc(lx: *Lexer) Error!void {
        const m = scan.matchHeredoc(lx.src, lx.i) orelse return lx.ctx.fail("heredoc");
        try lx.heredocs.append(lx.ctx.scratch, .{ .delim = m.delim, .strip = m.strip });
        try lx.flush();
        try lx.toks.append(lx.ctx.scratch, .{ .kind = .op, .v = "<<<" });
        try lx.toks.append(lx.ctx.scratch, .{ .kind = .word, .v = "" });
        lx.i += m.len;
    }

    fn newline(lx: *Lexer) Error!void {
        try lx.pushOp(";", 1);
        for (lx.heredocs.items) |d| lx.i = try scan.skipBody(lx.ctx, lx.src, lx.i, d);
        lx.heredocs.clearRetainingCapacity();
    }

    fn opGreater(lx: *Lexer) Error!void {
        if (lx.at(">(") and !lx.in_word) {
            try lx.readSubst(">(");
        } else try lx.readRedirect();
    }

    fn backslash(lx: *Lexer) Error!void {
        if (lx.i + 1 < lx.src.len and lx.src[lx.i + 1] != '\n') try lx.append(lx.src[lx.i + 1 ..][0..1]);
        lx.i += 2;
    }

    fn readBraceVar(lx: *Lexer) Error!void {
        const end = std.mem.findScalarPos(u8, lx.src, lx.i, '}') orelse
            return lx.ctx.fail("unterminated ${");
        try lx.append(lx.src[lx.i .. end + 1]);
        lx.i = end + 1;
    }

    fn dollar(lx: *Lexer) Error!void {
        if (lx.at("$(")) {
            try lx.readSubst("$(");
        } else if (lx.at("${")) {
            try lx.readBraceVar();
        } else try lx.literal();
    }

    fn hash(lx: *Lexer) Error!void {
        if (lx.in_word) return lx.literal();
        lx.i = std.mem.findScalarPos(u8, lx.src, lx.i, '\n') orelse lx.src.len;
    }

    fn step(lx: *Lexer) Error!void {
        switch (lx.src[lx.i]) {
            ' ', '\t' => {
                try lx.flush();
                lx.i += 1;
            },
            '\n' => try lx.newline(),
            ';' => try lx.pushOp(";", if (lx.at(";;")) 2 else 1),
            '(' => try lx.pushOp("(", 1),
            ')' => try lx.pushOp(")", 1),
            '\\' => try lx.backslash(),
            '\'' => try lx.readSingle(),
            '"' => try lx.readDouble(),
            '`' => try lx.readSubst("`"),
            '$' => try lx.dollar(),
            '#' => try lx.hash(),
            '&' => try lx.opAmp(),
            '|' => try lx.opPipe(),
            '<' => try lx.opLess(),
            '>' => try lx.opGreater(),
            else => try lx.literal(),
        }
    }
};

/// Tokens of `src`. Words are copied into `ctx.arena`; the returned list lives in `ctx.scratch` and
/// the caller deinitializes it there.
pub fn lex(ctx: *Ctx, src: []const u8) Error!std.ArrayList(Tok) {
    var lx: Lexer = .{ .ctx = ctx, .src = src };
    defer lx.deinitLists();
    errdefer lx.toks.deinit(ctx.scratch);
    while (lx.i < src.len) try lx.step();
    try lx.flush();
    if (lx.heredocs.items.len > 0) return ctx.fail("unterminated heredoc");
    return lx.toks;
}

test {
    _ = @import("shell.zig");
    _ = @import("shell_fixtures_test.zig");
}
