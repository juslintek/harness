//! Port of code/src/server/features/logs/redact.ts. Zig has no regex library, so the rules keep
//! their JavaScript source text and run through the small backtracking matcher below. It
//! supports exactly the syntax those rules use: literals, `[...]` classes with ranges and the
//! `\s \S \w \W` escapes, `\b`, `$`, `(...)`, `(?:...)`, `(?!...)`, alternation, `* + ? {n} {n,}
//! {n,m}` (lazy with a trailing `?`; a quantifier on a group may only be `?`). It works on UTF-8
//! code points, with JS `\s` and ASCII-only `\w`, `\b` and `/i` folding as in a non-unicode
//! JS regex. Input is expected to be valid UTF-8.
const std = @import("std");

const Allocator = std.mem.Allocator;

const secret_words = "password|passwd|secret|token|api[_-]?key|access[_-]?key";

const Rule = struct { pattern: []const u8, replacement: []const u8, icase: bool = false };

const rules = [_]Rule{
    .{ .pattern = "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", .replacement = "[REDACTED:private-key]" },
    .{ .pattern = "\\bsk-ant-[A-Za-z0-9_-]{8,}", .replacement = "[REDACTED:anthropic-key]" },
    .{ .pattern = "\\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}", .replacement = "[REDACTED:openai-key]" },
    .{ .pattern = "\\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})", .replacement = "[REDACTED:github-token]" },
    .{ .pattern = "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b", .replacement = "[REDACTED:aws-key]" },
    .{ .pattern = "\\bxox[abprs]-[A-Za-z0-9-]{10,}", .replacement = "[REDACTED:slack-token]" },
    .{ .pattern = "\\bAIza[0-9A-Za-z_-]{35}", .replacement = "[REDACTED:google-key]" },
    .{ .pattern = "\\b[sr]k_live_[A-Za-z0-9]{16,}", .replacement = "[REDACTED:stripe-key]" },
    .{ .pattern = "\\bnpm_[A-Za-z0-9]{36}\\b", .replacement = "[REDACTED:npm-token]" },
    .{ .pattern = "\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}", .replacement = "[REDACTED:jwt]" },
    .{ .pattern = "\\bbearer\\s+[A-Za-z0-9._~+/=-]{8,}", .replacement = "[REDACTED:bearer]", .icase = true },
    .{ .pattern = "(authorization[\"']?\\s*[:=]\\s*[\"']?)basic\\s+[A-Za-z0-9+/=]{8,}", .replacement = "$1[REDACTED:basic-auth]", .icase = true },
    .{ .pattern = "(\\b[a-z][a-z0-9+.-]*:\\/\\/)[^\\s/@:]+:[^\\s/@]+@", .replacement = "$1[REDACTED:url-credentials]@", .icase = true },
    .{ .pattern = "(--(?:" ++ secret_words ++ ")[=\\s]+)(?!\\[REDACTED)(\"[^\"]*\"|'[^']*'|[^\\s\"']+)", .replacement = "$1[REDACTED:secret]", .icase = true },
    .{ .pattern = "([\"']?\\b[\\w-]*(?:" ++ secret_words ++ ")[\"']?\\s*[:=]\\s*)(?!\\[REDACTED)(\"[^\"]*\"|'[^']*'|[^\\s\"',;&}]+)", .replacement = "$1[REDACTED:secret]", .icase = true },
};

// AWS secret keys have no fixed prefix, so they are only caught right after an access key id.
const aws_secret = Rule{
    .pattern = "(\\[REDACTED:aws-key\\][\\s:=,\"']*)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])",
    .replacement = "$1[REDACTED:aws-secret]",
};

/// Returns a copy of `text` with secrets replaced; the caller frees it.
pub fn redactSecrets(gpa: Allocator, text: []const u8) Allocator.Error![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var current = try gpa.dupe(u8, text);
    errdefer gpa.free(current);
    for (rules ++ [_]Rule{aws_secret}) |rule| {
        const re = compile(arena.allocator(), rule.pattern, rule.icase) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.BadPattern => unreachable,
        };
        const next = try replaceAll(gpa, re, rule.replacement, current);
        gpa.free(current);
        current = next;
    }
    return current;
}

// ---- matcher ----

const ClassItem = union(enum) { range: [2]u21, space, not_space, word, not_word };
const Atom = union(enum) {
    char: u21,
    class: struct { negated: bool, items: []const ClassItem },
};
const Seq = []const Node;
const Node = union(enum) {
    single: struct { atom: Atom, min: u32, max: u32, lazy: bool },
    group: struct { alts: []const Seq, cap: u8, optional: bool },
    look_not: []const Seq,
    word_boundary,
    end,
};
const Regex = struct { alts: []const Seq, icase: bool };

const Parser = struct {
    arena: Allocator,
    src: []const u8,
    at: usize = 0,
    caps: u8 = 0,

    fn peek(p: *Parser) ?u8 {
        return if (p.at < p.src.len) p.src[p.at] else null;
    }

    fn alts(p: *Parser) error{ OutOfMemory, BadPattern }![]const Seq {
        var list: std.ArrayList(Seq) = .empty;
        while (true) {
            try list.append(p.arena, try p.seq());
            if (p.peek() != '|') break;
            p.at += 1;
        }
        return list.items;
    }

    fn seq(p: *Parser) error{ OutOfMemory, BadPattern }!Seq {
        var nodes: std.ArrayList(Node) = .empty;
        while (p.peek()) |c| {
            if (c == '|' or c == ')') break;
            p.at += 1;
            switch (c) {
                '$' => try nodes.append(p.arena, .end),
                '(' => try nodes.append(p.arena, try p.group()),
                '[' => try nodes.append(p.arena, try p.quantified(try p.class())),
                '\\' => {
                    const esc = p.peek() orelse return error.BadPattern;
                    p.at += 1;
                    if (esc == 'b') {
                        try nodes.append(p.arena, .word_boundary);
                    } else {
                        try nodes.append(p.arena, try p.quantified(try p.escapeAtom(esc)));
                    }
                },
                else => try nodes.append(p.arena, try p.quantified(.{ .char = c })),
            }
        }
        return nodes.items;
    }

    fn group(p: *Parser) error{ OutOfMemory, BadPattern }!Node {
        var look = false;
        var cap: u8 = 0;
        if (std.mem.startsWith(u8, p.src[p.at..], "?:")) {
            p.at += 2;
        } else if (std.mem.startsWith(u8, p.src[p.at..], "?!")) {
            p.at += 2;
            look = true;
        } else {
            p.caps += 1;
            cap = p.caps;
        }
        const inner = try p.alts();
        if (p.peek() != ')') return error.BadPattern;
        p.at += 1;
        if (look) return .{ .look_not = inner };
        var optional = false;
        if (p.peek() == '?') {
            p.at += 1;
            optional = true;
        }
        return .{ .group = .{ .alts = inner, .cap = cap, .optional = optional } };
    }

    fn escapeAtom(p: *Parser, esc: u8) error{ OutOfMemory, BadPattern }!Atom {
        const item: ?ClassItem = switch (esc) {
            's' => .space,
            'S' => .not_space,
            'w' => .word,
            'W' => .not_word,
            else => null,
        };
        if (item) |it| {
            const items = try p.arena.alloc(ClassItem, 1);
            items[0] = it;
            return .{ .class = .{ .negated = false, .items = items } };
        }
        return .{ .char = esc };
    }

    fn class(p: *Parser) error{ OutOfMemory, BadPattern }!Atom {
        var negated = false;
        if (p.peek() == '^') {
            negated = true;
            p.at += 1;
        }
        var items: std.ArrayList(ClassItem) = .empty;
        while (true) {
            const c = p.peek() orelse return error.BadPattern;
            p.at += 1;
            if (c == ']') break;
            var lo: u21 = c;
            if (c == '\\') {
                const esc = p.peek() orelse return error.BadPattern;
                p.at += 1;
                switch (esc) {
                    's' => try items.append(p.arena, .space),
                    'S' => try items.append(p.arena, .not_space),
                    'w' => try items.append(p.arena, .word),
                    'W' => try items.append(p.arena, .not_word),
                    else => lo = esc,
                }
                if (esc == 's' or esc == 'S' or esc == 'w' or esc == 'W') continue;
            }
            var hi = lo;
            if (p.peek() == '-' and p.at + 1 < p.src.len and p.src[p.at + 1] != ']') {
                hi = p.src[p.at + 1];
                p.at += 2;
            }
            try items.append(p.arena, .{ .range = .{ lo, hi } });
        }
        return .{ .class = .{ .negated = negated, .items = items.items } };
    }

    fn quantified(p: *Parser, atom: Atom) error{ OutOfMemory, BadPattern }!Node {
        var min: u32 = 1;
        var max: u32 = 1;
        switch (p.peek() orelse 0) {
            '*' => {
                min = 0;
                max = std.math.maxInt(u32);
            },
            '+' => max = std.math.maxInt(u32),
            '?' => min = 0,
            '{' => {
                const close = std.mem.findScalarPos(u8, p.src, p.at, '}') orelse return error.BadPattern;
                const body = p.src[p.at + 1 .. close];
                if (std.mem.findScalar(u8, body, ',')) |comma| {
                    min = std.fmt.parseInt(u32, body[0..comma], 10) catch return error.BadPattern;
                    max = if (comma + 1 == body.len) std.math.maxInt(u32) else std.fmt.parseInt(u32, body[comma + 1 ..], 10) catch return error.BadPattern;
                } else {
                    min = std.fmt.parseInt(u32, body, 10) catch return error.BadPattern;
                    max = min;
                }
                p.at = close;
            },
            else => return .{ .single = .{ .atom = atom, .min = 1, .max = 1, .lazy = false } },
        }
        p.at += 1;
        var lazy = false;
        if (p.peek() == '?') {
            lazy = true;
            p.at += 1;
        }
        return .{ .single = .{ .atom = atom, .min = min, .max = max, .lazy = lazy } };
    }
};

fn compile(arena: Allocator, pattern: []const u8, icase: bool) error{ OutOfMemory, BadPattern }!Regex {
    var parser: Parser = .{ .arena = arena, .src = pattern };
    const top = try parser.alts();
    if (parser.at != pattern.len) return error.BadPattern;
    return .{ .alts = top, .icase = icase };
}

/// JS `\s`: WhiteSpace and LineTerminator of the spec.
fn isJsSpace(cp: u21) bool {
    return switch (cp) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        else => false,
    };
}

fn isWordCp(cp: u21) bool {
    return cp < 128 and (std.ascii.isAlphanumeric(@intCast(cp)) or cp == '_');
}

const Span = struct { start: usize = 0, end: usize = 0 };
const Cont = struct { seq: Seq, idx: usize, next: ?*const Cont, cap: u8, cap_start: usize };

const Matcher = struct {
    text: []const u8,
    icase: bool,
    caps: [4]Span = @splat(.{}),
    end: usize = 0,

    const Cp = struct { cp: u21, len: usize };

    fn decode(m: *const Matcher, pos: usize) ?Cp {
        if (pos >= m.text.len) return null;
        const len = std.unicode.utf8ByteSequenceLength(m.text[pos]) catch return .{ .cp = 0xfffd, .len = 1 };
        if (pos + len > m.text.len) return .{ .cp = 0xfffd, .len = 1 };
        const cp = std.unicode.utf8Decode(m.text[pos .. pos + len]) catch return .{ .cp = 0xfffd, .len = 1 };
        return .{ .cp = cp, .len = len };
    }

    fn classHas(m: *const Matcher, items: []const ClassItem, cp: u21) bool {
        for (items) |item| switch (item) {
            .space => if (isJsSpace(cp)) return true,
            .not_space => if (!isJsSpace(cp)) return true,
            .word => if (isWordCp(cp)) return true,
            .not_word => if (!isWordCp(cp)) return true,
            .range => |r| {
                if (cp >= r[0] and cp <= r[1]) return true;
                if (m.icase and cp < 128 and std.ascii.isAlphabetic(@intCast(cp))) {
                    const other: u21 = std.ascii.toLower(@intCast(cp));
                    const swapped: u21 = if (other == cp) std.ascii.toUpper(@intCast(cp)) else other;
                    if (swapped >= r[0] and swapped <= r[1]) return true;
                }
            },
        };
        return false;
    }

    fn atomLen(m: *const Matcher, atom: Atom, pos: usize) ?usize {
        const at = m.decode(pos) orelse return null;
        const ok = switch (atom) {
            .char => |c| at.cp == c or (m.icase and at.cp < 128 and c < 128 and
                std.ascii.toLower(@intCast(at.cp)) == std.ascii.toLower(@intCast(c))),
            .class => |k| m.classHas(k.items, at.cp) != k.negated,
        };
        return if (ok) at.len else null;
    }

    fn prevStart(m: *const Matcher, pos: usize, floor: usize) usize {
        var p = pos - 1;
        while (p > floor and m.text[p] & 0xc0 == 0x80) p -= 1;
        return p;
    }

    fn boundary(m: *const Matcher, pos: usize) bool {
        const before = pos > 0 and isWordCp(m.text[pos - 1]);
        const after = pos < m.text.len and isWordCp(m.text[pos]);
        return before != after;
    }

    fn run(m: *Matcher, seq: Seq, idx: usize, pos: usize, cont: ?*const Cont) bool {
        if (idx == seq.len) {
            const c = cont orelse {
                m.end = pos;
                return true;
            };
            if (c.cap == 0) return m.run(c.seq, c.idx, pos, c.next);
            const old = m.caps[c.cap];
            m.caps[c.cap] = .{ .start = c.cap_start, .end = pos };
            if (m.run(c.seq, c.idx, pos, c.next)) return true;
            m.caps[c.cap] = old;
            return false;
        }
        switch (seq[idx]) {
            .word_boundary => return m.boundary(pos) and m.run(seq, idx + 1, pos, cont),
            .end => return pos == m.text.len and m.run(seq, idx + 1, pos, cont),
            .look_not => |inner| {
                for (inner) |alt| if (m.run(alt, 0, pos, null)) return false;
                return m.run(seq, idx + 1, pos, cont);
            },
            .group => |g| {
                for (g.alts) |alt| {
                    const next: Cont = .{ .seq = seq, .idx = idx + 1, .next = cont, .cap = g.cap, .cap_start = pos };
                    if (m.run(alt, 0, pos, &next)) return true;
                }
                return g.optional and m.run(seq, idx + 1, pos, cont);
            },
            .single => |s| return m.runSingle(s, seq, idx, pos, cont),
        }
    }

    fn runSingle(m: *Matcher, s: anytype, seq: Seq, idx: usize, pos: usize, cont: ?*const Cont) bool {
        var p = pos;
        var n: u32 = 0;
        if (s.lazy) {
            while (n < s.min) : (n += 1) p += m.atomLen(s.atom, p) orelse return false;
            while (true) {
                if (m.run(seq, idx + 1, p, cont)) return true;
                if (n >= s.max) return false;
                p += m.atomLen(s.atom, p) orelse return false;
                n += 1;
            }
        }
        while (n < s.max) {
            p += m.atomLen(s.atom, p) orelse break;
            n += 1;
        }
        while (n >= s.min) {
            if (m.run(seq, idx + 1, p, cont)) return true;
            if (n == 0) return false;
            p = m.prevStart(p, pos);
            n -= 1;
        }
        return false;
    }
};

fn expand(out: *std.ArrayList(u8), gpa: Allocator, template: []const u8, text: []const u8, caps: []const Span) Allocator.Error!void {
    var i: usize = 0;
    while (i < template.len) : (i += 1) {
        if (template[i] == '$' and i + 1 < template.len and template[i + 1] == '1') {
            try out.appendSlice(gpa, text[caps[1].start..caps[1].end]);
            i += 1;
        } else try out.append(gpa, template[i]);
    }
}

fn replaceAll(gpa: Allocator, re: Regex, template: []const u8, text: []const u8) Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    var m: Matcher = .{ .text = text, .icase = re.icase };
    var copied: usize = 0;
    var start: usize = 0;
    while (start < text.len) {
        m.caps = @splat(.{});
        var hit = false;
        for (re.alts) |alt| {
            if (m.run(alt, 0, start, null)) {
                hit = true;
                break;
            }
        }
        if (!hit) {
            start += m.decode(start).?.len;
            continue;
        }
        try out.appendSlice(gpa, text[copied..start]);
        try expand(&out, gpa, template, text, &m.caps);
        copied = m.end;
        start = if (m.end > start) m.end else start + m.decode(start).?.len;
    }
    try out.appendSlice(gpa, text[copied..]);
    return out.toOwnedSlice(gpa);
}

const Case = struct { input: []const u8, expected: []const u8 };

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

// The table of redact.test.ts.
const cases = [_]Case{
    .{ .input = "key sk-ant-api03-abcDEF123456_xyz end", .expected = "key [REDACTED:anthropic-key] end" },
    .{ .input = "key sk-proj-abcDEF1234567890abcdEF end", .expected = "key [REDACTED:openai-key] end" },
    .{ .input = "t ghp_abcdefghijklmnopqrstuvwxyz0123456789 e", .expected = "t [REDACTED:github-token] e" },
    .{ .input = "t github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz e", .expected = "t [REDACTED:github-token] e" },
    .{ .input = "Authorization: Bearer abc123.def456-ghi", .expected = "Authorization: [REDACTED:bearer]" },
    .{ .input = "run PASSWORD=hunter2 now", .expected = "run PASSWORD=[REDACTED:secret] now" },
    .{ .input = "GITHUB_TOKEN=abc x", .expected = "GITHUB_TOKEN=[REDACTED:secret] x" },
    .{ .input = "password=hunter2 api_key=abc123", .expected = "password=[REDACTED:secret] api_key=[REDACTED:secret]" },
    .{ .input = "secret: s3cr3t!", .expected = "secret: [REDACTED:secret]" },
    .{ .input = "{\"password\":\"hunter2\",\"n\":1}", .expected = "{\"password\":[REDACTED:secret],\"n\":1}" },
    .{ .input = "tool --password hunter2 --verbose", .expected = "tool --password [REDACTED:secret] --verbose" },
    .{ .input = "PASSWORD=\"a b c\" next", .expected = "PASSWORD=[REDACTED:secret] next" },
    .{ .input = "Authorization: bearer abcdef123456", .expected = "Authorization: [REDACTED:bearer]" },
    .{ .input = "Authorization: Basic dXNlcjpwYXNz", .expected = "Authorization: [REDACTED:basic-auth]" },
    .{ .input = "clone https://bob:pw123@github.com/x.git", .expected = "clone https://[REDACTED:url-credentials]@github.com/x.git" },
    .{ .input = "-H 'X-Api-Key: abc123def'", .expected = "-H 'X-Api-Key: [REDACTED:secret]'" },
    .{ .input = "t xoxb-1234567890-abcdefghij e", .expected = "t [REDACTED:slack-token] e" },
    .{ .input = "k AIzaSyA1234567890abcdefghijklmnopqrstuv e", .expected = "k [REDACTED:google-key] e" },
    .{ .input = "k sk_live_abcdefghijklmnop1234 e", .expected = "k [REDACTED:stripe-key] e" },
    .{ .input = "k npm_abcdefghijklmnopqrstuvwxyz0123456789 e", .expected = "k [REDACTED:npm-token] e" },
    .{ .input = "tok " ++ jwt ++ " end", .expected = "tok [REDACTED:jwt] end" },
    .{ .input = "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nb", .expected = "a\n[REDACTED:private-key]\nb" },
    .{ .input = "AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", .expected = "[REDACTED:aws-key] [REDACTED:aws-secret]" },
    .{ .input = "ls -la /tmp/foo_bar && echo token count is 5; sk-learn is a library; max_tokens=100 --token-count 5", .expected = "ls -la /tmp/foo_bar && echo token count is 5; sk-learn is a library; max_tokens=100 --token-count 5" },
    // An unterminated key runs to the end of the text, as the `$` alternative does in TS.
    .{ .input = "x -----BEGIN PRIVATE KEY-----\nabc", .expected = "x [REDACTED:private-key]" },
    // A non-ASCII space ends an unquoted value, as JS \s does.
    .{ .input = "password=abc\u{a0}def", .expected = "password=[REDACTED:secret]\u{a0}def" },
};

test "logs/redact: the redact.test.ts table" {
    for (cases) |case| {
        const out = try redactSecrets(std.testing.allocator, case.input);
        defer std.testing.allocator.free(out);
        try std.testing.expectEqualStrings(case.expected, out);
    }
}

test "logs/redact: allocation failures leak nothing" {
    const Run = struct {
        fn run(gpa: Allocator) !void {
            const out = try redactSecrets(gpa, "run PASSWORD=hunter2 now https://a:b@h/ AKIAIOSFODNN7EXAMPLE");
            gpa.free(out);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Run.run, .{});
}

test "logs/redact: every rule pattern parses" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    for (rules ++ [_]Rule{aws_secret}) |rule| _ = try compile(arena.allocator(), rule.pattern, rule.icase);
}

test "logs/redact: output equals the TS redact() on the recorded corpus" {
    const gpa = std.testing.allocator;
    const parsed = try std.json.parseFromSlice([]const Case, gpa, @embedFile("fixtures/redact.json"), .{});
    defer parsed.deinit();
    for (parsed.value) |case| {
        const out = try redactSecrets(gpa, case.input);
        defer gpa.free(out);
        std.testing.expectEqualStrings(case.expected, out) catch |err| {
            std.debug.print("input: {s}\n", .{case.input});
            return err;
        };
    }
}
