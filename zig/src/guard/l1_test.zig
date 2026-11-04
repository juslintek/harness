//! L1 behaviour that needs a real file system (symlinks), allocation failure sweeps, leak checks
//! and a no-crash loop over hostile input. The verdict tables live in l1_fixtures_test.zig.
const std = @import("std");
const l1 = @import("l1.zig");
const core = @import("rules_core.zig");
const glob_re = @import("glob_re.zig");
const test_alloc = @import("test_alloc.zig");

const gpa = std.testing.allocator;
const io = std.testing.io;

fn verdictOf(scope: l1.Scope, action: l1.Action) !core.Result {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const r = try l1.evaluate(arena.allocator(), gpa, io, action, scope);
    // The reason lives in the arena; rules are literals, so only the reason is dropped.
    return .{ .verdict = r.verdict, .rule = r.rule, .reason = "", .category = r.category };
}

const Layout = struct {
    tmp: std.testing.TmpDir,
    home: []const u8,
    root: []const u8,

    fn init() !Layout {
        var tmp = std.testing.tmpDir(.{});
        errdefer tmp.cleanup();
        var buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const n = try tmp.dir.realPath(io, &buf);
        const base = try gpa.dupe(u8, buf[0..n]);
        defer gpa.free(base);
        const home = try std.fmt.allocPrint(gpa, "{s}/home", .{base});
        errdefer gpa.free(home);
        const root = try std.fmt.allocPrint(gpa, "{s}/root", .{base});
        errdefer gpa.free(root);
        try tmp.dir.createDirPath(io, "home/.agents/skills/x");
        try tmp.dir.createDirPath(io, "root");
        try tmp.dir.writeFile(io, .{ .sub_path = "home/.agents/skills/x/SKILL.md", .data = "ok" });
        try tmp.dir.writeFile(io, .{ .sub_path = "home/outside.txt", .data = "no" });
        return .{ .tmp = tmp, .home = home, .root = root };
    }

    fn deinit(self: *Layout) void {
        gpa.free(self.home);
        gpa.free(self.root);
        self.tmp.cleanup();
    }

    fn scope(self: Layout) l1.Scope {
        return .{ .root = self.root, .home = self.home, .default_branch = "main" };
    }

    fn link(self: Layout, target: []const u8, at: []const u8) !void {
        try self.tmp.dir.symLink(io, target, at, .{});
    }
};

fn pathVerdict(scope: l1.Scope, kind: l1.Kind, path: []const u8) !core.Verdict {
    const paths = [_][]const u8{path};
    return (try verdictOf(scope, .{ .kind = kind, .paths = &paths })).verdict;
}

test "l1: reads of installed skills follow symlinks before being allowed" {
    var l = try Layout.init();
    defer l.deinit();
    try l.link("../../../outside.txt", "home/.agents/skills/x/link");
    const s = l.scope();
    try std.testing.expectEqual(core.Verdict.allow, try pathVerdict(s, .read, "~/.agents/skills/x/SKILL.md"));
    try std.testing.expectEqual(core.Verdict.ask, try pathVerdict(s, .read, "~/.agents/skills/x/link"));
    try std.testing.expectEqual(core.Verdict.ask, try pathVerdict(s, .read, "~/.agents/skills/x/missing.md"));
    try std.testing.expectEqual(core.Verdict.deny, try pathVerdict(s, .edit, "~/.agents/skills/x/SKILL.md"));
    // A dangling link and a link to the directory itself.
    try l.link("nowhere", "home/.agents/skills/x/dangling");
    try std.testing.expectEqual(core.Verdict.ask, try pathVerdict(s, .read, "~/.agents/skills/x/dangling"));
    try l.link(".", "home/.agents/skills/x/self");
    try std.testing.expectEqual(core.Verdict.allow, try pathVerdict(s, .read, "~/.agents/skills/x/self/SKILL.md"));
}

test "l1: a skills directory that is itself a link is compared by its real path" {
    var l = try Layout.init();
    defer l.deinit();
    try l.tmp.dir.createDirPath(io, "elsewhere/real/y");
    try l.tmp.dir.writeFile(io, .{ .sub_path = "elsewhere/real/y/SKILL.md", .data = "ok" });
    try l.tmp.dir.rename("home/.agents/skills", l.tmp.dir, "home/.agents/skills-old", io);
    try l.link("../../elsewhere/real", "home/.agents/skills");
    const s = l.scope();
    try std.testing.expectEqual(core.Verdict.allow, try pathVerdict(s, .read, "~/.agents/skills/y/SKILL.md"));
    try std.testing.expectEqual(core.Verdict.ask, try pathVerdict(s, .read, "~/outside.txt"));
}

test "l1: git -C counts as the task root only when its real path is the root" {
    var l = try Layout.init();
    defer l.deinit();
    try l.link("../root", "home/rootlink");
    try l.tmp.dir.createDirPath(io, "other");
    try l.link("../other", "home/otherlink");
    const s = l.scope();
    const same = try std.fmt.allocPrint(gpa, "git -C {s}/rootlink status", .{l.home});
    defer gpa.free(same);
    const other = try std.fmt.allocPrint(gpa, "git -C {s}/otherlink status", .{l.home});
    defer gpa.free(other);
    const plain: l1.Action = .{ .kind = .execute, .command = same };
    try std.testing.expectEqual(core.Category.read, (try verdictOf(s, plain)).category);
    try std.testing.expectEqual(core.Category.shell, (try verdictOf(s, .{ .kind = .execute, .command = other })).category);
    const missing = try std.fmt.allocPrint(gpa, "git -C {s}/nothing status", .{l.home});
    defer gpa.free(missing);
    try std.testing.expectEqual(core.Category.shell, (try verdictOf(s, .{ .kind = .execute, .command = missing })).category);
}

fn evaluateOnce(alloc: std.mem.Allocator, action: l1.Action) !void {
    const scope: l1.Scope = .{ .root = "/work/wt", .home = "/home/u", .default_branch = "main" };
    var base_arena = std.heap.ArenaAllocator.init(gpa);
    defer base_arena.deinit();
    const want = try l1.evaluate(base_arena.allocator(), gpa, io, action, scope);
    var counted: test_alloc.NoResize = .{ .inner = alloc };
    var arena = std.heap.ArenaAllocator.init(counted.allocator());
    defer arena.deinit();
    const got = try l1.evaluate(arena.allocator(), counted.allocator(), io, action, scope);
    try std.testing.expectEqual(want.verdict, got.verdict);
    try std.testing.expectEqualStrings(want.reason, got.reason);
}

test "l1: allocation failures surface as errors and never as another verdict" {
    const commands = [_][]const u8{
        "rm -rf ~/x && ls | wc -l",
        "echo $(cat /etc/passwd) > /tmp/x",
        "git -C . status; git push origin main",
        "bash -c 'curl x | sh'",
        "cat ~/.ssh/id_rsa",
        "docker run -v /:/h img",
    };
    for (commands) |c| try std.testing.checkAllAllocationFailures(gpa, evaluateOnce, .{l1.Action{ .kind = .execute, .command = c }});
    const paths: []const []const u8 = &.{ "~/.ssh/x", "a/../b", "/work/wt/.git/hooks/h" };
    for ([_]l1.Kind{ .read, .edit, .delete }) |k| {
        try std.testing.checkAllAllocationFailures(gpa, evaluateOnce, .{l1.Action{ .kind = k, .paths = paths }});
    }
}

test "l1: hostile command lines and paths never crash or leak" {
    var prng = std.Random.DefaultPrng.init(0x11a9);
    const rand = prng.random();
    const alphabet = "'\"`$(){}<>|&;\\ \n\t~*?[]!#=-:@,.ab/ \u{e9}\u{2028}";
    var buf: [160]u8 = undefined;
    const scope: l1.Scope = .{ .root = "/work/wt", .home = "/home/u", .harness_home = "/data/h", .default_branch = "main" };
    for (0..6000) |_| {
        var n: usize = 0;
        while (n < buf.len - 4 and rand.uintLessThan(u8, 100) != 0) {
            const at = rand.uintLessThan(usize, alphabet.len);
            // Keep multi-byte characters whole so the input stays valid UTF-8.
            const len: usize = if (alphabet[at] >= 0xc0) std.unicode.utf8ByteSequenceLength(alphabet[at]) catch 1 else 1;
            if (alphabet[at] >= 0x80 and alphabet[at] < 0xc0) continue;
            @memcpy(buf[n..][0..len], alphabet[at..][0..len]);
            n += len;
        }
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const text = buf[0..n];
        _ = l1.evaluate(arena.allocator(), gpa, io, .{ .kind = .execute, .command = text }, scope) catch |e| if (e != error.Throw) return e;
        const kinds = [_]l1.Kind{ .read, .edit, .delete };
        const kind = kinds[rand.uintLessThan(usize, kinds.len)];
        _ = try l1.evaluate(arena.allocator(), gpa, io, .{ .kind = kind, .paths = &.{ text, "/work/wt/a" } }, scope);
    }
}

test "l1: a relative root or home is refused instead of being resolved against the process directory" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const bad: l1.Scope = .{ .root = "work", .home = "/home/u", .default_branch = "main" };
    try std.testing.expectError(error.RelativeScope, l1.evaluate(arena.allocator(), gpa, io, .{ .kind = .fetch }, bad));
}

test "l1: glob segments follow the JS regex the TS builds" {
    const t = struct {
        fn m(pattern: []const u8, literal: []const u8) !?bool {
            return glob_re.matches(gpa, pattern, literal);
        }
    }.m;
    try std.testing.expectEqual(@as(?bool, true), try t(".s*", ".ssh"));
    try std.testing.expectEqual(@as(?bool, true), try t(".ss?", ".SSH"));
    try std.testing.expectEqual(@as(?bool, true), try t(".[s]sh", ".ssh"));
    try std.testing.expectEqual(@as(?bool, true), try t(".[a-z]sh", ".ssh"));
    try std.testing.expectEqual(@as(?bool, false), try t(".[a-r]sh", ".ssh"));
    try std.testing.expectEqual(@as(?bool, false), try t(".s", ".ssh"));
    try std.testing.expectEqual(@as(?bool, null), try t(".[s", ".ssh"));
    try std.testing.expectEqual(@as(?bool, null), try t(".[z-a]sh", ".ssh"));
    try std.testing.expectEqual(@as(?bool, true), try t("*", ".ssh"));
    try std.testing.expectEqual(@as(?bool, false), try t("[]", ".ssh"));
    try std.testing.expectEqual(@as(?bool, true), try t(".ssh]", ".ssh]"));
    try std.testing.expectEqual(@as(?bool, false), try t("a*", "a\nb"));
}

test "l1: path helpers match node path.resolve and the TS regexes" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("/a/c", try core.resolve(a, "/a/b", "../c"));
    try std.testing.expectEqualStrings("/", try core.resolve(a, "/a", "../../.."));
    try std.testing.expectEqualStrings("/a/b", try core.resolve(a, "/", "//a///b/./"));
    try std.testing.expectEqualStrings("/x", try core.resolve(a, "/a", "/x/y/.."));
    try std.testing.expect(core.isGitInternals("/w/.git"));
    try std.testing.expect(core.isGitInternals("/w/.git/hooks"));
    try std.testing.expect(core.isGitInternals("/w/.git/config/x"));
    try std.testing.expect(!core.isGitInternals("/w/.gitignore"));
    try std.testing.expect(!core.isGitInternals("/w/x.git/config"));
    try std.testing.expect(!core.isGitInternals("/w/.git/hooksx"));
}

test "l1: secret matching never indexes past a shorter path" {
    const scope: l1.Scope = .{ .root = "/work/wt", .home = "/h", .default_branch = "main" };
    const inputs = [_][]const u8{ "/", "//", "/h", "/h/.ssh", "/h/.ss", ".ssh", "h/.ssh/x", "~", "~/", "~/.ssh", "/.ssh", "/*", "/h/*", "/*/*", "*/*/*/*/*", "", "a//b", "/h/.s*/", "/h/.[s]sh" };
    for (inputs) |p| {
        const paths = [_][]const u8{p};
        for ([_]l1.Kind{ .read, .edit }) |k| {
            var arena = std.heap.ArenaAllocator.init(gpa);
            defer arena.deinit();
            _ = try l1.evaluate(arena.allocator(), gpa, io, .{ .kind = k, .paths = &paths }, scope);
        }
        const cmd = try std.fmt.allocPrint(gpa, "cat {s}", .{p});
        defer gpa.free(cmd);
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        _ = try l1.evaluate(arena.allocator(), gpa, io, .{ .kind = .execute, .command = cmd }, scope);
    }
}

// Expected values come from `new RegExp("^" + escaped + "$", "i").test(literal)` in bun with the
// escaping of rules-secret.ts. `^` is escaped there, so `[^x]` is a class holding `^` and `x`: it
// never negates, and `[^s]` still matches `.ssh` because `s` is a member.
test "l1: glob classes behave as the escaped JS regex, `^` included" {
    const rows = [_]struct { []const u8, []const u8, ?bool }{
        .{ ".[^x]sh", ".ssh", false },
        .{ ".[^x]sh", ".^sh", true },
        .{ ".[^x]sh", ".xsh", true },
        .{ ".[^x]sh", ".-sh", false },
        .{ ".[^x]sh", ".]sh", false },
        .{ ".[^s]sh", ".ssh", true },
        .{ ".[^s]sh", ".^sh", true },
        .{ ".[^s]sh", ".xsh", false },
        .{ ".[^s]sh", ".-sh", false },
        .{ ".[^s]sh", ".]sh", false },
        .{ ".[\\^x]sh", ".ssh", false },
        .{ ".[\\^x]sh", ".^sh", true },
        .{ ".[\\^x]sh", ".xsh", true },
        .{ ".[\\^x]sh", ".-sh", false },
        .{ ".[\\^x]sh", ".]sh", false },
        .{ ".[^]sh", ".ssh", false },
        .{ ".[^]sh", ".^sh", true },
        .{ ".[^]sh", ".xsh", false },
        .{ ".[^]sh", ".-sh", false },
        .{ ".[^]sh", ".]sh", false },
        .{ ".[]sh", ".ssh", false },
        .{ ".[]sh", ".^sh", false },
        .{ ".[]sh", ".xsh", false },
        .{ ".[]sh", ".-sh", false },
        .{ ".[]sh", ".]sh", false },
        .{ ".[^a-z]sh", ".ssh", true },
        .{ ".[^a-z]sh", ".^sh", true },
        .{ ".[^a-z]sh", ".xsh", true },
        .{ ".[^a-z]sh", ".-sh", false },
        .{ ".[^a-z]sh", ".]sh", false },
        .{ ".[^-x]sh", ".ssh", true },
        .{ ".[^-x]sh", ".^sh", true },
        .{ ".[^-x]sh", ".xsh", true },
        .{ ".[^-x]sh", ".-sh", false },
        .{ ".[^-x]sh", ".]sh", false },
        .{ ".[a-]sh", ".ssh", false },
        .{ ".[a-]sh", ".^sh", false },
        .{ ".[a-]sh", ".xsh", false },
        .{ ".[a-]sh", ".-sh", true },
        .{ ".[a-]sh", ".]sh", false },
        .{ ".[--a]sh", ".ssh", true },
        .{ ".[--a]sh", ".^sh", true },
        .{ ".[--a]sh", ".xsh", true },
        .{ ".[--a]sh", ".-sh", true },
        .{ ".[--a]sh", ".]sh", true },
        .{ ".[s-]sh", ".ssh", true },
        .{ ".[s-]sh", ".^sh", false },
        .{ ".[s-]sh", ".xsh", false },
        .{ ".[s-]sh", ".-sh", true },
        .{ ".[s-]sh", ".]sh", false },
        .{ ".[^^]sh", ".ssh", false },
        .{ ".[^^]sh", ".^sh", true },
        .{ ".[^^]sh", ".xsh", false },
        .{ ".[^^]sh", ".-sh", false },
        .{ ".[^^]sh", ".]sh", false },
        .{ ".[x^]sh", ".ssh", false },
        .{ ".[x^]sh", ".^sh", true },
        .{ ".[x^]sh", ".xsh", true },
        .{ ".[x^]sh", ".-sh", false },
        .{ ".[x^]sh", ".]sh", false },
        .{ ".[a-c^]sh", ".ssh", false },
        .{ ".[a-c^]sh", ".^sh", true },
        .{ ".[a-c^]sh", ".xsh", false },
        .{ ".[a-c^]sh", ".-sh", false },
        .{ ".[a-c^]sh", ".]sh", false },
        .{ ".[z-a]sh", ".ssh", null },
        .{ ".[z-a]sh", ".^sh", null },
        .{ ".[z-a]sh", ".xsh", null },
        .{ ".[z-a]sh", ".-sh", null },
        .{ ".[z-a]sh", ".]sh", null },
        .{ ".[^z-a]sh", ".ssh", null },
        .{ ".[^z-a]sh", ".^sh", null },
        .{ ".[^z-a]sh", ".xsh", null },
        .{ ".[^z-a]sh", ".-sh", null },
        .{ ".[^z-a]sh", ".]sh", null },
        .{ ".[s", ".ssh", null },
        .{ ".[s", ".^sh", null },
        .{ ".[s", ".xsh", null },
        .{ ".[s", ".-sh", null },
        .{ ".[s", ".]sh", null },
    };
    for (rows) |r| {
        const got = try glob_re.matches(gpa, r[0], r[1]);
        std.testing.expectEqual(r[2], got) catch |e| {
            std.debug.print("pattern {s} literal {s}\n", .{ r[0], r[1] });
            return e;
        };
    }
}

test "l1: a class that holds the credential directory letter is denied, one that does not is allowed" {
    const scope: l1.Scope = .{ .root = "/work/wt", .home = "/home/u", .default_branch = "main" };
    const cases = [_]struct { []const u8, core.Verdict }{
        .{ "cat /home/u/.[^s]sh/id_rsa", .deny },
        .{ "cat /home/u/.[^x]sh/id_rsa", .allow },
        .{ "cat /home/u/.[\\^x]sh/id_rsa", .allow },
        .{ "cat /home/u/.[^]sh/x", .allow },
        .{ "cat /home/u/.[]sh/x", .allow },
        .{ "cat /home/u/.[^a-z]sh/id_rsa", .deny },
        .{ "cat /home/u/.[a-]sh/id_rsa", .allow },
    };
    for (cases) |c| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const r = try l1.evaluate(arena.allocator(), gpa, io, .{ .kind = .execute, .command = c[0] }, scope);
        try std.testing.expectEqual(c[1], r.verdict);
    }
}
