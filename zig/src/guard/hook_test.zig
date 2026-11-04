//! The hook's decisions and exit codes (the cases of guard-hook.test.ts), hostile input, allocation
//! failure, and the telemetry POST against a stub HTTP server.
const std = @import("std");
const hook = @import("hook.zig");
const hook_http = @import("hook_http.zig");
const test_alloc = @import("test_alloc.zig");

const gpa = std.testing.allocator;
const io = std.testing.io;

fn baseEnv(map: *std.process.Environ.Map) !void {
    try map.put("HARNESS_SCOPE_ROOT", "/work/tree");
    try map.put("HARNESS_DEFAULT_BRANCH", "main");
    try map.put("HOME", "/home/u");
}

const Outcome = struct { exit: u8, stdout: []const u8, stderr: []const u8, report: ?hook.Report };

fn run(arena: std.mem.Allocator, env: *const std.process.Environ.Map, stdin: []const u8) Outcome {
    const d = hook.decide(arena, gpa, io, env, stdin);
    return .{ .exit = d.exit, .stdout = d.stdout, .stderr = d.stderr, .report = d.report };
}

fn bash(arena: std.mem.Allocator, command: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "{{\"tool_name\":\"Bash\",\"tool_input\":{{\"command\":{f}}},\"cwd\":\"/work/tree\"}}", .{std.json.fmt(command, .{})});
}

test "hook: deny exits 2 with the reason on stderr" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const o = run(arena.allocator(), &env, try bash(arena.allocator(), "rm -rf ~"));
    try std.testing.expectEqual(@as(u8, 2), o.exit);
    try std.testing.expect(std.mem.startsWith(u8, o.stderr, "harness guard: "));
    try std.testing.expect(o.report.?.verdict == .deny);
}

test "hook: allow exits 0 silently and ask prints the permission decision" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const allowed = run(arena.allocator(), &env, try bash(arena.allocator(), "ls"));
    try std.testing.expectEqual(@as(u8, 0), allowed.exit);
    try std.testing.expectEqualStrings("", allowed.stdout);
    try std.testing.expectEqualStrings("", allowed.stderr);
    const asked = run(arena.allocator(), &env, try bash(arena.allocator(), "git push origin feature/x"));
    try std.testing.expectEqual(@as(u8, 0), asked.exit);
    try std.testing.expectEqualStrings(
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\"}}\n",
        asked.stdout,
    );
}

test "hook: a missing scope or home fails closed" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const input = try bash(arena.allocator(), "ls");
    _ = env.swapRemove("HARNESS_SCOPE_ROOT");
    try std.testing.expectEqual(@as(u8, 2), run(arena.allocator(), &env, input).exit);
    try baseEnv(&env);
    _ = env.swapRemove("HOME");
    try std.testing.expectEqual(@as(u8, 2), run(arena.allocator(), &env, input).exit);
    try baseEnv(&env);
    try env.put("HARNESS_SCOPE_ROOT", "relative/root");
    try std.testing.expectEqual(@as(u8, 2), run(arena.allocator(), &env, input).exit);
}

test "hook: reading a credential path is denied, editing inside the root is allowed" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const read = "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/home/u/.ssh/id_rsa\"},\"cwd\":\"/work/tree\"}";
    try std.testing.expectEqual(@as(u8, 2), run(arena.allocator(), &env, read).exit);
    const edit = "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"src/a.ts\"},\"cwd\":\"/work/tree\"}";
    try std.testing.expectEqual(@as(u8, 0), run(arena.allocator(), &env, edit).exit);
    const hooks = "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\".git/hooks/pre-commit\"},\"cwd\":\"/work/tree\"}";
    try std.testing.expectEqual(@as(u8, 2), run(arena.allocator(), &env, hooks).exit);
    const fetch = "{\"tool_name\":\"WebFetch\",\"tool_input\":{},\"cwd\":\"/work/tree\"}";
    try std.testing.expect(std.mem.find(u8, run(arena.allocator(), &env, fetch).stdout, "\"permissionDecision\":\"ask\"") != null);
    const unknown = "{\"tool_name\":\"Mystery\",\"tool_input\":{}}";
    try std.testing.expect(std.mem.find(u8, run(arena.allocator(), &env, unknown).stdout, "\"permissionDecision\":\"ask\"") != null);
}

test "hook: input that does not match the schema exits 2" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const bad = [_][]const u8{
        "null",                                                             "\"x\"",
        "[]",                                                               "1",
        "{}",                                                               "{\"tool_name\":\"Bash\"}",
        "{\"tool_name\":1,\"tool_input\":{}}",                              "{\"tool_name\":\"Bash\",\"tool_input\":[]}",
        "{\"tool_name\":\"Bash\",\"tool_input\":null}",                     "{\"tool_name\":\"Bash\",\"tool_input\":\"ls\"}",
        "{\"tool_name\":\"Bash\",\"tool_input\":{},\"cwd\":null}",          "{\"tool_name\":\"Bash\",\"tool_input\":{},\"cwd\":3}",
        "not json",                                                         "",
        "{\"tool_name\":\"Bash\",\"tool_input\":{}} x",                     "{\"tool_name\":\"Bash\",\"tool_input\":{}",
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}\xff", "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\xff\"}}",
        "\xef\xbb\xbf{\"tool_name\":\"Bash\",\"tool_input\":{}}",           "{\"tool_name\":\"Bash\",\"tool_name\":2,\"tool_input\":{}}",
        "{\"tool_name\":\"Bash\",\"tool_input\":{},\"tool_input\":[]}",
    };
    for (bad) |input| {
        const o = run(arena.allocator(), &env, input);
        try std.testing.expectEqual(@as(u8, 2), o.exit);
        try std.testing.expect(std.mem.find(u8, o.stderr, "harness guard") != null);
    }
}

test "hook: the last duplicate key wins, as in JSON.parse" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const input = "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf ~\",\"command\":\"ls\"},\"cwd\":\"/work/tree\"}";
    try std.testing.expectEqual(@as(u8, 0), run(arena.allocator(), &env, input).exit);
    const swapped = "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\",\"command\":\"rm -rf ~\"}}";
    try std.testing.expectEqual(@as(u8, 2), run(arena.allocator(), &env, swapped).exit);
}

test "hook: hostile nesting ends in exit 2 and an over-long command is an ask, without a crash" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const a = arena.allocator();
    const deep = try a.alloc(u8, 2_000_000);
    @memset(deep, '[');
    try std.testing.expectEqual(@as(u8, 2), run(a, &env, deep).exit);
    const nested = try std.fmt.allocPrint(a, "{{\"tool_name\":\"Bash\",\"tool_input\":{{\"x\":{s}}}}}", .{deep});
    try std.testing.expectEqual(@as(u8, 2), run(a, &env, nested).exit);
    const long = try a.alloc(u8, 200_000);
    @memset(long, 'a');
    const huge = try std.fmt.allocPrint(a, "{{\"tool_name\":\"Bash\",\"tool_input\":{{\"command\":\"echo {s}\"}}}}", .{long});
    const long_path = try std.fmt.allocPrint(a, "{{\"tool_name\":\"Read\",\"tool_input\":{{\"file_path\":\"/work/tree/{s}\"}}}}", .{long[0..3000]});
    try std.testing.expectEqual(@as(u8, 0), run(a, &env, long_path).exit);
    const longer = try a.alloc(u8, 70_000);
    @memset(longer, '*');
    const absurd_path = try std.fmt.allocPrint(a, "{{\"tool_name\":\"Read\",\"tool_input\":{{\"file_path\":\"/work/tree/{s}\"}}}}", .{longer});
    try std.testing.expectEqual(@as(u8, 2), run(a, &env, absurd_path).exit);
    const too_long = run(a, &env, huge);
    try std.testing.expectEqual(@as(u8, 0), too_long.exit);
    try std.testing.expect(std.mem.find(u8, too_long.stdout, "\"permissionDecision\":\"ask\"") != null);
}

fn decideOnce(alloc: std.mem.Allocator, input: []const u8) !void {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try baseEnv(&env);
    var base_arena = std.heap.ArenaAllocator.init(gpa);
    defer base_arena.deinit();
    const want = hook.decide(base_arena.allocator(), gpa, io, &env, input);
    var counted: test_alloc.NoResize = .{ .inner = alloc };
    var arena = std.heap.ArenaAllocator.init(counted.allocator());
    defer arena.deinit();
    const d = hook.decide(arena.allocator(), counted.allocator(), io, &env, input);
    if (d.exit == want.exit and std.mem.eql(u8, d.stdout, want.stdout) and std.mem.eql(u8, d.stderr, want.stderr)) return;
    // An allocation failure may turn a decision into a deny, never into anything weaker.
    if (d.exit != 2) return error.TestUnexpectedResult;
    return error.OutOfMemory;
}

test "hook: allocation failures never weaken a decision" {
    const inputs = [_][]const u8{
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ok && rm -rf ~\"},\"cwd\":\"/work/tree\"}",
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la | wc -l\"},\"cwd\":\"/work/tree\"}",
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin feature/x\"}}",
        "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/etc/hosts\"}}",
        "{\"tool_name\":\"Read\",\"tool_input\":{\"path\":\"~/.ssh\"}}",
    };
    for (inputs) |input| std.testing.checkAllAllocationFailures(gpa, decideOnce, .{input}) catch |e| {
        std.debug.print("input {s}: {t}\n", .{ input, e });
        return e;
    };
}

test "hook: a fuzz loop over mutated hook input never crashes and never allows a deny" {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const seeds = [_][]const u8{
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf ~; ls\"},\"cwd\":\"/work/tree\"}",
        "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"~/.aws/credentials\"}}",
        "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/etc/passwd\",\"content\":\"x\"}}",
    };
    const structural = "{}[]\",:\\ \n";
    var prng = std.Random.DefaultPrng.init(0x6a72);
    const rand = prng.random();
    var buf: [256]u8 = undefined;
    for (0..4000) |_| {
        _ = arena_state.reset(.retain_capacity);
        const seed = seeds[rand.uintLessThan(usize, seeds.len)];
        @memcpy(buf[0..seed.len], seed);
        var len = seed.len;
        for (0..rand.uintLessThan(usize, 4)) |_| {
            const at = rand.uintLessThan(usize, len);
            switch (rand.uintLessThan(u8, 3)) {
                0 => buf[at] = rand.int(u8),
                1 => buf[at] = structural[rand.uintLessThan(usize, structural.len)],
                else => len = at + 1,
            }
        }
        const o = run(arena_state.allocator(), &env, buf[0..len]);
        try std.testing.expect(o.exit == 0 or o.exit == 2);
        if (o.exit == 0 and o.report == null) return error.TestUnexpectedResult;
    }
}

// ---- telemetry against a stub server -------------------------------------------------------

const Stub = struct {
    server: std.Io.net.Server,
    mode: enum { reply, close, hang },
    request: [16384]u8 = undefined,
    request_len: usize = 0,
    port: u16,

    fn start(mode: @FieldType(Stub, "mode")) !Stub {
        const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        const server = try any.listen(io, .{});
        return .{ .server = server, .mode = mode, .port = server.socket.address.getPort() };
    }

    fn serve(self: *Stub) void {
        var stream = self.server.accept(io) catch return;
        defer stream.close(io);
        var read_buffer: [16384]u8 = undefined;
        var write_buffer: [256]u8 = undefined;
        var reader = stream.reader(io, &read_buffer);
        var writer = stream.writer(io, &write_buffer);
        const r = &reader.interface;
        var len_header: usize = 0;
        while (r.takeDelimiter('\n') catch return) |line| {
            self.append(line);
            self.append("\n");
            if (std.ascii.startsWithIgnoreCase(line, "content-length: ")) {
                len_header = std.fmt.parseInt(usize, std.mem.trim(u8, line["content-length: ".len..], " \r"), 10) catch return;
            }
            if (std.mem.eql(u8, line, "\r")) break;
        }
        const body = r.take(len_header) catch return;
        self.append(body);
        switch (self.mode) {
            .reply => {
                writer.interface.writeAll("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok") catch return;
                writer.interface.flush() catch return;
            },
            .close => {},
            .hang => io.sleep(.fromSeconds(30), .awake) catch {},
        }
    }

    fn append(self: *Stub, bytes: []const u8) void {
        const n = @min(bytes.len, self.request.len - self.request_len);
        @memcpy(self.request[self.request_len..][0..n], bytes[0..n]);
        self.request_len += n;
    }
};

fn reported(arena: std.mem.Allocator, mode: @FieldType(Stub, "mode"), command: []const u8, expect_exit: u8) !struct { stub: *Stub, ms: i64 } {
    const stub = try arena.create(Stub);
    stub.* = try Stub.start(mode);
    var group: std.Io.Group = .init;
    try group.concurrent(io, Stub.serve, .{stub});
    defer {
        group.cancel(io);
        stub.server.deinit(io);
    }
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    try env.put("HARNESS_HOOK_URL", try std.fmt.allocPrint(arena, "http://127.0.0.1:{d}/api/guard/hook", .{stub.port}));
    try env.put("HARNESS_RUN_TOKEN", "tok-1");
    try env.put("HARNESS_RUN_ID", "run-1");
    const start = std.Io.Clock.awake.now(io);
    const d = hook.decide(arena, gpa, io, &env, try bash(arena, command));
    hook.sendReport(arena, io, &env, d.report.?);
    const ms = start.durationTo(std.Io.Clock.awake.now(io)).toMilliseconds();
    try std.testing.expectEqual(expect_exit, d.exit);
    return .{ .stub = stub, .ms = ms };
}

test "hook: the verdict is POSTed with the run token and the exit code follows the decision" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const got = try reported(arena.allocator(), .reply, "rm -rf ~", 2);
    const req = got.stub.request[0..got.stub.request_len];
    try std.testing.expect(std.mem.startsWith(u8, req, "POST /api/guard/hook HTTP/1.1\r\n"));
    try std.testing.expect(std.mem.find(u8, req, "authorization: Bearer tok-1\r\n") != null);
    try std.testing.expect(std.mem.find(u8, req, "content-type: application/json\r\n") != null);
    try std.testing.expect(std.mem.find(u8, req, "{\"runId\":\"run-1\",\"verdict\":\"deny\",\"rule\":\"rm.outside-root\",\"command\":\"rm -rf ~\"}") != null);
}

test "hook: a server that closes, hangs or is absent never changes the decision" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const closed = try reported(arena.allocator(), .close, "rm -rf ~", 2);
    try std.testing.expect(closed.ms < 3000);
    const hung = try reported(arena.allocator(), .hang, "ls", 0);
    try std.testing.expect(hung.ms >= hook_http.timeout_ms - 100 and hung.ms < 4000);

    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    const port = blk: {
        const any: std.Io.net.IpAddress = .{ .ip4 = .loopback(0) };
        var s = try any.listen(io, .{});
        defer s.deinit(io);
        break :blk s.socket.address.getPort();
    };
    try env.put("HARNESS_HOOK_URL", try std.fmt.allocPrint(arena.allocator(), "http://127.0.0.1:{d}/x", .{port}));
    const d = hook.decide(arena.allocator(), gpa, io, &env, try bash(arena.allocator(), "rm -rf ~"));
    hook.sendReport(arena.allocator(), io, &env, d.report.?);
    try std.testing.expectEqual(@as(u8, 2), d.exit);
}

test "hook: a long bearer token is sent in full" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const stub = try a.create(Stub);
    stub.* = try Stub.start(.reply);
    var group: std.Io.Group = .init;
    try group.concurrent(io, Stub.serve, .{stub});
    defer {
        group.cancel(io);
        stub.server.deinit(io);
    }
    const token = try a.alloc(u8, 6000);
    @memset(token, 't');
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    try env.put("HARNESS_HOOK_URL", try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/api/guard/hook", .{stub.port}));
    try env.put("HARNESS_RUN_TOKEN", token);
    const d = hook.decide(a, gpa, io, &env, try bash(a, "ls"));
    hook.sendReport(a, io, &env, d.report.?);
    const req = stub.request[0..stub.request_len];
    try std.testing.expect(std.mem.find(u8, req, try std.fmt.allocPrint(a, "authorization: Bearer {s}\r\n", .{token})) != null);
    try std.testing.expect(std.mem.find(u8, req, "\"verdict\":\"allow\"") != null);
}

test "hook: harness MCP tool names get the same ask as in the TS hook, which never sets a tool name" {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var env = std.process.Environ.Map.init(gpa);
    defer env.deinit();
    try baseEnv(&env);
    for ([_][]const u8{ "mcp__harness__task_get", "mcp__harness__whoami", "mcp.harness.task_get" }) |name| {
        const input = try std.fmt.allocPrint(arena.allocator(), "{{\"tool_name\":\"{s}\",\"tool_input\":{{}}}}", .{name});
        const o = run(arena.allocator(), &env, input);
        try std.testing.expectEqual(@as(u8, 0), o.exit);
        try std.testing.expect(std.mem.find(u8, o.stdout, "\"permissionDecision\":\"ask\"") != null);
    }
}

test "hook: the run token only goes to loopback addresses" {
    const refused = [_][]const u8{
        "http://10.0.0.5:4100/a",      "http://0.0.0.0:4100/a",       "http://8.8.8.8:80/a",
        "http://128.0.0.1:1/a",        "http://126.255.255.255:1/a",  "http://example.com:4100/a",
        "http://[2001:db8::1]:4100/a", "http://[::]:4100/a",          "http://[::ffff:10.0.0.5]:1/a",
        "http://localhost.evil.com/a", "http://127.0.0.1.evil.com/a", "http://user@10.0.0.5:1/a",
        "http://[::1/a",               "http://[::1]x:1/a",
    };
    for (refused) |url| try std.testing.expect(hook_http.parseUrl(url) == null);
    for ([_][]const u8{ "http://127.0.0.1:1/a", "http://127.1.2.3:1/a", "http://localhost:1/a", "http://[::1]:4100/a", "http://[::1]/a" }) |url| {
        try std.testing.expect(hook_http.parseUrl(url) != null);
    }
}

test "hook: only plain loopback http URLs are targets" {
    try std.testing.expect(hook_http.parseUrl("http://127.0.0.1:4100/api/guard/hook") != null);
    try std.testing.expect(hook_http.parseUrl("http://localhost:4100/a") != null);
    try std.testing.expect(hook_http.parseUrl("https://127.0.0.1:4100/a") == null);
    try std.testing.expect(hook_http.parseUrl("http://example.com/a") == null);
    try std.testing.expect(hook_http.parseUrl("http://127.0.0.1:99999/a") == null);
    try std.testing.expect(hook_http.parseUrl("http://127.0.0.1:1/a\r\nx: y") == null);
    try std.testing.expect(hook_http.parseUrl("") == null);
}
