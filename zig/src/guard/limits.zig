//! What a manager agent, or a human who only administers an org, may never approve. Port of
//! guard/manager-limits.ts. Policies and autonomy are not ported (phase 3): `autonomy` is always
//! null, so a strict policy is not honored by `managerMayDecide` yet.
//!
//! The org tables are read with the SQL in the "org reads" section until orgs/repo.zig has the
//! same lookups; that section is the only place here that touches them.
const std = @import("std");
const Allocator = std.mem.Allocator;
const approvals = @import("approvals.zig");
const ids = @import("../ids.zig");
const l2 = @import("l2.zig");
const logs = @import("../logs/api.zig");
const sqlite = @import("../db/sqlite.zig");

pub const ActionContext = struct {
    category: ?[]const u8,
    rule: ?[]const u8,
    kind: []const u8,
    command: []const u8,
    paths: []const []const u8,
    harness_home: []const u8,
    exfiltration: f64,
    /// False when the stored action, l1 or l2 could not be read as the guard wrote it.
    readable: bool = true,
};

pub const Autonomy = struct { value: []const u8, layer: []const u8 };

pub const DecideContext = struct {
    action: ActionContext,
    requester_member_id: ?[]const u8,
    manager_member_id: []const u8,
    in_subtree: bool,
    /// False when the run works in a project owned by another org than the manager's.
    owns_project: bool,
    /// Anything but full autonomy keeps the decision with a human.
    autonomy: ?Autonomy = null,
};

/// Text that points at the harness itself, its sandbox or its agent config: a manager agent must
/// never wave those through, whoever asks. Matched without a leading slash so relative paths count.
const forbidden = [_][]const u8{
    "features/guard", "features/auth",    "features/policies", "deploy",     "srt",
    "sandbox",        ".claude/settings", ".codex/",           "codex_home", "harness_",
};
/// A guard rule that means the guard could not see what really runs or that widens the scope.
const blind_rules = [_][]const u8{ "exec.escalate", "env.injection" };

// ---- JavaScript string semantics ------------------------------------------------------------

/// WhiteSpace and LineTerminator of ECMA-262, which is what a regex `\s` matches.
fn isJsSpace(cp: u21) bool {
    return switch (cp) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        0x2000...0x200a => true,
        else => false,
    };
}

/// The code point at `i` and its byte length; null for bytes that are not valid UTF-8.
fn decodeAt(s: []const u8, i: usize) ?struct { u21, usize } {
    const len = std.unicode.utf8ByteSequenceLength(s[i]) catch return null;
    if (i + len > s.len) return null;
    const cp = std.unicode.utf8Decode(s[i..][0..len]) catch return null;
    return .{ cp, len };
}

/// The code point that ends right before `end`, for the `cd` check.
fn decodeBefore(s: []const u8, end: usize) ?u21 {
    var start = end - 1;
    while (start > 0 and s[start] & 0xc0 == 0x80) start -= 1;
    const decoded = decodeAt(s, start) orelse return null;
    return if (start + decoded[1] == end) decoded[0] else null;
}

/// True for a code point `lowerCp` folds exactly like JS and that has no other fold: ASCII, Latin-1,
/// Latin Extended-A, the Greek and Cyrillic letters it maps and the Kelvin sign. Left out: the micro
/// sign, sharp s, dotless i, n with a preceding apostrophe and long s (all fold to other letters),
/// Greek capital sigma and final sigma (JS lowers sigma by context).
fn folds(cp: u21) bool {
    return switch (cp) {
        0x0...0xb4, 0xb6...0xde, 0xe0...0x130, 0x132...0x148, 0x14a...0x17e, 0x391...0x3a1, 0x3a4...0x3a9, 0x3b1...0x3c1, 0x3c3...0x3c9, 0x400...0x45f, 0x212a => true,
        else => false,
    };
}

/// Scripts without case: general punctuation to currency signs, kana, CJK, Hangul and emoji.
fn uncased(cp: u21) bool {
    return switch (cp) {
        0x2000...0x20ff, 0x3040...0x9fff, 0xac00...0xd7a3, 0x1f300...0x1faff => true,
        else => false,
    };
}

/// Code points with one spelling in every Unicode normalization form: CJK ideographs, punctuation
/// and emoji. Kana and Hangul are caseless but have composed and decomposed forms.
fn stable(cp: u21) bool {
    return switch (cp) {
        0x2002...0x20ff, 0x4e00...0x9fff, 0x1f300...0x1faff => true,
        else => false,
    };
}

fn isAscii(text: []const u8) bool {
    for (text) |byte| if (byte >= 0x80) return false;
    return true;
}

/// Whether `hit` holds for a code point of `text`. Bytes that are not UTF-8 count as a hit.
fn anyCodepoint(text: []const u8, comptime hit: fn (u21) bool) bool {
    var i: usize = 0;
    while (i < text.len) {
        const decoded = decodeAt(text, i) orelse return true;
        if (hit(decoded[0])) return true;
        i += decoded[1];
    }
    return false;
}

/// A letter `jsLower` might leave in the wrong case, or one it never saw.
fn isUnfoldable(cp: u21) bool {
    return !folds(cp) and !uncased(cp);
}

/// Anything that could be written in another normalization form.
fn isUnstable(cp: u21) bool {
    return cp >= 0x80 and !stable(cp);
}

/// `toLowerCase` for ASCII, Latin-1, Latin Extended-A, Greek and Cyrillic letters. Other scripts
/// pass through unchanged. Capital sigma too: JS lowers it to sigma or final sigma by position, so
/// it stays as it is and `folds` does not know it, which sends the action to a human.
fn lowerCp(cp: u21) u21 {
    return switch (cp) {
        'A'...'Z', 0xc0...0xd6, 0xd8...0xde, 0x391...0x3a1, 0x3a4...0x3a9, 0x410...0x42f => cp + 32,
        0x400...0x40f => cp + 80,
        0x100...0x12f, 0x132...0x137, 0x14a...0x177 => if (cp % 2 == 0) cp + 1 else cp,
        0x139...0x148, 0x179...0x17e => if (cp % 2 == 1) cp + 1 else cp,
        0x178 => 0xff,
        0x212a => 'k',
        else => cp,
    };
}

fn jsLower(a: Allocator, text: []const u8) Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        const decoded = decodeAt(text, i) orelse {
            try out.append(a, std.ascii.toLower(text[i]));
            i += 1;
            continue;
        };
        if (decoded[0] == 0x130) {
            try out.appendSlice(a, "i\u{307}");
        } else {
            var buf: [4]u8 = undefined;
            const n = std.unicode.utf8Encode(lowerCp(decoded[0]), &buf) catch unreachable;
            try out.appendSlice(a, buf[0..n]);
        }
        i += decoded[1];
    }
    return out.items;
}

/// `/['"\\*?[\]{}$`]|(^|[\s;&|(])cd\s/`. Quoting, escapes, globs, expansions and `cd` change what
/// actually runs after the guard looked at the text, so a human must read those commands.
fn hasShellIndirection(command: []const u8) bool {
    if (std.mem.findAny(u8, command, "'\"\\*?[]{}$`") != null) return true;
    var from: usize = 0;
    while (std.mem.findPos(u8, command, from, "cd")) |at| : (from = at + 1) {
        const after = at + 2;
        if (after >= command.len) continue;
        const next = decodeAt(command, after) orelse continue;
        if (!isJsSpace(next[0])) continue;
        if (at == 0) return true;
        const before = decodeBefore(command, at) orelse continue;
        if (isJsSpace(before) or (before < 0x80 and std.mem.findScalar(u8, ";&|(", @intCast(before)) != null)) return true;
    }
    return false;
}

/// Byte length of the delimiter that starts at `i`, or 0: `[\s"'=:;|&<>()]`.
fn delimiterLen(s: []const u8, i: usize) usize {
    if (std.mem.findScalar(u8, "\"'=:;|&<>()", s[i]) != null) return 1;
    const decoded = decodeAt(s, i) orelse return 0;
    return if (isJsSpace(decoded[0])) decoded[1] else 0;
}

/// `/\/+/g` to "/" and then `/(\/\.)+(?=\/|$)/g` to "". When the greedy run of `/.` is followed
/// by neither `/` nor the end, the regex gives back its last `/.`, which is then followed by `/`.
fn flatten(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var slashes: std.ArrayList(u8) = .empty;
    for (text, 0..) |byte, i| {
        if (byte == '/' and i > 0 and text[i - 1] == '/') continue;
        try slashes.append(a, byte);
    }
    const s = slashes.items;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        var j = i;
        var runs: usize = 0;
        while (j + 1 < s.len and s[j] == '/' and s[j + 1] == '.') : (j += 2) runs += 1;
        if (runs > 0 and j < s.len and s[j] != '/') runs -= 1;
        if (runs == 0) {
            try out.append(a, s[i]);
            i += 1;
        } else {
            i += 2 * runs;
        }
    }
    return out.items;
}

/// Node's `path.posix.normalize`.
fn normalizePosix(a: Allocator, path: []const u8) Allocator.Error![]const u8 {
    if (path.len == 0) return ".";
    const absolute = path[0] == '/';
    const trailing = path[path.len - 1] == '/';
    var parts: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".")) continue;
        if (!std.mem.eql(u8, part, "..")) {
            try parts.append(a, part);
        } else if (parts.items.len > 0 and !std.mem.eql(u8, parts.items[parts.items.len - 1], "..")) {
            _ = parts.pop();
        } else if (!absolute) {
            try parts.append(a, part);
        }
    }
    const body = try std.mem.join(a, "/", parts.items);
    if (body.len == 0) return if (absolute) "/" else if (trailing) "./" else ".";
    const tail = if (trailing) "/" else "";
    return std.mem.concat(a, u8, &.{ if (absolute) "/" else "", body, tail });
}

/// `..` is resolved per word so `/repo/../../x/.harness` cannot hide the target; `/./` and
/// repeated slashes are collapsed first.
fn normalizeText(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    const flat = try flatten(a, try jsLower(a, text));
    var all: std.ArrayList(u8) = .empty;
    try all.appendSlice(a, flat);
    var start: usize = 0;
    var i: usize = 0;
    while (i <= flat.len) {
        const skip = if (i < flat.len) delimiterLen(flat, i) else 1;
        if (skip == 0) {
            i += if (decodeAt(flat, i)) |d| d[1] else 1;
            continue;
        }
        const word = flat[start..@min(i, flat.len)];
        if (std.mem.findScalar(u8, word, '/') != null) {
            try all.append(a, '\n');
            try all.appendSlice(a, try normalizePosix(a, word));
        }
        i += skip;
        start = i;
    }
    return all.items;
}

// ---- the refusals ---------------------------------------------------------------------------

fn includes(text: []const u8, needle: []const u8) bool {
    return needle.len == 0 or std.mem.find(u8, text, needle) != null;
}

const unreadable = "the stored action cannot be read; a human must decide";

/// What only the instance admin may wave through, whoever else asks: a manager agent or a human
/// who administers an org. Such an org can be anyone's personal org, so it earns no host trust.
/// Relative paths resolve against the process directory, like `path.resolve` in TS.
pub fn actionRefusal(a: Allocator, io: std.Io, ctx: ActionContext) !?[]const u8 {
    if (!ctx.readable) return unreadable;
    const category = ctx.category orelse "";
    if (std.mem.eql(u8, category, "network") or std.mem.eql(u8, category, "secret") or std.mem.eql(u8, ctx.kind, "fetch")) {
        return "network and secret actions need a human";
    }
    if (ctx.exfiltration >= l2.deny_exfiltration) return "laya flagged possible exfiltration";
    if (ctx.rule) |rule| {
        var blind = std.mem.endsWith(u8, rule, ".outside-root");
        for (blind_rules) |name| blind = blind or std.mem.eql(u8, rule, name);
        if (blind) return try std.fmt.allocPrint(a, "the guard rule {s} needs a human", .{rule});
    }
    if (hasShellIndirection(ctx.command)) return "command uses shell indirection; a human must decide";

    const cwd = try std.process.currentPathAlloc(io, a);
    var joined: std.ArrayList(u8) = .empty;
    try joined.appendSlice(a, ctx.command);
    for (ctx.paths) |path| {
        try joined.append(a, '\n');
        try joined.appendSlice(a, try std.fs.path.resolvePosix(a, &.{ cwd, path }));
    }
    const text = try normalizeText(a, joined.items);
    const harness = try jsLower(a, try std.fs.path.resolvePosix(a, &.{ cwd, ctx.harness_home }));
    if (includes(text, harness) or includes(text, std.fs.path.basenamePosix(harness))) return "the action touches the harness home";
    // `jsLower` is JS `toLowerCase` for the scripts in `folds` and nothing else, which is not what a
    // volume does when it ignores case (macOS does by default). So a letter we cannot fold, in any
    // script or as a combining mark, goes to a human whatever the harness path is called. When the
    // path itself is not ASCII, any letter with a second spelling in another normalization form
    // does too, because NFC and NFD name one directory. Not covered: code points a filesystem
    // ignores altogether, and case or normalization rules that differ from Unicode's.
    // Cost: with an ASCII home this refuses every code point outside `folds` and `uncased`, such as
    // arrows, check marks and Hebrew or Arabic file names. With a non-ASCII home it also refuses
    // plain letters such as U+0142. Org owners and managers get 403 for those where TS allows them.
    // Known fail-closed divergence; the instance admin can still decide.
    if (anyCodepoint(text, isUnfoldable) or (!isAscii(harness) and anyCodepoint(text, isUnstable))) {
        return "the action may touch the harness home; a human must decide";
    }
    for (forbidden) |word| {
        if (includes(text, word)) return try std.fmt.allocPrint(a, "the action mentions {s}", .{word});
    }
    return null;
}

pub fn managerMayDecide(a: Allocator, io: std.Io, ctx: DecideContext) !?[]const u8 {
    const requester = ctx.requester_member_id orelse return "the run has no member";
    if (std.mem.eql(u8, requester, ctx.manager_member_id)) return "managers cannot decide their own request";
    if (!ctx.in_subtree) return "the requester does not report to you";
    if (!ctx.owns_project) return "the run works on another org's project; a human must decide";
    if (ctx.autonomy) |autonomy| {
        if (!std.mem.eql(u8, autonomy.value, "full")) {
            return try std.fmt.allocPrint(a, "autonomy is {s} ({s})", .{ autonomy.value, autonomy.layer });
        }
    }
    return actionRefusal(a, io, ctx.action);
}

// ---- reading an approval's stored JSON ------------------------------------------------------

fn objectOf(a: Allocator, text: ?[]const u8) Allocator.Error!?std.json.ObjectMap {
    const bytes = text orelse return null;
    const value = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{ .duplicate_field_behavior = .use_last }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return null,
    };
    return if (value == .object) value.object else null;
}

fn nonEmpty(text: []const u8) ?[]const u8 {
    return if (text.len == 0) null else text;
}

/// The score, 0 when there is none, null when it is present but not a number.
fn exfiltrationOf(l2_object: ?std.json.ObjectMap) ?f64 {
    const probs = (l2_object orelse return 0).get("probs") orelse return 0;
    if (probs != .object) return 0;
    const score = probs.object.get("exfiltration") orelse return 0;
    return switch (score) {
        .integer => |n| @floatFromInt(n),
        .float => |f| f,
        else => null,
    };
}

/// The string at `key`: "" when the key is missing, null when it holds anything else.
fn textAt(object: ?std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = (object orelse return "").get(key) orelse return "";
    return if (value == .string) value.string else null;
}

/// The guard writes `"rule": null` for an allow without a rule, so null is no rule, not a bad one.
fn ruleAt(l1: ?std.json.ObjectMap) ?[]const u8 {
    const value = (l1 orelse return "").get("rule") orelse return "";
    return if (value == .null) "" else textAt(l1, "rule");
}

/// TS reads a field that is not text as "" and a row it cannot parse as empty, so the checks then
/// run on nothing and pass. Here a row that does not parse, or whose command, kind or paths are not
/// text, or an l1 category or rule that is not text, or an l2 exfiltration that is not a number, is
/// marked `readable = false` and `actionRefusal` leaves it to a human.
fn actionContext(a: Allocator, row: approvals.Row, harness_home: []const u8) Allocator.Error!ActionContext {
    const action = try objectOf(a, row.action);
    const l1 = try objectOf(a, row.l1);
    const l2_object = try objectOf(a, row.l2);
    var readable = action != null and l1 != null and (row.l2 == null or l2_object != null);
    const kind = textAt(action, "kind") orelse blk: {
        readable = false;
        break :blk "";
    };
    const command = textAt(action, "command") orelse blk: {
        readable = false;
        break :blk "";
    };
    var paths: []const []const u8 = &.{};
    if (action) |object| if (object.get("paths")) |value| {
        if (value == .array) {
            const list = try a.alloc([]const u8, value.array.items.len);
            for (value.array.items, list) |item, *slot| {
                slot.* = if (item == .string) item.string else "";
                if (item != .string) readable = false;
            }
            paths = list;
        } else readable = false;
    };
    const category = textAt(l1, "category") orelse blk: {
        readable = false;
        break :blk "";
    };
    const rule = ruleAt(l1) orelse blk: {
        readable = false;
        break :blk "";
    };
    const exfiltration = exfiltrationOf(l2_object) orelse blk: {
        readable = false;
        break :blk 0;
    };
    return .{
        .category = nonEmpty(category),
        .rule = nonEmpty(rule),
        .kind = kind,
        .command = command,
        .paths = paths,
        .harness_home = harness_home,
        .exfiltration = exfiltration,
        .readable = readable,
    };
}

/// What `POST /api/approvals/:id` checks for a user who is not the instance admin.
pub fn orgAdminRefusal(a: Allocator, io: std.Io, row: approvals.Row, harness_home: []const u8) !?[]const u8 {
    return actionRefusal(a, io, try actionContext(a, row, harness_home));
}

// ---- org reads: the only SQL here on org tables, to be swapped for orgs/repo.zig ------------

const Position = struct { id: []const u8, org_id: []const u8 };
pub const RunLink = struct { member_id: ?[]const u8, project_id: ?[]const u8 };
const depth_cap = 32;

fn selectOne(db: sqlite.Db, a: Allocator, sql: []const u8, arg: []const u8) !?[]const u8 {
    const stmt = try db.prepare(sql);
    defer stmt.finalize();
    try stmt.bindText(1, arg);
    if (!try stmt.step()) return null;
    return try stmt.textAlloc(a, 0);
}

pub fn runLinkOf(db: sqlite.Db, a: Allocator, run_id: []const u8) !?RunLink {
    const stmt = try db.prepare("SELECT member_id, project_id FROM runs WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, run_id);
    if (!try stmt.step()) return null;
    return .{ .member_id = try stmt.textAlloc(a, 0), .project_id = try stmt.textAlloc(a, 1) };
}

pub fn memberOrg(db: sqlite.Db, a: Allocator, member_id: []const u8) !?[]const u8 {
    return selectOne(db, a, "SELECT org_id FROM members WHERE id = ?", member_id);
}

pub fn projectOrg(db: sqlite.Db, a: Allocator, project_id: []const u8) !?[]const u8 {
    return selectOne(db, a, "SELECT org_id FROM projects WHERE id = ?", project_id);
}

fn managerPositionsOf(db: sqlite.Db, a: Allocator, member_id: []const u8) ![]Position {
    const stmt = try db.prepare("SELECT id, org_id FROM positions WHERE member_id = ? AND is_manager = 1 ORDER BY created_at, id");
    defer stmt.finalize();
    try stmt.bindText(1, member_id);
    var rows: std.ArrayList(Position) = .empty;
    while (try stmt.step()) try rows.append(a, .{ .id = (try stmt.textAlloc(a, 0)).?, .org_id = (try stmt.textAlloc(a, 1)).? });
    return rows.items;
}

/// Walks up from every position the member holds, at most `depth_cap` steps each.
fn reportsTransitivelyTo(db: sqlite.Db, a: Allocator, member_id: []const u8, manager_position_id: []const u8) !bool {
    const held = try db.prepare("SELECT reports_to FROM positions WHERE member_id = ?");
    defer held.finalize();
    try held.bindText(1, member_id);
    while (try held.step()) {
        var at: ?[]const u8 = try held.textAlloc(a, 0);
        var depth: usize = 0;
        while (at) |reports_to| : (depth += 1) {
            if (depth >= depth_cap) break;
            if (std.mem.eql(u8, reports_to, manager_position_id)) return true;
            at = try selectOne(db, a, "SELECT reports_to FROM positions WHERE id = ?", reports_to);
        }
    }
    return false;
}

fn contextFor(a: Allocator, db: sqlite.Db, row: approvals.Row, manager_member_id: []const u8, harness_home: []const u8) !DecideContext {
    const run = try runLinkOf(db, a, row.run_id);
    const requester_member_id = if (run) |r| r.member_id else null;
    var in_subtree = false;
    if (requester_member_id) |requester| if (try memberOrg(db, a, requester)) |requester_org| {
        for (try managerPositionsOf(db, a, manager_member_id)) |position| {
            if (std.mem.eql(u8, position.org_id, requester_org) and try reportsTransitivelyTo(db, a, requester, position.id)) {
                in_subtree = true;
                break;
            }
        }
    };
    // A grantee org's manager may lead the requester, yet the project and its repo are the owner's.
    var owns_project = true;
    if (run) |r| if (r.project_id) |project_id| if (project_id.len > 0) {
        const owner = try projectOrg(db, a, project_id);
        const mine = try memberOrg(db, a, manager_member_id);
        owns_project = owner != null and mine != null and std.mem.eql(u8, owner.?, mine.?);
    };
    return .{
        .action = try actionContext(a, row, harness_home),
        .requester_member_id = requester_member_id,
        .manager_member_id = manager_member_id,
        .in_subtree = in_subtree,
        .owns_project = owns_project,
    };
}

// ---- the manager's view and decision --------------------------------------------------------

/// Pending, unexpired approvals the manager may decide.
pub fn decidableApprovals(a: Allocator, io: std.Io, db: sqlite.Db, manager_member_id: []const u8, harness_home: []const u8, now_ms: i64) ![]approvals.Row {
    var out: std.ArrayList(approvals.Row) = .empty;
    for (try approvals.list(db, a, .pending)) |row| {
        if (row.expires_at <= now_ms) continue;
        const ctx = try contextFor(a, db, row, manager_member_id, harness_home);
        if (try managerMayDecide(a, io, ctx) == null) try out.append(a, row);
    }
    return out.items;
}

pub const DecideInput = struct {
    approval_id: []const u8,
    manager_member_id: []const u8,
    harness_home: []const u8,
    decision: approvals.Decision,
    reason: []const u8,
};

pub const DecideOutcome = union(enum) { ok, refused: []const u8 };

pub fn managerDecide(a: Allocator, io: std.Io, db: sqlite.Db, input: DecideInput) !DecideOutcome {
    const row = try approvals.get(db, a, input.approval_id) orelse return .{ .refused = "unknown approval" };
    const ctx = try contextFor(a, db, row, input.manager_member_id, input.harness_home);
    if (try managerMayDecide(a, io, ctx)) |refusal| return .{ .refused = refusal };
    const by = try std.fmt.allocPrint(a, "agent:{s}", .{input.manager_member_id});
    const now = ids.nowMs(io);
    if (!try approvals.decide(db, row.id, input.decision, by, now)) return .{ .refused = "not pending" };
    const command = if (ctx.action.command.len > 0) ctx.action.command else try std.mem.join(a, " ", ctx.action.paths);
    const approved = input.decision == .approve;
    const event_id = ids.uuidV7(io);
    _ = try logs.appendEvent(a, db, &event_id, now, .{
        .run_id = row.run_id,
        .kind = .guard,
        .guard_layer = .L3,
        .guard_verdict = if (approved) .allow else .deny,
        .guard_rule = input.reason,
        .source = "manager_agent",
        .command = command,
        .body = try std.fmt.allocPrint(a, "{s} by {s}", .{ if (approved) "approve" else "deny", by }),
    });
    return .ok;
}

const testing = std.testing;
const Fixture = @import("../auth/fixture.zig").Fixture;

const home = "/Users/x/.harness";

const base: DecideContext = .{
    .action = .{ .category = "shell", .rule = null, .kind = "execute", .command = "bun test", .paths = &.{}, .harness_home = home, .exfiltration = 0 },
    .requester_member_id = "r",
    .manager_member_id = "m",
    .in_subtree = true,
    .owns_project = true,
};

/// Fields that replace those of `base`; unset ones keep the base value.
const Change = struct {
    no_requester: bool = false,
    requester: ?[]const u8 = null,
    in_subtree: ?bool = null,
    owns_project: ?bool = null,
    category: ?[]const u8 = null,
    rule: ?[]const u8 = null,
    kind: ?[]const u8 = null,
    command: ?[]const u8 = null,
    paths: ?[]const []const u8 = null,
    harness_home: ?[]const u8 = null,
    exfiltration: ?f64 = null,

    fn on(c: Change) DecideContext {
        var ctx = base;
        if (c.no_requester) ctx.requester_member_id = null;
        if (c.requester) |v| ctx.requester_member_id = v;
        if (c.in_subtree) |v| ctx.in_subtree = v;
        if (c.owns_project) |v| ctx.owns_project = v;
        if (c.category) |v| ctx.action.category = v;
        if (c.rule) |v| ctx.action.rule = v;
        if (c.kind) |v| ctx.action.kind = v;
        if (c.command) |v| ctx.action.command = v;
        if (c.paths) |v| ctx.action.paths = v;
        if (c.harness_home) |v| ctx.action.harness_home = v;
        if (c.exfiltration) |v| ctx.action.exfiltration = v;
        return ctx;
    }
};

fn mayDecide(a: Allocator, ctx: DecideContext) !?[]const u8 {
    return managerMayDecide(a, testing.io, ctx);
}

test "guard limits: refuses what a manager agent may never decide" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const refused = [_]Change{
        .{ .no_requester = true },
        .{ .exfiltration = 0.9 },
        .{ .exfiltration = 0.97 },
        .{ .requester = "m" },
        .{ .in_subtree = false },
        .{ .owns_project = false },
        .{ .category = "network" },
        .{ .category = "secret" },
        .{ .kind = "fetch" },
        .{ .command = "cat $HARNESS_HOME/harness.db" },
        .{ .command = "ls /Users/x/.harness/runs" },
        .{ .command = "cat ~/.harness/harness.db" },
        .{ .command = "cat $HOME/.harness/secrets.json" },
        .{ .command = "cat ${HOME}/.harness/secrets.json" },
        .{ .command = "cat /repo/../../Users/x/.harness/x" },
        .{ .command = "cat /Users/x/./.harness//x" },
        .{ .kind = "read", .command = "", .paths = &.{"/repo/../Users/x/.harness/harness.db"} },
        .{ .harness_home = "/Users/x/foo", .command = "cat /Users/x/foo/db" },
        .{ .command = "cat features/guard/l1.ts" },
        .{ .command = "cat features/./guard/l1.ts" },
        .{ .command = "cat features//auth/admin.ts" },
        .{ .command = "cat src/server/features/x/../policies/p.ts" },
        .{ .kind = "edit", .command = "", .paths = &.{"features/guard/l1.ts"} },
        .{ .rule = "write.outside-root" },
        .{ .rule = "read.outside-root" },
        .{ .rule = "exec.escalate" },
        .{ .rule = "env.injection" },
        .{ .kind = "edit", .command = "", .paths = &.{"/repo/src/server/features/guard/l1.ts"} },
        .{ .command = "bun run deploy" },
        .{ .command = "srt --settings x sh" },
        .{ .command = "echo hi > .claude/settings.json" },
        .{ .command = "cat ~/.codex/config.toml" },
        .{ .command = "git push origin 'main'" },
        .{ .command = "git push origin \"main\"" },
        .{ .command = "git push origin ma\\in" },
        .{ .command = "git push origin *" },
        .{ .command = "git push origin ma?n" },
        .{ .command = "git push origin [m]ain" },
        .{ .command = "git push origin {main,dev}" },
        .{ .command = "git push origin $BRANCH" },
        .{ .command = "git push origin `echo main`" },
        .{ .command = "cd /tmp && git push origin main" },
        .{ .command = "git status; cd .. ; git push" },
        .{ .command = "cat /USERS/X/.HARNESS/harness.db" },
        .{ .harness_home = "/Users/\u{141}ukasz/.harness", .command = "cat /users/\u{142}ukasz/.harness/x" },
        .{ .harness_home = "/Users/\u{531}x/.harness", .command = "cat /users/\u{561}x/.harness/x" },
        .{ .harness_home = "/Users/\u{561}x/.harness", .command = "cat /users/\u{531}x/.harness/x" },
        .{ .harness_home = "/Users/\u{e5}x/.harness", .command = "cat /users/\u{212b}x/.harness/x" },
        // A letter jsLower cannot fold is refused whatever the home is called.
        .{ .command = "echo \u{561}\u{531}" },
        .{ .command = "cat .harne\u{17f}s/x" },
        .{ .command = "cat .harne\u{df}/x" },
        .{ .command = "cat \u{3a3}x" },
        .{ .command = "cat x\xff" },
        // A combining mark is the decomposed spelling of a letter.
        .{ .harness_home = "/Users/caf\u{e9}/.harness", .command = "cat /users/cafe\u{301}/.harness/x" },
        // A precomposed letter against a decomposed home: the two spellings name one directory.
        .{ .harness_home = "/Users/cafe\u{301}/.harness", .command = "echo \u{e9}" },
        .{ .harness_home = "/Users/\u{ac00}/.harness", .command = "echo \u{1100}\u{1161}" },
        .{ .harness_home = "/Users/\u{ac00}/.harness", .command = "echo \u{ac00}" },
    };
    for (refused) |change| try testing.expect(try mayDecide(a, change.on()) != null);
    const allowed = [_]Change{
        .{ .command = "git push origin main" },
        .{ .command = "abcd e" },
        .{ .exfiltration = 0.89 },
        .{},
        .{ .category = "git_push", .rule = "git.push" },
        .{ .command = "abcd\u{00a0}e" },
        .{ .command = "echo cdx; mkcd y" },
        .{ .command = "echo caf\u{e9} \u{141}ukasz" },
        .{ .harness_home = "/Users/\u{141}x/.harness", .command = "echo \u{4e2d}\u{6587} \u{1f600}" },
    };
    for (allowed) |change| try testing.expectEqual(@as(?[]const u8, null), try mayDecide(a, change.on()));
}

test "guard limits: the refusal texts match TS" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("command uses shell indirection; a human must decide", (try mayDecide(a, (Change{ .command = "$(x)" }).on())).?);
    try testing.expectEqualStrings("the run has no member", (try mayDecide(a, (Change{ .no_requester = true }).on())).?);
    try testing.expectEqualStrings("managers cannot decide their own request", (try mayDecide(a, (Change{ .requester = "m" }).on())).?);
    try testing.expectEqualStrings("the requester does not report to you", (try mayDecide(a, (Change{ .in_subtree = false }).on())).?);
    try testing.expectEqualStrings("the run works on another org's project; a human must decide", (try mayDecide(a, (Change{ .owns_project = false }).on())).?);
    try testing.expectEqualStrings("network and secret actions need a human", (try mayDecide(a, (Change{ .category = "secret" }).on())).?);
    try testing.expectEqualStrings("laya flagged possible exfiltration", (try mayDecide(a, (Change{ .exfiltration = 0.9 }).on())).?);
    try testing.expectEqualStrings("the guard rule exec.escalate needs a human", (try mayDecide(a, (Change{ .rule = "exec.escalate" }).on())).?);
    try testing.expectEqualStrings("the action touches the harness home", (try mayDecide(a, (Change{ .command = "ls /Users/x/.harness/runs" }).on())).?);
    try testing.expectEqualStrings("the action mentions deploy", (try mayDecide(a, (Change{ .command = "bun run deploy" }).on())).?);
    var strict = base;
    strict.autonomy = .{ .value = "ask", .layer = "org" };
    try testing.expectEqualStrings("autonomy is ask (org)", (try mayDecide(a, strict)).?);
    strict.autonomy = .{ .value = "full", .layer = "org" };
    try testing.expectEqual(@as(?[]const u8, null), try mayDecide(a, strict));
}

test "guard limits: normalizeText collapses slashes and dot segments and resolves each word" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_][2][]const u8{
        .{ "CAT //x/./y", "cat /x/y\n/x/y" },
        .{ "cat /a/../../b/c", "cat /a/../../b/c\n/b/c" },
        .{ "x=/a/./b/..", "x=/a/b/..\n/a" },
        .{ "a/.hidden/..x", "a/.hidden/..x\na/.hidden/..x" },
        .{ "ls /a/.", "ls /a\n/a" },
        .{ "/a/././b", "/a/b\n/a/b" },
        .{ "/a/./.x", "/a/.x\n/a/.x" },
        .{ "no words here", "no words here" },
        .{ "a\u{2003}/b\n/c", "a\u{2003}/b\n/c\n/b\n/c" },
    };
    for (cases) |case| try testing.expectEqualStrings(case[1], try normalizeText(a, case[0]));
}

test "guard limits: normalizePosix matches node path.posix.normalize" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_][2][]const u8{
        .{ "a/../..", ".." },
        .{ "/../x", "/x" },
        .{ "x/", "x/" },
        .{ "./a/./", "a/" },
        .{ "a/..", "." },
        .{ "a/../", "./" },
        .{ "/", "/" },
        .{ "", "." },
        .{ "../../a//b", "../../a/b" },
    };
    for (cases) |case| try testing.expectEqualStrings(case[1], try normalizePosix(a, case[0]));
}

test "guard limits: lowercasing and the shell indirection matcher follow JS" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("\u{142}ukasz \u{43f}\u{440}", try jsLower(a, "\u{141}UKASZ \u{41f}\u{420}"));
    try testing.expectEqualStrings("i\u{307}x", try jsLower(a, "\u{130}X"));
    try testing.expectEqualStrings("a\xffb", try jsLower(a, "A\xffB"));
    try testing.expect(hasShellIndirection("cd /tmp"));
    try testing.expect(hasShellIndirection("x\ncd y"));
    try testing.expect(hasShellIndirection("x;\u{00a0}cd\u{3000}y"));
    try testing.expect(hasShellIndirection("(cd a)"));
    try testing.expect(!hasShellIndirection("cd"));
    try testing.expect(!hasShellIndirection("abcd e"));
    try testing.expect(!hasShellIndirection("cdrom x"));
    try testing.expect(!hasShellIndirection("\u{e9}cd x"));
    try testing.expect(hasShellIndirection("a\u{e9}; cd x"));
}

test "guard limits: the refusal checks survive every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn go(gpa: Allocator) !void {
            var arena: std.heap.ArenaAllocator = .init(gpa);
            defer arena.deinit();
            _ = try mayDecide(arena.allocator(), (Change{ .command = "cat /a/../b", .paths = &.{"x/../y"} }).on());
            _ = try mayDecide(arena.allocator(), (Change{ .rule = "write.outside-root" }).on());
        }
    }.go, .{});
}

const org_sql =
    \\INSERT INTO orgs (id, slug, name, created_at) VALUES ('org1', 'acme', 'A', 1), ('org2', 'beta', 'B', 1);
    \\INSERT INTO members (id, org_id, kind, user_id, agent_id, handle, display_name, role, created_at) VALUES
    \\  ('boss', 'org1', 'agent', NULL, 'a', 'boss', 'boss', 'member', 1),
    \\  ('dev', 'org1', 'agent', NULL, 'a', 'dev', 'dev', 'member', 1),
    \\  ('peer', 'org1', 'agent', NULL, 'a', 'peer', 'peer', 'member', 1),
    \\  ('owner2', 'org2', 'human', 'u2', NULL, 'owner2', 'O2', 'owner', 1);
    \\INSERT INTO positions (id, org_id, team_id, title, member_id, reports_to, is_manager, created_at) VALUES
    \\  ('p-lead', 'org1', NULL, 'lead', 'boss', NULL, 1, 1),
    \\  ('p-dev', 'org1', NULL, 'dev', 'dev', 'p-lead', 0, 2),
    \\  ('p-peer', 'org1', NULL, 'peer', 'peer', NULL, 0, 3);
    \\INSERT INTO projects (id, org_id, team_id, key, name, repo, created_at) VALUES ('proj', 'org2', NULL, 'web', 'Web', NULL, 1);
;

fn orgWorld() !*Fixture {
    const fx = try Fixture.create(testing.allocator, testing.io);
    errdefer fx.destroy();
    try fx.db.exec(org_sql);
    return fx;
}

/// A run for `member` with one pending approval for `command`; returns the approval id.
fn ask(fx: *Fixture, run_id: [:0]const u8, member: ?[]const u8, command: []const u8, l2_json: ?[]const u8) ![ids.uuid_len]u8 {
    const run = try fx.db.prepare("INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)");
    defer run.finalize();
    try run.bindText(1, run_id);
    if (member) |m| try run.bindText(2, m) else try run.bindNull(2);
    _ = try run.step();
    var action: std.Io.Writer.Allocating = .init(testing.allocator);
    defer action.deinit();
    try std.json.Stringify.value(.{ .kind = "execute", .command = command, .paths = &[_][]const u8{} }, .{}, &action.writer);
    const made = try approvals.create(fx.db, testing.io, .{
        .run_id = run_id,
        .action = action.written(),
        .l1 = "{\"verdict\":\"ask\",\"rule\":\"r\",\"reason\":\"x\",\"category\":\"shell\"}",
        .l2 = l2_json,
        .timeout_ms = 60_000,
    });
    return made.id;
}

fn decideInput(id: []const u8, manager: []const u8, decision: approvals.Decision) DecideInput {
    return .{ .approval_id = id, .manager_member_id = manager, .harness_home = home, .decision = decision, .reason = "safe" };
}

test "guard limits: managerDecide resolves a waiting approval and logs a manager_agent event" {
    const fx = try orgWorld();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const id = try ask(fx, "run-1", "dev", "bun test", null);
    const now = ids.nowMs(testing.io);

    const boss_list = try decidableApprovals(a, testing.io, fx.db, "boss", home, now);
    try testing.expectEqual(@as(usize, 1), boss_list.len);
    try testing.expectEqualStrings(&id, boss_list[0].id);
    try testing.expectEqual(@as(usize, 0), (try decidableApprovals(a, testing.io, fx.db, "peer", home, now)).len);

    const peer = try managerDecide(a, testing.io, fx.db, decideInput(&id, "peer", .approve));
    try testing.expectEqualStrings("the requester does not report to you", peer.refused);
    try testing.expectEqual(DecideOutcome.ok, try managerDecide(a, testing.io, fx.db, decideInput(&id, "boss", .approve)));
    try testing.expectEqual(approvals.Status.approved, try approvals.waitForDecision(&fx.app, &id, now + 60_000));
    const again = try managerDecide(a, testing.io, fx.db, decideInput(&id, "boss", .approve));
    try testing.expectEqualStrings("not pending", again.refused);

    const event = try fx.db.prepare("SELECT source, guard_layer, guard_rule, guard_verdict, command, rowid, kind FROM events WHERE run_id = 'run-1'");
    defer event.finalize();
    try testing.expect(try event.step());
    try testing.expectEqualStrings("manager_agent", (try event.text(0)).?);
    try testing.expectEqualStrings("L3", (try event.text(1)).?);
    try testing.expectEqualStrings("safe", (try event.text(2)).?);
    try testing.expectEqualStrings("allow", (try event.text(3)).?);
    try testing.expectEqualStrings("bun test", (try event.text(4)).?);
    try testing.expectEqualStrings("approve by agent:boss", (try logs.readBody(a, fx.db, event.int(5))).?);
    try testing.expectEqualStrings("guard", (try event.text(6)).?);
    try testing.expect(!try event.step());

    const row = (try approvals.get(fx.db, a, &id)).?;
    try testing.expectEqualStrings("agent:boss", row.decided_by.?);
}

test "guard limits: managerDecide refuses a run without a member, an own request and an unknown approval" {
    const fx = try orgWorld();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const no_member = try ask(fx, "run-1", null, "bun test", null);
    const own = try ask(fx, "run-2", "boss", "bun test", null);
    const orphan = try managerDecide(a, testing.io, fx.db, decideInput(&no_member, "boss", .deny));
    try testing.expectEqualStrings("the run has no member", orphan.refused);
    const mine = try managerDecide(a, testing.io, fx.db, decideInput(&own, "boss", .approve));
    try testing.expectEqualStrings("managers cannot decide their own request", mine.refused);
    const unknown = try managerDecide(a, testing.io, fx.db, decideInput("nope", "boss", .deny));
    try testing.expectEqualStrings("unknown approval", unknown.refused);
    const row = (try approvals.get(fx.db, a, &own)).?;
    try testing.expectEqual(approvals.Status.pending, row.status);
}

test "guard limits: an approval Laya flagged for exfiltration is left to a human" {
    const fx = try orgWorld();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const flagged = try ask(fx, "run-1", "dev", "npm publish", "{\"verdict\":\"ask\",\"reason\":\"x\",\"source\":\"laya\",\"probs\":{\"exfiltration\":0.93}}");
    const calm = try ask(fx, "run-2", "dev", "npm test", "{\"verdict\":\"ask\",\"reason\":\"x\",\"source\":\"laya\",\"probs\":{\"exfiltration\":0.2}}");
    const list = try decidableApprovals(a, testing.io, fx.db, "boss", home, ids.nowMs(testing.io));
    try testing.expectEqual(@as(usize, 1), list.len);
    try testing.expectEqualStrings(&calm, list[0].id);
    const refused = try managerDecide(a, testing.io, fx.db, decideInput(&flagged, "boss", .approve));
    try testing.expectEqualStrings("laya flagged possible exfiltration", refused.refused);
}

test "guard limits: a grantee org's manager cannot decide a run against the owner's project" {
    const fx = try orgWorld();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const id = try ask(fx, "run-1", "dev", "bun test", null);
    try fx.db.exec("UPDATE runs SET project_id = 'proj' WHERE id = 'run-1'");
    try testing.expectEqual(@as(usize, 0), (try decidableApprovals(a, testing.io, fx.db, "boss", home, ids.nowMs(testing.io))).len);
    const refused = try managerDecide(a, testing.io, fx.db, decideInput(&id, "boss", .approve));
    try testing.expectEqualStrings("the run works on another org's project; a human must decide", refused.refused);
}

test "guard limits: reporting lines count through several levels and stop at the depth cap" {
    const fx = try orgWorld();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try fx.db.exec("INSERT INTO members (id, org_id, kind, user_id, agent_id, handle, display_name, role, created_at) VALUES " ++
        "('junior', 'org1', 'agent', NULL, 'a', 'junior', 'junior', 'member', 1)");
    try fx.db.exec("INSERT INTO positions (id, org_id, team_id, title, member_id, reports_to, is_manager, created_at) VALUES " ++
        "('p-junior', 'org1', NULL, 'junior', 'junior', 'p-dev', 0, 4)");
    try testing.expect(try reportsTransitivelyTo(fx.db, a, "junior", "p-lead"));
    try testing.expect(!try reportsTransitivelyTo(fx.db, a, "peer", "p-lead"));
    try testing.expect(!try reportsTransitivelyTo(fx.db, a, "boss", "p-lead"));
    try testing.expect(!try reportsTransitivelyTo(fx.db, a, "nobody", "p-lead"));
}

test "guard limits: orgAdminRefusal reads the stored action, l1 and l2 JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var row: approvals.Row = .{
        .id = "i",
        .run_id = "r",
        .action = "{\"kind\":\"execute\",\"command\":\"git push origin main\",\"paths\":[]}",
        .l1 = "{\"verdict\":\"ask\",\"rule\":\"git.push\",\"reason\":\"x\",\"category\":\"git_push\"}",
        .l2 = null,
        .status = .pending,
        .decided_by = null,
        .created_at = 1,
        .expires_at = 2,
        .decided_at = null,
    };
    try testing.expectEqual(@as(?[]const u8, null), try orgAdminRefusal(a, testing.io, row, home));
    row.l1 = "{\"category\":\"network\"}";
    try testing.expectEqualStrings("network and secret actions need a human", (try orgAdminRefusal(a, testing.io, row, home)).?);
    row.l1 = "{}";
    row.l2 = "{\"probs\":{\"exfiltration\":1}}";
    try testing.expectEqualStrings("laya flagged possible exfiltration", (try orgAdminRefusal(a, testing.io, row, home)).?);
    row.l2 = null;
    row.action = "{\"kind\":\"edit\",\"paths\":[\"/repo/src/server/features/guard/l1.ts\"]}";
    try testing.expectEqualStrings("the action mentions features/guard", (try orgAdminRefusal(a, testing.io, row, home)).?);
}

test "guard limits: an l1 category or rule and an l2 exfiltration of the wrong type are left to a human" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const refusal = "the stored action cannot be read; a human must decide";
    const action = "{\"kind\":\"execute\",\"command\":\"ls\",\"paths\":[]}";
    const cases = [_]struct { l1: []const u8, l2: ?[]const u8 }{
        .{ .l1 = "{\"verdict\":\"ask\",\"category\":7}", .l2 = null },
        .{ .l1 = "{\"verdict\":\"ask\",\"category\":[\"network\"]}", .l2 = null },
        .{ .l1 = "{\"verdict\":\"ask\",\"rule\":false}", .l2 = null },
        .{ .l1 = "{\"verdict\":\"ask\",\"rule\":{\"id\":1}}", .l2 = null },
        .{ .l1 = "{\"verdict\":\"ask\"}", .l2 = "{\"probs\":{\"exfiltration\":\"0.99\"}}" },
        .{ .l1 = "{\"verdict\":\"ask\"}", .l2 = "{\"probs\":{\"exfiltration\":null}}" },
    };
    for (cases) |case| {
        const row: approvals.Row = .{ .id = "i", .run_id = "r", .action = action, .l1 = case.l1, .l2 = case.l2, .status = .pending, .decided_by = null, .created_at = 1, .expires_at = 2, .decided_at = null };
        try testing.expectEqualStrings(refusal, (try orgAdminRefusal(a, testing.io, row, home)).?);
    }
    // What the guard writes itself stays readable: a null rule, no l2, a null probs, a number.
    const fine = [_]struct { l1: []const u8, l2: ?[]const u8 }{
        .{ .l1 = "{\"verdict\":\"ask\",\"rule\":null,\"reason\":\"x\",\"category\":\"shell\"}", .l2 = null },
        .{ .l1 = "{\"verdict\":\"ask\",\"category\":\"shell\"}", .l2 = "{\"probs\":null}" },
        .{ .l1 = "{\"verdict\":\"ask\",\"category\":\"shell\"}", .l2 = "{\"probs\":{\"exfiltration\":0.2}}" },
    };
    for (fine) |case| {
        const row: approvals.Row = .{ .id = "i", .run_id = "r", .action = action, .l1 = case.l1, .l2 = case.l2, .status = .pending, .decided_by = null, .created_at = 1, .expires_at = 2, .decided_at = null };
        try testing.expectEqual(@as(?[]const u8, null), try orgAdminRefusal(a, testing.io, row, home));
    }
}

test "guard limits: a stored row that cannot be read as the guard wrote it is left to a human" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fine_l1 = "{\"verdict\":\"ask\",\"rule\":\"git.push\",\"reason\":\"x\",\"category\":\"git_push\"}";
    const refusal = "the stored action cannot be read; a human must decide";
    const bad_actions = [_][]const u8{
        "not json",
        "[]",
        // JSON.parse takes a lone surrogate escape, std.json does not: a TS-written row can carry one.
        "{\"kind\":\"execute\",\"command\":\"curl \\ud800\",\"paths\":[]}",
        "{\"kind\":\"execute\",\"command\":[99,97,116],\"paths\":[]}",
        "{\"kind\":\"execute\",\"command\":null,\"paths\":[]}",
        "{\"kind\":\"execute\",\"command\":7,\"paths\":[]}",
        "{\"kind\":\"edit\",\"paths\":[\"/a\",7]}",
        "{\"kind\":\"edit\",\"paths\":[null]}",
        "{\"kind\":\"edit\",\"paths\":\"/a\"}",
        "{\"kind\":5,\"command\":\"ls\",\"paths\":[]}",
    };
    for (bad_actions) |action| {
        const row: approvals.Row = .{ .id = "i", .run_id = "r", .action = action, .l1 = fine_l1, .l2 = null, .status = .pending, .decided_by = null, .created_at = 1, .expires_at = 2, .decided_at = null };
        try testing.expectEqualStrings(refusal, (try orgAdminRefusal(a, testing.io, row, home)).?);
    }
    const fine_action = "{\"kind\":\"execute\",\"command\":\"ls\",\"paths\":[]}";
    const bad_other = [_]struct { l1: []const u8, l2: ?[]const u8 }{
        .{ .l1 = "{\"reason\":\"\\ud800\",\"category\":\"network\"}", .l2 = null },
        .{ .l1 = "nope", .l2 = null },
        .{ .l1 = fine_l1, .l2 = "{\"probs\":" },
    };
    for (bad_other) |other| {
        const row: approvals.Row = .{ .id = "i", .run_id = "r", .action = fine_action, .l1 = other.l1, .l2 = other.l2, .status = .pending, .decided_by = null, .created_at = 1, .expires_at = 2, .decided_at = null };
        try testing.expectEqualStrings(refusal, (try orgAdminRefusal(a, testing.io, row, home)).?);
    }
    // The manager path reaches the same check once every other condition holds.
    var ctx = base;
    ctx.action.readable = false;
    try testing.expectEqualStrings(refusal, (try mayDecide(a, ctx)).?);
}
