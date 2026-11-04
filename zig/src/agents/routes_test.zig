const std = @import("std");
const httpz = @import("httpz");
const Fixture = @import("../auth/fixture.zig").Fixture;
const ids = @import("../ids.zig");
const policy = @import("../http/policy.zig");
const process_mod = @import("../runtimes/process.zig");
const routes = @import("../http/routes.zig");
const runner_mod = @import("runner.zig");
const specs_mod = @import("specs.zig");
const agents = @import("routes.zig");

const testing = std.testing;
const Io = std.Io;

const Reply = struct { code: i32 = 0, stdout: []const u8 = "", stderr: []const u8 = "", times_out: bool = false };

/// Commands answered from a table keyed by the argv joined with spaces; the rest is "not found".
const Scripted = struct {
    replies: []const struct { []const u8, Reply } = &.{},
    calls: std.atomic.Value(u32) = .init(0),

    fn runner(self: *Scripted) runner_mod.Runner {
        return .{ .ctx = self, .run_fn = run };
    }

    fn run(ctx: *anyopaque, arena: std.mem.Allocator, argv: []const []const u8, _: i64, _: []const specs_mod.EnvPair) runner_mod.Error!runner_mod.Out {
        const self: *Scripted = @ptrCast(@alignCast(ctx));
        _ = self.calls.fetchAdd(1, .monotonic);
        const key = try std.mem.join(arena, " ", argv);
        for (self.replies) |entry| {
            if (!std.mem.eql(u8, entry[0], key)) continue;
            if (entry[1].times_out) return error.TimedOut;
            return .{ .code = entry[1].code, .stdout = entry[1].stdout, .stderr = entry[1].stderr };
        }
        return .{ .code = runner_mod.not_found_code, .stdout = "", .stderr = "" };
    }
};

const Rig = struct {
    fx: *Fixture,
    tmp: testing.TmpDir,
    home: []u8,
    env: std.process.Environ.Map,
    ctx: *agents.Ctx,
    services: routes.Services,
    scripted: Scripted = .{},

    fn create() !*Rig {
        const self = try testing.allocator.create(Rig);
        errdefer testing.allocator.destroy(self);
        self.scripted = .{};
        self.fx = try Fixture.create(testing.allocator, testing.io);
        errdefer self.fx.destroy();
        self.tmp = testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        var buf: [Io.Dir.max_path_bytes]u8 = undefined;
        const real = buf[0..try self.tmp.dir.realPath(testing.io, &buf)];
        self.home = try std.fmt.allocPrint(testing.allocator, "{s}/home", .{real});
        errdefer testing.allocator.free(self.home);
        self.env = std.process.Environ.Map.init(testing.allocator);
        errdefer self.env.deinit();
        try self.env.put("HOME", "/home/alice");
        try self.env.put("OLLAYA_URL", "http://127.0.0.1:1");
        self.ctx = try agents.Ctx.create(testing.allocator, testing.io, self.home, &self.env);
        errdefer self.ctx.destroy();
        self.ctx.setRunner(self.scripted.runner());
        self.ctx.ollaya_timeout_ms = 500;
        self.services = .{ .app = &self.fx.app, .health = .{ .instance_id = @splat('a') }, .agents = self.ctx };
        return self;
    }

    fn destroy(self: *Rig) void {
        self.ctx.destroy();
        self.env.deinit();
        testing.allocator.free(self.home);
        self.tmp.cleanup();
        self.fx.destroy();
        testing.allocator.destroy(self);
    }

    fn actor(stepped_up: bool) policy.Actor {
        return .{ .instance_admin = true, .user_id = "admin", .step_up_at = if (stepped_up) ids.nowMs(testing.io) else null };
    }

    const Request = struct { id: ?[]const u8 = null, provider: ?[]const u8 = null, body: ?[]const u8 = null, stepped_up: bool = true };

    fn call(self: *Rig, handler: routes.HandlerFn, request: Request) !httpz.testing.Testing {
        var web = httpz.testing.init(.{});
        errdefer web.deinit();
        if (request.id) |id| web.param("id", id);
        if (request.provider) |provider| web.param("provider", provider);
        if (request.body) |body| web.body(body);
        var routed: routes.Call = .{ .services = &self.services, .req = web.req, .res = web.res, .actor = actor(request.stepped_up) };
        handler(&routed) catch |err| {
            // The server maps an escaped error the same way.
            const mapped = @import("../http/headers.zig").mapError(err);
            web.res.clearWriter();
            try @import("../http/headers.zig").sendError(web.res, mapped.status, mapped.message);
        };
        return web;
    }

    fn run(self: *Rig, comptime sql: [:0]const u8) !void {
        try self.fx.run(sql);
    }
};

/// What the handler wrote, read from the response buffer. A login command that is still running
/// holds a copy of the test socket's write end, so `getBody` would wait for it to exit.
fn writtenBody(web: *httpz.testing.Testing) []const u8 {
    return web.res.buffer.written();
}

fn expectJsonBody(web: *httpz.testing.Testing, status: u16, body: []const u8) !void {
    try web.expectStatus(status);
    try web.expectBody(body);
}

test "agents: the list merges discovery, links and saved models, and is cached for a minute" {
    const rig = try Rig.create();
    defer rig.destroy();
    rig.scripted.replies = &.{
        .{ "claude --version", .{ .stdout = "2.1.316 (Claude Code)\n" } },
        .{ "which claude", .{ .stdout = "/bin/claude\n" } },
        .{ "claude auth status", .{ .stdout = "{\"loggedIn\": true}" } },
        .{ "codex --version", .{ .code = 2, .stderr = "boom\n" } },
    };
    try rig.run("INSERT INTO agent_links (agent_id, enabled, updated_at) VALUES ('claude', 1, 5), ('codex', 0, 5)");
    try rig.run("INSERT INTO agent_models (agent_id, model_id, name, fetched_at) VALUES ('claude', 'm2', 'Zeta', 1), ('claude', 'm1', 'Alpha', 1)");

    var first = try rig.call(agents.list, .{});
    defer first.deinit();
    try first.expectStatus(200);
    try testing.expectEqualStrings("application/json", first.res.headers.get("content-type").?);
    const body = try first.getBody();
    try testing.expect(std.mem.startsWith(u8, body, "[{\"id\":\"claude\",\"name\":\"Claude Code\",\"lane\":\"acp\",\"installed\":true,\"path\":\"/bin/claude\"," ++
        "\"version\":\"2.1.316\",\"loggedIn\":true,\"error\":null,\"canLogin\":true,\"enabled\":true," ++
        "\"models\":[{\"id\":\"m1\",\"name\":\"Alpha\"},{\"id\":\"m2\",\"name\":\"Zeta\"}]},{\"id\":\"codex\","));
    try testing.expect(std.mem.find(u8, body, "{\"id\":\"codex\",\"name\":\"Codex\",\"lane\":\"acp\",\"installed\":false,\"path\":null,\"version\":null," ++
        "\"loggedIn\":null,\"error\":\"boom\",\"canLogin\":true,\"enabled\":false,\"models\":[]}") != null);
    try testing.expect(std.mem.find(u8, body, "{\"id\":\"gemini\",\"name\":\"Gemini CLI\",\"lane\":\"acp\",\"installed\":false,\"path\":null,\"version\":null," ++
        "\"loggedIn\":null,\"error\":\"GEMINI_API_KEY is not set\",\"canLogin\":false,\"enabled\":false,\"models\":[]}") != null);
    try testing.expect(std.mem.endsWith(u8, body, "\"canLogin\":false,\"enabled\":false,\"models\":[]}]"));

    const calls = rig.scripted.calls.load(.monotonic);
    try testing.expect(calls > 0);
    var second = try rig.call(agents.list, .{});
    defer second.deinit();
    try testing.expectEqualStrings(body, try second.getBody());
    try testing.expectEqual(calls, rig.scripted.calls.load(.monotonic));
}

test "agents: link needs a fresh step-up first, then a known agent and a boolean" {
    const rig = try Rig.create();
    defer rig.destroy();
    var stale = try rig.call(agents.link, .{ .id = "nope", .body = "{\"enabled\":true}", .stepped_up = false });
    defer stale.deinit();
    try expectJsonBody(&stale, 403, "{\"error\":\"step_up_required\"}");

    var unknown = try rig.call(agents.link, .{ .id = "nope", .body = "{\"enabled\":true}" });
    defer unknown.deinit();
    try expectJsonBody(&unknown, 404, "{\"error\":\"unknown agent\"}");
    var bad = try rig.call(agents.link, .{ .id = "claude", .body = "{\"enabled\":\"yes\"}" });
    defer bad.deinit();
    try expectJsonBody(&bad, 400, "{\"error\":\"invalid body\"}");
    var missing = try rig.call(agents.link, .{ .id = "claude" });
    defer missing.deinit();
    try expectJsonBody(&missing, 400, "{\"error\":\"invalid body\"}");

    var ok = try rig.call(agents.link, .{ .id = "claude", .body = "{\"enabled\":true,\"enabled\":false,\"x\":1}" });
    defer ok.deinit();
    try expectJsonBody(&ok, 200, "{\"ok\":true}");
    var on = try rig.call(agents.link, .{ .id = "claude", .body = "{\"enabled\":true}" });
    defer on.deinit();
    const stmt = try rig.fx.db.prepare("SELECT enabled, count(*) FROM agent_links WHERE agent_id = 'claude'");
    defer stmt.finalize();
    _ = try stmt.step();
    try testing.expectEqual(@as(i64, 1), stmt.int(0));
    try testing.expectEqual(@as(i64, 1), stmt.int(1));
}

test "agents: key saves are validated after the step-up and never reach the file when refused" {
    const rig = try Rig.create();
    defer rig.destroy();
    const good = "{\"key\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
    var stale = try rig.call(agents.keySave, .{ .provider = "openai", .body = good, .stepped_up = false });
    defer stale.deinit();
    try expectJsonBody(&stale, 403, "{\"error\":\"step_up_required\"}");
    var stale_unknown = try rig.call(agents.keySave, .{ .provider = "nope", .body = good, .stepped_up = false });
    defer stale_unknown.deinit();
    try expectJsonBody(&stale_unknown, 403, "{\"error\":\"step_up_required\"}");

    var unknown = try rig.call(agents.keySave, .{ .provider = "nope", .body = good });
    defer unknown.deinit();
    try expectJsonBody(&unknown, 404, "{\"error\":\"unknown provider\"}");
    for ([_][]const u8{
        "{\"key\":\"short\"}",
        "{\"key\":\"aaaaaaaaaaaaaaaaaaa\\n\"}",
        "{\"key\":\"caf\\u00e9aaaaaaaaaaaaaaaaaaaaa\"}",
        "{\"key\":5}",
        "{}",
        "[]",
        "null",
        "not json",
    }) |body| {
        var refused = try rig.call(agents.keySave, .{ .provider = "openai", .body = body });
        defer refused.deinit();
        try expectJsonBody(&refused, 400, "{\"error\":\"invalid key\"}");
    }
    var no_body = try rig.call(agents.keySave, .{ .provider = "openai" });
    defer no_body.deinit();
    try expectJsonBody(&no_body, 400, "{\"error\":\"invalid key\"}");
    const store_path = try std.fmt.allocPrint(testing.allocator, "{s}/secrets.json", .{rig.home});
    defer testing.allocator.free(store_path);
    try testing.expectError(error.FileNotFound, Io.Dir.cwd().access(testing.io, store_path, .{}));
}

test "agents: a saved key shows up as file in the key status, and a broken store is a 400 with a safe message" {
    const rig = try Rig.create();
    defer rig.destroy();
    var saved = try rig.call(agents.keySave, .{ .provider = "gemini", .body = "{\"key\":\"AIzaSyD0123456789abcdefXYZ\"}" });
    defer saved.deinit();
    try expectJsonBody(&saved, 200, "{\"ok\":true}");
    var status = try rig.call(agents.keyStatus, .{});
    defer status.deinit();
    try expectJsonBody(&status, 200, "[{\"provider\":\"anthropic\",\"source\":null,\"legacyLeft\":false}," ++
        "{\"provider\":\"openai\",\"source\":null,\"legacyLeft\":false}," ++
        "{\"provider\":\"gemini\",\"source\":\"file\",\"legacyLeft\":false}," ++
        "{\"provider\":\"openrouter\",\"source\":null,\"legacyLeft\":false}]");

    var home = try Io.Dir.cwd().openDir(testing.io, rig.home, .{});
    defer home.close(testing.io);
    try home.writeFile(testing.io, .{ .sub_path = "secrets.json", .data = "{\"gemini\":LEAKED-SECRET}" });
    var broken = try rig.call(agents.keyStatus, .{});
    defer broken.deinit();
    try broken.expectStatus(400);
    try testing.expect(std.mem.find(u8, try broken.getBody(), "LEAKED-SECRET") == null);
    try testing.expect(std.mem.find(u8, try broken.getBody(), "/home/secrets.json is not valid JSON\"}") != null);
}

test "agents: models refresh answers like the TS routes" {
    const rig = try Rig.create();
    defer rig.destroy();
    rig.scripted.replies = &.{.{ "agy models", .{ .stdout = "Fetching available models...\ngemini-x-low\tGemini X Low\nplain-id\n\n" } }};
    var ok = try rig.call(agents.refreshModels, .{ .id = "agy" });
    defer ok.deinit();
    try expectJsonBody(&ok, 200, "{\"models\":[{\"id\":\"gemini-x-low\",\"name\":\"Gemini X Low\"},{\"id\":\"plain-id\",\"name\":\"plain-id\"}]}");
    var unknown = try rig.call(agents.refreshModels, .{ .id = "nope" });
    defer unknown.deinit();
    try expectJsonBody(&unknown, 404, "{\"error\":\"unknown agent\"}");
    var unwired = try rig.call(agents.refreshModels, .{ .id = "claude" });
    defer unwired.deinit();
    try expectJsonBody(&unwired, 502, "{\"error\":\"ACP model listing is not wired\"}");
    rig.scripted.replies = &.{.{ "agy models", .{ .code = 1, .stderr = "Error: please sign in" } }};
    var failing = try rig.call(agents.refreshModels, .{ .id = "agy" });
    defer failing.deinit();
    try expectJsonBody(&failing, 502, "{\"error\":\"Error: please sign in\"}");
    // A refresh needs no step-up, as in TS.
    var no_step_up = try rig.call(agents.refreshModels, .{ .id = "nope", .stepped_up = false });
    defer no_step_up.deinit();
    try no_step_up.expectStatus(404);
}

test "agents: ollaya that is not running is down" {
    const rig = try Rig.create();
    defer rig.destroy();
    var down = try rig.call(agents.ollayaStatus, .{});
    defer down.deinit();
    try expectJsonBody(&down, 200, "{\"up\":false,\"version\":null}");
}

fn useLoginScript(rig: *Rig, argv: []const []const u8) !void {
    const arena = rig.ctx.specs_arena.allocator();
    const copy = try arena.dupe(specs_mod.Spec, rig.ctx.specs);
    copy[0].login_args = argv;
    rig.ctx.specs = copy;
}

fn waitForPid(dir: Io.Dir, name: []const u8) !std.posix.pid_t {
    var buf: [64]u8 = undefined;
    for (0..500) |_| {
        const text = dir.readFile(testing.io, name, &buf) catch {
            try testing.io.sleep(.fromMilliseconds(10), .awake);
            continue;
        };
        const trimmed = std.mem.trim(u8, text, "\n ");
        if (trimmed.len > 0) return std.fmt.parseInt(std.posix.pid_t, trimmed, 10) catch {
            try testing.io.sleep(.fromMilliseconds(10), .awake);
            continue;
        };
        try testing.io.sleep(.fromMilliseconds(10), .awake);
    }
    return error.NoPidFile;
}

fn loginsEmpty(rig: *Rig) bool {
    rig.ctx.mutex.lockUncancelable(testing.io);
    defer rig.ctx.mutex.unlock(testing.io);
    return rig.ctx.logins.count() == 0;
}

test "agents: login needs a step-up and a login command" {
    const rig = try Rig.create();
    defer rig.destroy();
    var stale = try rig.call(agents.login, .{ .id = "codex", .stepped_up = false });
    defer stale.deinit();
    try expectJsonBody(&stale, 403, "{\"error\":\"step_up_required\"}");
    var none = try rig.call(agents.login, .{ .id = "agy" });
    defer none.deinit();
    try expectJsonBody(&none, 404, "{\"error\":\"no login command\"}");
    var unknown = try rig.call(agents.login, .{ .id = "nope" });
    defer unknown.deinit();
    try expectJsonBody(&unknown, 404, "{\"error\":\"no login command\"}");
}

test "agents: a missing cli is a 409 and leaves nothing in flight" {
    const rig = try Rig.create();
    defer rig.destroy();
    try useLoginScript(rig, &.{ "definitely-not-installed-xyz", "login" });
    var missing = try rig.call(agents.login, .{ .id = "claude" });
    defer missing.deinit();
    try expectJsonBody(&missing, 409, "{\"error\":\"definitely-not-installed-xyz could not be started, is it installed?\"}");
    try testing.expect(loginsEmpty(rig));
}

test "agents: one login at a time, killed with its group after the timeout, then a new one may start" {
    const rig = try Rig.create();
    defer rig.destroy();
    var dir_buf: [Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = dir_buf[0..try rig.tmp.dir.realPath(testing.io, &dir_buf)];
    const script = try std.fmt.allocPrint(testing.allocator, "sleep 30 & echo $! > '{s}/helper'; echo $$ > '{s}/pid'; wait", .{ dir_path, dir_path });
    defer testing.allocator.free(script);
    try useLoginScript(rig, &.{ "/bin/sh", "-c", script });
    rig.ctx.login_timeout_ms = 600;

    // A cached discovery is dropped when the login ends.
    rig.scripted.replies = &.{.{ "claude --version", .{ .stdout = "1.0.0" } }};
    var listed = try rig.call(agents.list, .{});
    listed.deinit();
    try testing.expect(rig.ctx.cache != null);

    var started = try rig.call(agents.login, .{ .id = "claude" });
    defer started.deinit();
    try testing.expectEqual(@as(u16, 200), started.res.status);
    try testing.expect(std.mem.startsWith(u8, writtenBody(&started), "{\"command\":[\"/bin/sh\",\"-c\",\""));
    const pid = try waitForPid(rig.tmp.dir, "pid");
    const helper = try waitForPid(rig.tmp.dir, "helper");

    var again = try rig.call(agents.login, .{ .id = "claude" });
    defer again.deinit();
    try testing.expectEqualStrings(writtenBody(&started), writtenBody(&again));
    try testing.expectEqual(pid, try waitForPid(rig.tmp.dir, "pid"));

    for (0..500) |_| {
        if (loginsEmpty(rig)) break;
        try testing.io.sleep(.fromMilliseconds(10), .awake);
    } else return error.LoginNeverEnded;
    for (0..200) |_| {
        if (!process_mod.pidExists(pid) and !process_mod.pidExists(helper)) break;
        try testing.io.sleep(.fromMilliseconds(10), .awake);
    } else return error.GroupSurvived;
    try testing.expect(rig.ctx.cache == null);

    try rig.tmp.dir.deleteFile(testing.io, "pid");
    var restarted = try rig.call(agents.login, .{ .id = "claude" });
    defer restarted.deinit();
    try testing.expectEqual(@as(u16, 200), restarted.res.status);
    try testing.expect(try waitForPid(rig.tmp.dir, "pid") != pid);
}

test "agents: a login that ignores SIGTERM is killed after the grace" {
    const rig = try Rig.create();
    defer rig.destroy();
    var dir_buf: [Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = dir_buf[0..try rig.tmp.dir.realPath(testing.io, &dir_buf)];
    const script = try std.fmt.allocPrint(testing.allocator, "trap '' TERM; echo $$ > '{s}/pid'; while :; do /bin/sleep 1; done", .{dir_path});
    defer testing.allocator.free(script);
    try useLoginScript(rig, &.{ "/bin/sh", "-c", script });
    rig.ctx.login_timeout_ms = 300;
    rig.ctx.login_grace_ms = 100;
    var started = try rig.call(agents.login, .{ .id = "claude" });
    defer started.deinit();
    const pid = try waitForPid(rig.tmp.dir, "pid");
    for (0..300) |_| {
        if (loginsEmpty(rig) and !process_mod.pidExists(pid)) return;
        try testing.io.sleep(.fromMilliseconds(10), .awake);
    }
    return error.SurvivedSigterm;
}

test "agents: a login still running when the server stops is ended" {
    const rig = try Rig.create();
    var dir_buf: [Io.Dir.max_path_bytes]u8 = undefined;
    const dir_path = dir_buf[0..try rig.tmp.dir.realPath(testing.io, &dir_buf)];
    const script = try std.fmt.allocPrint(testing.allocator, "echo $$ > '{s}/pid'; exec sleep 30", .{dir_path});
    defer testing.allocator.free(script);
    try useLoginScript(rig, &.{ "/bin/sh", "-c", script });
    var started = try rig.call(agents.login, .{ .id = "claude" });
    started.deinit();
    const pid = try waitForPid(rig.tmp.dir, "pid");
    rig.destroy();
    for (0..200) |_| {
        if (!process_mod.pidExists(pid)) return;
        try testing.io.sleep(.fromMilliseconds(10), .awake);
    }
    return error.StillRunning;
}
