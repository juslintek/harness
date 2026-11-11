//! Guard level 2: asks Laya whether an action that L1 let through looks destructive or like
//! exfiltration. Port of guard/l2.ts. L2 can only raise an L1 allow to ask or deny; an L1 ask or
//! deny comes back unchanged and Laya is not called.
const std = @import("std");
const Allocator = std.mem.Allocator;
const client_mod = @import("../laya/client.zig");
const parity = @import("../parity.zig");
const core = @import("rules_core.zig");

pub const Verdict = core.Verdict;
pub const Category = core.Category;
pub const L1Result = core.Result;

pub const Source = enum { laya, fallback, l1 };

pub const Probs = struct { destructive: f64, exfiltration: f64, out_of_scope: f64, risk: f64 };

/// Field order is the wire order of the TS `L2Result`, so std.json writes what is stored in
/// `approvals.l2`.
pub const Result = struct {
    verdict: Verdict,
    reason: []const u8,
    source: Source,
    probs: ?Probs,
};

pub const guard_timeout_ms: i64 = 1500;
pub const min_command_chars: usize = 15;
pub const max_command_chars: usize = 1000;
pub const max_request_chars: usize = 500;
/// Tuned on live Ollaya answers for ordinary and dangerous commands (laya-guide.md, "Phase 1
/// tuning"). out_of_scope and risk are asked and logged but do not decide: both flagged `cat`,
/// `git add` and `git commit` at 0.7 to 1.0. Destructive scored `ls -la` 0.90 and `sed -n` 0.94,
/// so the ask line sits just above the highest ordinary command.
pub const ask_destructive: f64 = 0.95;
pub const deny_exfiltration: f64 = 0.9;

/// The text goes to Laya as is, so it must stay byte-equal to l2.ts.
pub const questions = [_]client_mod.NamedQuestion{
    .{ .name = "destructive", .question = .{ .noul = .{ .instructions = "`command` deletes or overwrites work that is hard to recover." } } },
    .{ .name = "exfiltration", .question = .{ .noul = .{ .instructions = "`command` sends local files, secrets or environment values to another host." } } },
    .{ .name = "out_of_scope", .question = .{ .noul = .{ .instructions = "`command` is not needed to do what `request` asks." } } },
    .{ .name = "risk", .question = .{ .score = .{
        .instructions = "How much damage could `command` do?",
        .criteria = &.{ "harmless", "could lose local work", "could lose shared data, leak secrets or break production" },
    } } },
};

fn isHighRisk(category: Category) bool {
    return switch (category) {
        .shell, .network, .delete, .git_push, .secret => true,
        .read, .edit, .other => false,
    };
}

fn noulOf(answer: ?client_mod.Answer) ?f64 {
    const n = switch (answer orelse return null) {
        .noul => |n| n,
        else => return null,
    };
    return if (std.math.isFinite(n)) n else null;
}

/// Laya returns `score` for score questions; when it is missing, the expected level index from
/// the probabilities carries the same meaning. A level key that is not a number gives NaN, as
/// `Number("low")` does, and so no risk.
fn riskOf(answer: ?client_mod.Answer) ?f64 {
    const score = switch (answer orelse return null) {
        .score => |s| s,
        else => return null,
    };
    if (score.score) |value| return if (std.math.isFinite(value)) value else null;
    var total: f64 = 0;
    var expected: f64 = 0;
    for (score.probabilities) |prob| {
        expected += parity.jsNumber(prob.key) * prob.p;
        total += prob.p;
    }
    const risk = expected / total;
    return if (std.math.isFinite(risk)) risk else null;
}

fn fallback(a: Allocator, category: Category, why: []const u8) Allocator.Error!Result {
    const ask = isHighRisk(category);
    return .{
        .verdict = if (ask) .ask else .allow,
        .reason = if (ask)
            try std.fmt.allocPrint(a, "laya unavailable ({s}), high-risk category", .{why})
        else
            try std.fmt.allocPrint(a, "laya unavailable ({s})", .{why}),
        .source = .fallback,
        .probs = null,
    };
}

const Judged = struct { verdict: Verdict, reason: []const u8 };

fn judge(probs: Probs, category: Category) Judged {
    // Laya scored `cat` of an installed skill file and plain `git`/`rg` lines at 0.9+. A line made
    // only of read-only commands cannot send anything (a pipe into curl would not be category
    // read), and an unclassified shell line is left to a person instead of being denied outright.
    if (probs.exfiltration >= deny_exfiltration and category != .read) {
        return if (category == .shell)
            .{ .verdict = .ask, .reason = "laya flagged possible exfiltration" }
        else
            .{ .verdict = .deny, .reason = "likely exfiltration" };
    }
    if (probs.destructive >= ask_destructive) return .{ .verdict = .ask, .reason = "laya flagged the command" };
    return .{ .verdict = .allow, .reason = "laya found nothing" };
}

/// JS `text.slice(0, max_units)` on valid UTF-8. A cut through a surrogate pair leaves a lone
/// surrogate in JS, which JSON cannot carry as UTF-8; U+FFFD stands in for it, as in
/// auth/routes.zig `truncateUtf16`.
fn cutUtf16(a: Allocator, text: []const u8, max_units: usize) Allocator.Error![]const u8 {
    var units: usize = 0;
    var end: usize = 0;
    var it = (std.unicode.Utf8View.init(text) catch unreachable).iterator();
    while (it.nextCodepointSlice()) |slice| {
        const wide = (std.unicode.utf8Decode(slice) catch unreachable) >= 0x10000;
        const width: usize = if (wide) 2 else 1;
        if (units + width > max_units) {
            if (wide and units < max_units) return std.mem.concat(a, u8, &.{ text[0..end], "\u{fffd}" });
            break;
        }
        units += width;
        end += slice.len;
    }
    return text[0..end];
}

pub const Input = struct { request: []const u8, command: []const u8 };

/// `escalateL2`. Reasons and the cut text come from `a`, which an arena should back.
pub fn escalate(a: Allocator, client: *client_mod.Client, input: Input, l1: L1Result) Allocator.Error!Result {
    if (l1.verdict != .allow) return .{ .verdict = l1.verdict, .reason = l1.reason, .source = .l1, .probs = null };
    const command = parity.jsTrim(input.command);
    // Text that is not UTF-8 cannot be measured the way JS measures it, and cannot be sent.
    const units = parity.utf16Len(command) catch return fallback(a, l1.category, "bad_body");
    if (units < min_command_chars) return .{ .verdict = l1.verdict, .reason = "too short for laya", .source = .l1, .probs = null };
    if (!std.unicode.utf8ValidateSlice(input.request)) return fallback(a, l1.category, "bad_body");

    const state = .{
        .request = try cutUtf16(a, input.request, max_request_chars),
        .command = try cutUtf16(a, command, max_command_chars),
    };
    var res = try client.decide(state, &questions, guard_timeout_ms);
    defer res.deinit();
    const answers = switch (res) {
        .failed => |reason| return fallback(a, l1.category, @tagName(reason)),
        .ok => |*ok| ok,
    };
    const probs: Probs = .{
        .destructive = noulOf(answers.get("destructive")) orelse return fallback(a, l1.category, "bad_body"),
        .exfiltration = noulOf(answers.get("exfiltration")) orelse return fallback(a, l1.category, "bad_body"),
        .out_of_scope = noulOf(answers.get("out_of_scope")) orelse return fallback(a, l1.category, "bad_body"),
        .risk = riskOf(answers.get("risk")) orelse return fallback(a, l1.category, "bad_body"),
    };
    const judged = judge(probs, l1.category);
    return .{ .verdict = judged.verdict, .reason = judged.reason, .source = .laya, .probs = probs };
}

const testing = std.testing;
const stub_mod = @import("laya_stub.zig");

const Noul = struct { destructive: f64 = 0.1, exfiltration: f64 = 0.1, out_of_scope: f64 = 0.1 };
const default_risk = "{\"probabilities\":{\"0\":0.8,\"1\":0.15,\"2\":0.05}}";

/// A Laya reply carrying the four answers; `risk` is the fields of the score answer.
fn answerBody(buf: []u8, noul: Noul, risk: []const u8, truncated: bool) ![]const u8 {
    return std.fmt.bufPrint(buf,
        \\{{"model":"laya:en","state_truncated":{},"answers":{{"destructive":{{"type":"noul","noul":{d}}},"exfiltration":{{"type":"noul","noul":{d}}},"out_of_scope":{{"type":"noul","noul":{d}}},"risk":{{"type":"score",{s}}}}}}}
    , .{ truncated, noul.destructive, noul.exfiltration, noul.out_of_scope, risk[1 .. risk.len - 1] });
}

const allow_shell: L1Result = .{ .verdict = .allow, .rule = null, .reason = "ok", .category = .shell };

fn withCategory(category: Category) L1Result {
    var l1 = allow_shell;
    l1.category = category;
    return l1;
}

const default_command = "bun test src/webhook.test.ts";

/// Runs `escalate` against a stub answering with `replies`; returns the verdict, source and hits.
const Run = struct { result: Result, hits: u32, sent: []const u8 };

fn run(a: Allocator, replies: []const stub_mod.Reply, l1: L1Result, command: []const u8) !Run {
    const stub = try stub_mod.Stub.start(replies);
    defer stub.stop();
    var url_buf: [64]u8 = undefined;
    var client = client_mod.Client.init(testing.allocator, testing.io, stub.url(&url_buf));
    const result = try escalate(a, &client, .{ .request = "Add retry logic", .command = command }, l1);
    return .{ .result = result, .hits = stub.hits.load(.monotonic), .sent = try a.dupe(u8, stub.sent()) };
}

fn verdictFor(a: Allocator, noul: Noul, risk: []const u8, category: Category) !Result {
    var buf: [1024]u8 = undefined;
    const body = try answerBody(&buf, noul, risk, false);
    return (try run(a, &.{.{ .body = body }}, withCategory(category), default_command)).result;
}

test "guard l2: exfiltration 0.95 on a shell line asks, on a read-only line allows" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(Verdict.ask, (try verdictFor(a, .{ .exfiltration = 0.95 }, default_risk, .shell)).verdict);
    try testing.expectEqual(Verdict.allow, (try verdictFor(a, .{ .exfiltration = 0.95 }, default_risk, .read)).verdict);
}

test "guard l2: exfiltration 0.95 denies a network command with the laya source and probs" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const res = try verdictFor(arena.allocator(), .{ .exfiltration = 0.95 }, default_risk, .network);
    try testing.expectEqual(Verdict.deny, res.verdict);
    try testing.expectEqual(Source.laya, res.source);
    try testing.expectEqualStrings("likely exfiltration", res.reason);
    try testing.expectEqual(@as(f64, 0.95), res.probs.?.exfiltration);
}

test "guard l2: exact boundaries, exfiltration denies from 0.9 and destructive asks from 0.95" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(Verdict.allow, (try verdictFor(a, .{ .exfiltration = 0.89 }, default_risk, .network)).verdict);
    try testing.expectEqual(Verdict.deny, (try verdictFor(a, .{ .exfiltration = deny_exfiltration }, default_risk, .network)).verdict);
    try testing.expectEqual(Verdict.allow, (try verdictFor(a, .{ .destructive = 0.94 }, default_risk, .delete)).verdict);
    try testing.expectEqual(Verdict.ask, (try verdictFor(a, .{ .destructive = ask_destructive }, default_risk, .delete)).verdict);
}

test "guard l2: destructive 1.0 with out_of_scope 1.0 only asks" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const res = try verdictFor(arena.allocator(), .{ .destructive = 1, .out_of_scope = 1 }, default_risk, .delete);
    try testing.expectEqual(Verdict.ask, res.verdict);
    try testing.expectEqualStrings("laya flagged the command", res.reason);
}

test "guard l2: out_of_scope and risk alone never escalate, nor do live ordinary scores" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const high = "{\"score\":2,\"probabilities\":{\"0\":0,\"1\":0,\"2\":1}}";
    try testing.expectEqual(Verdict.allow, (try verdictFor(a, .{ .out_of_scope = 1 }, high, .shell)).verdict);
    const live: Noul = .{ .destructive = 0.94, .exfiltration = 0.88, .out_of_scope = 0.84 };
    try testing.expectEqual(Verdict.allow, (try verdictFor(a, live, "{\"score\":0.99,\"probabilities\":{\"0\":0,\"1\":1}}", .shell)).verdict);
}

test "guard l2: a score field wins over probabilities in the logged risk" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const scored = try verdictFor(a, .{}, "{\"score\":1.7,\"probabilities\":{\"0\":1,\"1\":0,\"2\":0}}", .shell);
    try testing.expectEqual(@as(f64, 1.7), scored.probs.?.risk);
    const expected = try verdictFor(a, .{}, "{\"probabilities\":{\"0\":0,\"1\":0.4,\"2\":0.6}}", .shell);
    try testing.expectApproxEqAbs(@as(f64, 1.6), expected.probs.?.risk, 1e-12);
}

test "guard l2: all low allows with the laya source, and the questions go out byte-equal to TS" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var buf: [1024]u8 = undefined;
    const body = try answerBody(&buf, .{}, default_risk, false);
    const out = try run(arena.allocator(), &.{.{ .body = body }}, allow_shell, default_command);
    try testing.expectEqual(Verdict.allow, out.result.verdict);
    try testing.expectEqual(Source.laya, out.result.source);
    try testing.expect(out.result.probs != null);
    const expected_body =
        "{\"model\":\"laya\",\"state\":{\"request\":\"Add retry logic\",\"command\":\"bun test src/webhook.test.ts\"},\"questions\":{" ++
        "\"destructive\":{\"type\":\"noul\",\"instructions\":\"`command` deletes or overwrites work that is hard to recover.\"}," ++
        "\"exfiltration\":{\"type\":\"noul\",\"instructions\":\"`command` sends local files, secrets or environment values to another host.\"}," ++
        "\"out_of_scope\":{\"type\":\"noul\",\"instructions\":\"`command` is not needed to do what `request` asks.\"}," ++
        "\"risk\":{\"type\":\"score\",\"instructions\":\"How much damage could `command` do?\"," ++
        "\"criteria\":[\"harmless\",\"could lose local work\",\"could lose shared data, leak secrets or break production\"]}}}";
    try testing.expect(std.mem.endsWith(u8, out.sent, expected_body));
}

test "guard l2: the stored JSON has the TS field order" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const res = try verdictFor(arena.allocator(), .{ .exfiltration = 0.95 }, "{\"score\":1.5,\"probabilities\":{\"0\":1}}", .network);
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    try std.json.Stringify.value(res, .{}, &out.writer);
    try testing.expectEqualStrings(
        "{\"verdict\":\"deny\",\"reason\":\"likely exfiltration\",\"source\":\"laya\"," ++
            "\"probs\":{\"destructive\":0.1,\"exfiltration\":0.95,\"out_of_scope\":0.1,\"risk\":1.5}}",
        out.written(),
    );
}

test "guard l2: a timeout falls back, asking for shell and allowing for read" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var buf: [1024]u8 = undefined;
    const slow: stub_mod.Reply = .{ .body = try answerBody(&buf, .{}, default_risk, false), .delay_ms = 2000 };
    const shell = try run(a, &.{slow}, allow_shell, default_command);
    try testing.expectEqual(Verdict.ask, shell.result.verdict);
    try testing.expectEqual(Source.fallback, shell.result.source);
    try testing.expectEqual(@as(?Probs, null), shell.result.probs);
    try testing.expectEqualStrings("laya unavailable (timeout), high-risk category", shell.result.reason);
    const read = try run(a, &.{slow}, withCategory(.read), default_command);
    try testing.expectEqual(Verdict.allow, read.result.verdict);
    try testing.expectEqualStrings("laya unavailable (timeout)", read.result.reason);
}

test "guard l2: a server that is down asks for network" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var client = client_mod.Client.init(testing.allocator, testing.io, "http://127.0.0.1:1");
    const res = try escalate(arena.allocator(), &client, .{ .request = "r", .command = default_command }, withCategory(.network));
    try testing.expectEqual(Verdict.ask, res.verdict);
    try testing.expectEqual(Source.fallback, res.source);
    try testing.expectEqualStrings("laya unavailable (down), high-risk category", res.reason);
}

test "guard l2: a truncated state falls back" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var buf: [1024]u8 = undefined;
    const body = try answerBody(&buf, .{}, default_risk, true);
    const push = try run(a, &.{.{ .body = body }}, withCategory(.git_push), default_command);
    try testing.expectEqual(Verdict.ask, push.result.verdict);
    try testing.expectEqual(Source.fallback, push.result.source);
    const edit = try run(a, &.{.{ .body = body }}, withCategory(.edit), default_command);
    try testing.expectEqual(Verdict.allow, edit.result.verdict);
    try testing.expectEqual(Source.fallback, edit.result.source);
}

test "guard l2: a response without the asked answers falls back" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const out = try run(arena.allocator(), &.{.{ .body = "{\"model\":\"laya:en\",\"answers\":{}}" }}, withCategory(.secret), default_command);
    try testing.expectEqual(Verdict.ask, out.result.verdict);
    try testing.expectEqual(Source.fallback, out.result.source);
}

test "guard l2: three failures open the circuit and the fourth call does not fetch" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const stub = try stub_mod.Stub.start(&.{.{ .status = 500, .body = "boom" }});
    defer stub.stop();
    var url_buf: [64]u8 = undefined;
    var client = client_mod.Client.init(testing.allocator, testing.io, stub.url(&url_buf));
    const input: Input = .{ .request = "r", .command = default_command };
    for (0..3) |_| _ = try escalate(arena.allocator(), &client, input, allow_shell);
    try testing.expectEqual(@as(u32, 3), stub.hits.load(.monotonic));
    const res = try escalate(arena.allocator(), &client, input, allow_shell);
    try testing.expectEqual(@as(u32, 3), stub.hits.load(.monotonic));
    try testing.expectEqual(Verdict.ask, res.verdict);
    try testing.expectEqualStrings("laya unavailable (circuit_open), high-risk category", res.reason);
}

test "guard l2: a non-numeric probability key without a score falls back" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const res = try verdictFor(arena.allocator(), .{}, "{\"probabilities\":{\"low\":0.5,\"high\":0.5}}", .shell);
    try testing.expectEqual(Verdict.ask, res.verdict);
    try testing.expectEqual(Source.fallback, res.source);
    try testing.expectEqual(@as(?Probs, null), res.probs);
}

test "guard l2: a whitespace-only command skips Laya and keeps the L1 verdict" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const out = try run(arena.allocator(), &.{.{ .body = "{}" }}, allow_shell, " \u{00a0}\t                 ");
    try testing.expectEqual(@as(u32, 0), out.hits);
    try testing.expectEqual(Verdict.allow, out.result.verdict);
    try testing.expectEqual(Source.l1, out.result.source);
}

test "guard l2: a command under 15 characters skips Laya, a non-allow L1 passes through" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "bun test", "make", "cat a.ts", "\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}\u{0105}" }) |command| {
        const out = try run(a, &.{.{ .body = "{}" }}, allow_shell, command);
        try testing.expectEqual(@as(u32, 0), out.hits);
        try testing.expectEqual(Verdict.allow, out.result.verdict);
        try testing.expectEqualStrings("too short for laya", out.result.reason);
        try testing.expectEqual(Source.l1, out.result.source);
    }
    const ask: L1Result = .{ .verdict = .ask, .rule = "r1", .reason = "needs a human", .category = .shell };
    const kept = try run(a, &.{.{ .body = "{}" }}, ask, "git push");
    try testing.expectEqual(Verdict.ask, kept.result.verdict);
}

test "guard l2: an L1 ask or deny comes back unchanged without a call" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var buf: [1024]u8 = undefined;
    const flagged: stub_mod.Reply = .{ .body = try answerBody(&buf, .{ .exfiltration = 0.99 }, default_risk, false) };
    const ask: L1Result = .{ .verdict = .ask, .rule = "r1", .reason = "needs a human", .category = .shell };
    const asked = try run(a, &.{flagged}, ask, default_command);
    try testing.expectEqual(@as(u32, 0), asked.hits);
    try testing.expectEqual(Verdict.ask, asked.result.verdict);
    try testing.expectEqualStrings("needs a human", asked.result.reason);
    try testing.expectEqual(Source.l1, asked.result.source);
    try testing.expectEqual(@as(?Probs, null), asked.result.probs);
    const deny: L1Result = .{ .verdict = .deny, .rule = "r2", .reason = "forbidden", .category = .delete };
    const denied = try run(a, &.{flagged}, deny, default_command);
    try testing.expectEqual(Verdict.deny, denied.result.verdict);
    try testing.expectEqual(@as(u32, 0), denied.hits);
}

test "guard l2: the text sent to Laya is cut in UTF-16 units, trimmed first" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("abc", try cutUtf16(a, "abcdef", 3));
    try testing.expectEqualStrings("abcdef", try cutUtf16(a, "abcdef", 6));
    try testing.expectEqualStrings("\u{0105}\u{0105}", try cutUtf16(a, "\u{0105}\u{0105}\u{0105}", 2));
    try testing.expectEqualStrings("a\u{1F600}", try cutUtf16(a, "a\u{1F600}b", 3));
    try testing.expectEqualStrings("a\u{fffd}", try cutUtf16(a, "a\u{1F600}b", 2));
    var long: [1100]u8 = undefined;
    @memset(&long, 'x');
    var padded: [1104]u8 = undefined;
    @memcpy(padded[0..2], "  ");
    @memcpy(padded[2..][0..1100], &long);
    @memcpy(padded[1102..], "\t\n");
    var buf: [1024]u8 = undefined;
    const body = try answerBody(&buf, .{}, default_risk, false);
    const out = try run(a, &.{.{ .body = body }}, allow_shell, &padded);
    const cut: [1000]u8 = @splat('x');
    const sent_state = try std.mem.concat(a, u8, &.{ "\"command\":\"", &cut, "\"}" });
    try testing.expect(std.mem.find(u8, out.sent, sent_state) != null);
}

test "guard l2: building a fallback survives every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn go(gpa: Allocator) !void {
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            _ = try fallback(arena.allocator(), .network, "timeout");
            _ = try cutUtf16(arena.allocator(), "a\u{1F600}b", 2);
        }
    }.go, .{});
}
