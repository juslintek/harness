const std = @import("std");
const lexer = @import("lexer.zig");
const shell = @import("shell.zig");

const gpa = std.testing.allocator;

fn expectUnparseable(src: []const u8, reason: []const u8) !void {
    var out = try shell.parse(gpa, src);
    defer out.deinit();
    switch (out) {
        .unparseable => |u| try std.testing.expectEqualStrings(reason, u.message()),
        .parsed => {
            std.debug.print("parsed but expected failure: {s}\n", .{src});
            return error.TestUnexpectedResult;
        },
    }
}

fn parsed(src: []const u8) !shell.Parsed {
    const out = try shell.parse(gpa, src);
    return switch (out) {
        .parsed => |p| p,
        .unparseable => error.TestUnexpectedResult,
    };
}

test "shell: pipeline stages share one after array and are flagged" {
    var p = try parsed("a | b |& c; d");
    defer p.deinit();
    try std.testing.expectEqual(@as(usize, 4), p.cmds.len);
    try std.testing.expect(p.cmds[0].piped and p.cmds[1].piped and !p.cmds[2].piped);
    try std.testing.expect(!p.cmds[0].from_pipe and p.cmds[1].from_pipe and p.cmds[2].from_pipe and !p.cmds[3].from_pipe);
    try std.testing.expectEqual(@as(usize, 2), p.cmds[0].after.len);
    try std.testing.expect(p.cmds[0].after[0] == p.cmds[1] and p.cmds[0].after[1] == p.cmds[2]);
    try std.testing.expect(p.cmds[1].after.ptr == p.cmds[0].after.ptr + 1);
    try std.testing.expectEqual(@as(usize, 0), p.cmds[3].after.len);
}

test "shell: substitutions and child shells are bracketed by marks" {
    var p = try parsed("echo $(ls) | wc");
    defer p.deinit();
    try std.testing.expect(p.cmds[0].mark == .open);
    try std.testing.expectEqualStrings("ls", p.cmds[1].argv[0]);
    try std.testing.expect(p.cmds[2].mark == .close);
    try std.testing.expectEqualStrings("echo", p.cmds[3].argv[0]);
}

test "shell: wrappers, assignments and redirects land in their fields" {
    var p = try parsed("A=1 sudo -u root B=2 rm -rf x 2>&1 > out < in");
    defer p.deinit();
    const c = p.cmds[0];
    try std.testing.expectEqual(@as(usize, 3), c.argv.len);
    try std.testing.expectEqualStrings("A=1", c.assigns[0]);
    try std.testing.expectEqualStrings("B=2", c.assigns[1]);
    try std.testing.expectEqualStrings("sudo", c.wrappers[0]);
    try std.testing.expectEqual(@as(usize, 2), c.redirects.len);
    try std.testing.expect(c.redirects[0].op == .out and c.redirects[1].op == .in);
}

test "shell: download piped to a shell is flagged on the shell command" {
    var p = try parsed("bash <(curl -s x)");
    defer p.deinit();
    try std.testing.expectEqualStrings("bash", p.cmds[3].argv[0]);
    try std.testing.expect(p.cmds[3].download_exec);
    var q = try parsed("sh -c \"$(curlx y)\"");
    defer q.deinit();
    try std.testing.expect(!q.cmds[0].download_exec);
}

test "shell: find -delete and -exec are judged as the commands they run" {
    var p = try parsed("find a b -exec rm {} \\;");
    defer p.deinit();
    try std.testing.expectEqual(@as(usize, 3), p.cmds.len);
    try std.testing.expectEqualStrings("rm", p.cmds[1].argv[0]);
    try std.testing.expectEqualStrings("a", p.cmds[1].argv[1]);
    try std.testing.expectEqualStrings("b", p.cmds[2].argv[1]);
    var d = try parsed("find / -delete");
    defer d.deinit();
    try std.testing.expectEqualStrings("--find", d.cmds[1].argv[2]);
}

test "shell: parse errors carry the TS messages" {
    try expectUnparseable("echo 'x", "unterminated single quote");
    try expectUnparseable("echo \"x", "unterminated double quote");
    try expectUnparseable("echo `x", "unterminated backtick");
    try expectUnparseable("echo $(x", "unterminated substitution");
    try expectUnparseable("echo ${x", "unterminated ${");
    try expectUnparseable("cat <<'E'\nbody", "unterminated heredoc");
    try expectUnparseable("cat <<E", "heredoc");
    try expectUnparseable("xargs -I{} sh -c 'echo {}'", "script comes from stdin");
    try expectUnparseable("sudo -D /x ls", "sudo changes the working directory");
    try expectUnparseable("a\xffb", "invalid utf-8");
}

test "shell: an unterminated quote inside a substitution is an error, not a hang" {
    try expectUnparseable("echo $(echo 'x", "unterminated substitution");
    try expectUnparseable(">(if |||# c\n'<<'EOF'\nbody\nEOF\nls", "unterminated substitution");
}

fn repeated(a: std.mem.Allocator, unit: []const u8, n: usize) ![]u8 {
    const buf = try a.alloc(u8, unit.len * n);
    for (0..n) |i| @memcpy(buf[i * unit.len ..][0..unit.len], unit);
    return buf;
}

test "shell: the length limit counts UTF-16 units, not bytes" {
    const ok = try repeated(gpa, "a", 100_000);
    defer gpa.free(ok);
    var p = try parsed(ok);
    p.deinit();
    const long = try repeated(gpa, "a", 100_001);
    defer gpa.free(long);
    try expectUnparseable(long, "too complex");
    // 50_000 emoji are 100_000 units in 200_000 bytes; one more crosses the limit.
    const emoji = try repeated(gpa, "\u{1F600}", 50_000);
    defer gpa.free(emoji);
    var e = try parsed(emoji);
    e.deinit();
    const more = try repeated(gpa, "\u{1F600}", 50_001);
    defer gpa.free(more);
    try expectUnparseable(more, "too complex");
    // 100_000 two-byte characters are 100_000 units, so bytes alone must not trigger the limit.
    const two = try repeated(gpa, "\u{e9}", 100_000);
    defer gpa.free(two);
    var t = try parsed(two);
    t.deinit();
}

test "shell: six nested substitutions parse and a seventh is too complex" {
    var p = try parsed("echo $(a $(b $(c $(d $(e $(f))))))");
    p.deinit();
    try expectUnparseable("echo $(a $(b $(c $(d $(e $(f $(g)))))))", "too complex");
}

test "shell: deeply nested quotes in substitutions stop at the nesting cap" {
    const open = try repeated(gpa, "\"$(", 5000);
    defer gpa.free(open);
    try expectUnparseable(open, "too complex");
}

test "shell: nested find -exec stops at the nesting cap" {
    const body = try repeated(gpa, "find a -exec ", 300);
    defer gpa.free(body);
    const src = try std.mem.concat(gpa, u8, &.{ body, "rm {} \\;" });
    defer gpa.free(src);
    try expectUnparseable(src, "too complex");
}

test "shell: find with many start paths and many -delete flags hits the copy budget" {
    const starts = try repeated(gpa, "a ", 5000);
    defer gpa.free(starts);
    const deletes = try repeated(gpa, " -delete", 5000);
    defer gpa.free(deletes);
    const src = try std.mem.concat(gpa, u8, &.{ "find ", starts, deletes });
    defer gpa.free(src);
    try expectUnparseable(src, "too complex");
}

test "shell: the statement budget stops a flood of empty statements" {
    const src = try repeated(gpa, ";", 5000);
    defer gpa.free(src);
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa, .resolves_left = 1000 };
    try std.testing.expectError(error.ShellParse, shell.parseCommands(&ctx, src, 0));
    try std.testing.expectEqualStrings("too complex", ctx.reason);
}

test "shell: total lexed bytes are capped across nested scripts" {
    // Each eval level re-lexes the whole text twice (the word and its substitution).
    var src: []const u8 = "x";
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    for (0..6) |_| src = try std.fmt.allocPrint(arena.allocator(), "eval \"$(echo {s} {s})\"", .{ src, src });
    var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = gpa, .bytes_left = 100 };
    try std.testing.expectError(error.ShellParse, shell.parseCommands(&ctx, src, 0));
}

fn parseOnce(a: std.mem.Allocator, src: []const u8) !void {
    var out = try shell.parse(a, src);
    out.deinit();
}

test "shell: allocation failure at every point leaks nothing" {
    const inputs = [_][]const u8{
        "ls",
        "a | b | c; d && e || f &",
        "FOO=1 sudo -u root env A=2 nice -n 5 rm -rf /tmp/x > out 2>&1",
        "echo $(echo `ls`) \"$(a \"b\")\" <(c) >(d)",
        "cat <<'EOF'\nbody\nEOF\necho after",
        "find a b -exec rm {} \\; -delete",
        "eval 'ls; rm -rf /' && bash -c \"sh -c 'ls'\"",
        "echo {a,b}{c,d} x{1,2}",
        "git rebase -x 'make test' && xargs -I{} cp {} /x",
        "trap 'rm x' EXIT; watch -n 2 ls; alias a=ls b='rm y'; fd -x rm {}",
        "( a; b ) | c",
        "echo 'unterminated",
        "sudo -D /x ls",
    };
    for (inputs) |src| try std.testing.checkAllAllocationFailures(gpa, parseOnce, .{src});
}

const alphabet = [_][]const u8{
    "'",      "\"", "`",   "$(",   "$",  "(",    ")",    "{",        "}",                ",",  ";",  "&",     "|",    "<",     ">",     "<<'E'\n",       "E\n", "\n",
    "\\",     "#",  " ",   "\t",   "a",  "b",    "rm ",  "-rf",      "-c ",              "=",  "x=", "sudo ", "env ", "eval ", "bash ", "find . -exec ", "{}",  "\\;",
    "xargs ", "-I", "<<<", "2>&1", "&>", "\xff", "\xc3", "\xe2\x80", "\xf0\x9f\x98\x80", "<(", ">(", "${",
};

fn randomInput(rng: std.Random, a: std.mem.Allocator, max_parts: usize) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(a);
    const n = rng.uintLessThan(usize, max_parts) + 1;
    for (0..n) |_| try buf.appendSlice(a, alphabet[rng.uintLessThan(usize, alphabet.len)]);
    return buf.toOwnedSlice(a);
}

test "shell: generated adversarial inputs never crash and stay within a small heap" {
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const rng = prng.random();
    // A fixed 16 MiB heap: an input of at most 200 pieces that needs more fails the test with OutOfMemory.
    const heap = try gpa.alloc(u8, 16 * 1024 * 1024);
    defer gpa.free(heap);
    var fba = std.heap.FixedBufferAllocator.init(heap);
    var unparseable: usize = 0;
    var ok: usize = 0;
    for (0..4000) |i| {
        fba.reset();
        const src = try randomInput(rng, fba.allocator(), if (i % 4 == 0) 200 else 6);
        // Raw bytes reach the lexer too: shell.parse screens UTF-8, parseCommands must still cope.
        var arena = std.heap.ArenaAllocator.init(fba.allocator());
        var ctx: lexer.Ctx = .{ .arena = arena.allocator(), .scratch = fba.allocator() };
        if (shell.parseCommands(&ctx, src, 0)) |_| {} else |e| try std.testing.expect(e == error.ShellParse);
        arena.deinit();
        var out = try shell.parse(fba.allocator(), src);
        switch (out) {
            .parsed => ok += 1,
            .unparseable => unparseable += 1,
        }
        out.deinit();
    }
    try std.testing.expect(ok > 100 and unparseable > 100);
}

test "shell: long runs of one hostile construct are rejected or parsed without recursion" {
    const units = [_][]const u8{ "(", ")", "'", "\"", "`", "$(", "{", "{a,", "<<'E'\n", "\\", "$", "&", "|", ";", "\n", "<(", "${", "\"$(", "$('" };
    for (units) |u| {
        const src = try repeated(gpa, u, 100_000 / u.len);
        defer gpa.free(src);
        try parseOnce(gpa, src);
    }
}
