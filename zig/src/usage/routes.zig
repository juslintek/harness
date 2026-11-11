//! `GET /api/usage`, `GET /api/quota` and `POST /api/quota`, http.ts:117-128. The session, admin and
//! origin gates are the route table's; these handlers only see requests that passed them.
const std = @import("std");
const httpz = @import("httpz");
const headers = @import("../http/headers.zig");
const http_routes = @import("../http/routes.zig");
const ids = @import("../ids.zig");
const json = @import("../json.zig");
const parity = @import("../parity.zig");
const sqlite = @import("../db/sqlite.zig");
const app_mod = @import("../app.zig");
const quota = @import("quota.zig");
const summary = @import("summary.zig");

const State = app_mod.State;
const Call = http_routes.Call;

/// A JS number on the wire: `JSON.stringify` prints 42 for 42.0 and `1e-7` for 0.0000001.
pub const JsNum = struct {
    value: f64,

    pub fn jsonStringify(self: JsNum, jw: anytype) !void {
        try jw.beginWriteRaw();
        try writeJsNumber(jw.writer, self.value);
        jw.endWriteRaw();
    }
};

pub fn writeJsNumber(w: *std.Io.Writer, v: f64) std.Io.Writer.Error!void {
    if (!std.math.isFinite(v)) return w.writeAll("null");
    const mag = @abs(v);
    if (mag == 0) return w.writeAll("0");
    if (mag >= 1e21 or mag < 1e-6) {
        var buf: [40]u8 = undefined;
        const text = std.fmt.bufPrint(&buf, "{e}", .{v}) catch unreachable;
        const at = std.mem.findScalar(u8, text, 'e').?;
        try w.writeAll(text[0 .. at + 1]);
        if (text[at + 1] != '-') try w.writeAll("+");
        return w.writeAll(text[at + 1 ..]);
    }
    return w.print("{d}", .{v});
}

fn optNum(v: ?f64) ?JsNum {
    return if (v) |n| .{ .value = n } else null;
}

const max_safe_integer = 9007199254740991.0;

/// `usageQuerySchema` of shared/query.ts.
const UsageQuery = struct { by: summary.By, since: i64 };

fn parseUsageQuery(req: *httpz.Request) error{InvalidQuery}!UsageQuery {
    const query = req.query() catch return error.InvalidQuery;
    const by: summary.By = if (query.get("by")) |text|
        std.meta.stringToEnum(summary.By, text) orelse return error.InvalidQuery
    else
        .agent;
    var since: i64 = 0;
    if (query.get("since")) |text| {
        const n = parity.coerceNumber(text) orelse return error.InvalidQuery;
        if (n != @floor(n) or n < 0 or n > max_safe_integer) return error.InvalidQuery;
        since = @intFromFloat(n);
    }
    return .{ .by = by, .since = since };
}

const UsageArgs = struct { arena: std.mem.Allocator, query: UsageQuery };

fn summaryLocked(args: *const UsageArgs, state: *State) anyerror![]summary.SummaryRow {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    return summary.usageSummary(args.arena, db, args.query.by, args.query.since);
}

const SummaryJson = struct {
    key: []const u8,
    inputTokens: i64,
    outputTokens: i64,
    cacheReadTokens: i64,
    cacheWriteTokens: i64,
    reportedCostUsd: ?JsNum,
    events: i64,
};

/// `GET /api/usage`.
pub fn getUsage(call: *Call) anyerror!void {
    const query = try parseUsageQuery(call.req);
    const arena = call.res.arena;
    const rows = try call.services.app.withLock(&UsageArgs{ .arena = arena, .query = query }, summaryLocked);
    const out = try arena.alloc(SummaryJson, rows.len);
    for (rows, out) |r, *o| o.* = .{
        .key = r.key,
        .inputTokens = r.input_tokens,
        .outputTokens = r.output_tokens,
        .cacheReadTokens = r.cache_read_tokens,
        .cacheWriteTokens = r.cache_write_tokens,
        .reportedCostUsd = optNum(r.reported_cost_usd),
        .events = r.events,
    };
    try headers.sendJson(call.res, out);
}

const QuotaArgs = struct { arena: std.mem.Allocator, now_ms: i64 };

fn quotaLocked(args: *const QuotaArgs, state: *State) anyerror![]quota.QuotaView {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    return quota.latestQuota(args.arena, db, args.now_ms);
}

const QuotaJson = struct {
    provider: []const u8,
    window: []const u8,
    usedPercent: ?JsNum,
    resetsAt: ?i64,
    source: []const u8,
    ts: i64,
};

/// `GET /api/quota`, which is `probeQuota`: the tailers' snapshots, nothing probed live.
pub fn getQuota(call: *Call) anyerror!void {
    const app = call.services.app;
    const arena = call.res.arena;
    const views = try app.withLock(&QuotaArgs{ .arena = arena, .now_ms = ids.nowMs(app.io) }, quotaLocked);
    const out = try arena.alloc(QuotaJson, views.len);
    for (views, out) |v, *o| o.* = .{
        .provider = v.provider,
        .window = v.window,
        .usedPercent = optNum(v.used_percent),
        .resetsAt = v.resets_at,
        .source = v.source,
        .ts = v.ts,
    };
    try headers.sendJson(call.res, out);
}

/// `quotaBodySchema` of shared/router.ts: a strict object, so an unknown key is refused.
const QuotaBody = struct {
    provider: []const u8,
    window: []const u8,
    used_percent: f64,
    resets_at: ?i64,
};

fn asNumber(v: std.json.Value) ?f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => null,
    };
}

fn nameField(v: ?std.json.Value) ?[]const u8 {
    const text = switch (v orelse return null) {
        .string => |s| s,
        else => return null,
    };
    const len = parity.codePoints(text) catch return null;
    return if (len >= 1 and len <= 40) text else null;
}

fn parseQuotaBody(arena: std.mem.Allocator, req: *httpz.Request) error{InvalidBody}!QuotaBody {
    const bytes = req.body() orelse return error.InvalidBody;
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena, bytes, json.parse_options) catch return error.InvalidBody;
    const obj = switch (root) {
        .object => |o| o,
        else => return error.InvalidBody,
    };
    var it = obj.iterator();
    while (it.next()) |entry| {
        const key = entry.key_ptr.*;
        const known = std.mem.eql(u8, key, "provider") or std.mem.eql(u8, key, "window") or
            std.mem.eql(u8, key, "usedPercent") or std.mem.eql(u8, key, "resetsAt");
        if (!known) return error.InvalidBody;
    }
    const used = asNumber(obj.get("usedPercent") orelse return error.InvalidBody) orelse return error.InvalidBody;
    if (used < 0 or used > 100) return error.InvalidBody;
    var resets: ?i64 = null;
    if (obj.get("resetsAt")) |r| {
        const n = asNumber(r) orelse return error.InvalidBody;
        if (n != @floor(n) or n <= 0 or n > max_safe_integer) return error.InvalidBody;
        resets = @intFromFloat(n);
    }
    return .{
        .provider = nameField(obj.get("provider")) orelse return error.InvalidBody,
        .window = nameField(obj.get("window")) orelse return error.InvalidBody,
        .used_percent = used,
        .resets_at = resets,
    };
}

const RecordArgs = struct { io: std.Io, body: QuotaBody, now_ms: i64 };

fn recordLocked(args: *const RecordArgs, state: *State) anyerror!void {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    try quota.insertSnapshot(db, args.io, .{
        .provider = args.body.provider,
        .window = args.body.window,
        .used_percent = args.body.used_percent,
        .resets_at = args.body.resets_at,
        .source = "manual",
    }, args.now_ms);
}

/// `POST /api/quota`: one manual snapshot. `usedPercent` is 0..100.
pub fn postQuota(call: *Call) anyerror!void {
    const app = call.services.app;
    const body = try parseQuotaBody(call.req.arena, call.req);
    try app.withLock(&RecordArgs{ .io = app.io, .body = body, .now_ms = ids.nowMs(app.io) }, recordLocked);
    try headers.sendJson(call.res, .{ .ok = true });
}

// ---- tests ----

const Fixture = @import("../auth/fixture.zig").Fixture;
const testing = std.testing;

const Harness = struct {
    fx: *Fixture,
    services: http_routes.Services,

    fn create() !*Harness {
        const self = try testing.allocator.create(Harness);
        errdefer testing.allocator.destroy(self);
        self.fx = try Fixture.create(testing.allocator, testing.io);
        self.services = .{ .app = &self.fx.app, .health = .{ .instance_id = @splat('0') } };
        return self;
    }

    fn destroy(self: *Harness) void {
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn call(self: *Harness, comptime handler: http_routes.HandlerFn, method: httpz.Method, url: []const u8, body: ?[]const u8) !httpz.testing.Testing {
        var web = httpz.testing.init(.{});
        errdefer web.deinit();
        web.req.method = method;
        web.url(url);
        if (body) |b| web.body(b);
        var c: Call = .{ .services = &self.services, .req = web.req, .res = web.res, .actor = null };
        try handler(&c);
        return web;
    }
};

fn num(v: f64) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    errdefer out.deinit();
    try writeJsNumber(&out.writer, v);
    return out.toOwnedSlice();
}

test "usage: numbers are written the way JSON.stringify writes them" {
    const cases = [_]struct { f64, []const u8 }{
        .{ 42, "42" },
        .{ 0, "0" },
        .{ -0.0, "0" },
        .{ 0.5, "0.5" },
        .{ 37.5, "37.5" },
        .{ 123.456, "123.456" },
        .{ 0.000001, "0.000001" },
        .{ 1.5e-7, "1.5e-7" },
        .{ 1e21, "1e+21" },
        .{ 1.5e300, "1.5e+300" },
        .{ 4102444800000, "4102444800000" },
        .{ -2.25, "-2.25" },
        .{ std.math.nan(f64), "null" },
    };
    for (cases) |case| {
        const text = try num(case[0]);
        defer testing.allocator.free(text);
        try testing.expectEqualStrings(case[1], text);
    }
}

test "usage: GET /api/usage answers the summary in field order, with a bad query refused" {
    const h = try Harness.create();
    defer h.destroy();
    try h.fx.run(
        \\INSERT INTO events (id, ts, run_id, agent, kind, gen_ai_usage_input_tokens, gen_ai_usage_output_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd) VALUES
        \\  ('1', 5000, 'r1', 'a', 'usage', 1, 2, 3, 4, 0.5),
        \\  ('2', 5000, 'r2', 'b', 'usage', 4, 0, 0, 0, NULL),
        \\  ('3', 5000, 'r3', 'c', 'usage', 1, 1, 1, 1, 1.5e-7)
    );
    var web = try h.call(getUsage, .GET, "/api/usage", null);
    defer web.deinit();
    try web.expectStatus(200);
    try web.expectBody("[{\"key\":\"a\",\"inputTokens\":1,\"outputTokens\":2,\"cacheReadTokens\":3,\"cacheWriteTokens\":4,\"reportedCostUsd\":0.5,\"events\":1}," ++
        "{\"key\":\"b\",\"inputTokens\":4,\"outputTokens\":0,\"cacheReadTokens\":0,\"cacheWriteTokens\":0,\"reportedCostUsd\":null,\"events\":1}," ++
        "{\"key\":\"c\",\"inputTokens\":1,\"outputTokens\":1,\"cacheReadTokens\":1,\"cacheWriteTokens\":1,\"reportedCostUsd\":1.5e-7,\"events\":1}]");
    try testing.expectEqualStrings("application/json", web.res.headers.get("content-type").?);

    var by_run = try h.call(getUsage, .GET, "/api/usage?by=run&since=5001", null);
    defer by_run.deinit();
    try by_run.expectBody("[]");

    const bad = [_][]const u8{ "/api/usage?by=team", "/api/usage?by=", "/api/usage?since=-1", "/api/usage?since=1.5", "/api/usage?since=abc", "/api/usage?since=Infinity" };
    for (bad) |url| try testing.expectError(error.InvalidQuery, h.call(getUsage, .GET, url, null));
    var ok = try h.call(getUsage, .GET, "/api/usage?since=", null);
    ok.deinit();
    var hex = try h.call(getUsage, .GET, "/api/usage?by=model&since=0x10", null);
    hex.deinit();
}

test "usage: POST then GET /api/quota round-trips a manual snapshot" {
    const h = try Harness.create();
    defer h.destroy();
    var web = try h.call(postQuota, .POST, "/api/quota", "{\"provider\":\"claude\",\"window\":\"five_hour\",\"usedPercent\":37.5,\"resetsAt\":4102444800000}");
    defer web.deinit();
    try web.expectStatus(200);
    try web.expectBody("{\"ok\":true}");
    var read = try h.call(getQuota, .GET, "/api/quota", null);
    defer read.deinit();
    const body = try read.getBody();
    try testing.expect(std.mem.startsWith(u8, body, "[{\"provider\":\"claude\",\"window\":\"five_hour\",\"usedPercent\":37.5,\"resetsAt\":4102444800000,\"source\":\"manual\",\"ts\":"));
    try testing.expect(std.mem.find(u8, body, "{\"provider\":\"codex\",\"window\":\"unknown\",\"usedPercent\":null,\"resetsAt\":null,\"source\":\"unknown\",\"ts\":") != null);
    try testing.expect(std.mem.find(u8, body, "\"provider\":\"agy\"") != null);
}

test "usage: POST /api/quota refuses what quotaBodySchema refuses" {
    const h = try Harness.create();
    defer h.destroy();
    const bad = [_][]const u8{
        "",
        "null",
        "[]",
        "not json",
        "{}",
        "{\"provider\":\"c\",\"window\":\"w\"}",
        "{\"provider\":\"\",\"window\":\"w\",\"usedPercent\":1}",
        "{\"provider\":\"c\",\"window\":\"\",\"usedPercent\":1}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":-0.1}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":100.1}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":\"5\"}",
        "{\"provider\":1,\"window\":\"w\",\"usedPercent\":5}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":5,\"extra\":1}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":5,\"resetsAt\":0}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":5,\"resetsAt\":-3}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":5,\"resetsAt\":1.5}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":5,\"resetsAt\":null}",
        "{\"provider\":\"c\",\"window\":\"w\",\"usedPercent\":5,\"resetsAt\":9007199254740993}",
        "{\"provider\":\"cccccccccccccccccccccccccccccccccccccccccc\",\"window\":\"w\",\"usedPercent\":5}",
    };
    for (bad) |body| try testing.expectError(error.InvalidBody, h.call(postQuota, .POST, "/api/quota", body));
    // 40 code points pass, 41 do not; a duplicate key keeps the last value; 5.0 is an integer.
    const forty = "0123456789012345678901234567890123456789";
    var ok = try h.call(postQuota, .POST, "/api/quota", "{\"provider\":\"" ++ forty ++ "\",\"window\":\"w\",\"usedPercent\":0,\"usedPercent\":100,\"resetsAt\":5.0}");
    ok.deinit();
    try testing.expectError(error.InvalidBody, h.call(postQuota, .POST, "/api/quota", "{\"provider\":\"" ++ forty ++ "0\",\"window\":\"w\",\"usedPercent\":1}"));
    const stmt = try h.fx.db.prepare("SELECT used_percent, resets_at, source FROM quota_snapshots");
    defer stmt.finalize();
    try testing.expect(try stmt.step());
    try testing.expectEqual(@as(f64, 100), stmt.real(0));
    try testing.expectEqual(@as(i64, 5), stmt.int(1));
    try testing.expectEqualStrings("manual", (try stmt.text(2)).?);
    try testing.expect(!try stmt.step());
    // The limit is in code points: 40 emoji pass although they are 80 UTF-16 units.
    const emoji40 = comptime blk: {
        const unit = "\u{1F600}";
        var out: [unit.len * 40]u8 = undefined;
        for (0..40) |i| @memcpy(out[i * unit.len ..][0..unit.len], unit);
        break :blk out;
    };
    var astral = try h.call(postQuota, .POST, "/api/quota", "{\"provider\":\"" ++ emoji40 ++ "\",\"window\":\"w\",\"usedPercent\":1}");
    astral.deinit();
    try testing.expectError(error.InvalidBody, h.call(postQuota, .POST, "/api/quota", "{\"provider\":\"" ++ emoji40 ++ "\u{1F600}\",\"window\":\"w\",\"usedPercent\":1}"));
}
