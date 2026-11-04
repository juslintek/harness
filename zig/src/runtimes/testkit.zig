//! Test-only helpers: a recording set of run hooks and the environment for the scripted fake
//! agent (code/scripts/fake-acp-agent.ts, run through bun). Only test blocks import this file.
const std = @import("std");
const types = @import("types.zig");

const Io = std.Io;
const testing = std.testing;

pub const Rec = struct {
    kind: types.EventKind,
    body: []u8,
    command: ?[]u8,
    rule: ?[]u8,
    layer: ?types.GuardLayer,
    verdict: ?types.GuardVerdict,
};

pub const DecideMode = enum { allow, deny, hang, fail };

pub const Recorder = struct {
    gpa: std.mem.Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    events: std.ArrayList(Rec) = .empty,
    ask_commands: std.ArrayList([]u8) = .empty,
    logged: std.ArrayList([]u8) = .empty,
    quotas: u32 = 0,
    progress: std.ArrayList(i64) = .empty,
    pid: std.posix.pid_t = 0,
    mode: DecideMode = .deny,
    /// An emit of this kind fails, like a database that is busy.
    fail_emit_on: ?types.EventKind = null,
    fail_spawn_hook: bool = false,
    fail_progress: bool = false,
    /// Set when an event of this kind is emitted, to abort a run from inside it.
    abort_on: ?types.EventKind = null,
    abort_event: ?*Io.Event = null,

    pub fn init(gpa: std.mem.Allocator, io: Io) Recorder {
        return .{ .gpa = gpa, .io = io };
    }

    pub fn deinit(r: *Recorder) void {
        for (r.events.items) |e| {
            r.gpa.free(e.body);
            if (e.command) |c| r.gpa.free(c);
            if (e.rule) |c| r.gpa.free(c);
        }
        r.events.deinit(r.gpa);
        for (r.ask_commands.items) |c| r.gpa.free(c);
        r.ask_commands.deinit(r.gpa);
        for (r.logged.items) |c| r.gpa.free(c);
        r.logged.deinit(r.gpa);
        r.progress.deinit(r.gpa);
    }

    pub fn hooks(r: *Recorder) types.Hooks {
        return .{
            .ctx = r,
            .emit = emit,
            .decide = decide,
            .on_quota = onQuota,
            .on_progress = onProgress,
            .on_spawn = onSpawn,
            .log_error = logError,
        };
    }

    fn from(ctx: *anyopaque) *Recorder {
        return @ptrCast(@alignCast(ctx));
    }

    fn emit(ctx: *anyopaque, event: types.NewEvent) anyerror!void {
        const r = from(ctx);
        if (r.fail_emit_on == event.kind) return error.DbBusy;
        {
            r.mutex.lockUncancelable(r.io);
            defer r.mutex.unlock(r.io);
            const body = try r.gpa.dupe(u8, event.body orelse "");
            errdefer r.gpa.free(body);
            const command = if (event.command) |c| try r.gpa.dupe(u8, c) else null;
            errdefer if (command) |c| r.gpa.free(c);
            const rule = if (event.guard_rule) |c| try r.gpa.dupe(u8, c) else null;
            errdefer if (rule) |c| r.gpa.free(c);
            try r.events.append(r.gpa, .{
                .kind = event.kind,
                .body = body,
                .command = command,
                .rule = rule,
                .layer = event.guard_layer,
                .verdict = event.guard_verdict,
            });
        }
        if (r.abort_on == event.kind) if (r.abort_event) |abort| abort.set(r.io);
    }

    fn decide(ctx: *anyopaque, ask: types.Ask) anyerror!types.Verdict {
        const r = from(ctx);
        {
            r.mutex.lockUncancelable(r.io);
            defer r.mutex.unlock(r.io);
            try r.ask_commands.append(r.gpa, try r.gpa.dupe(u8, ask.command orelse ""));
        }
        return switch (r.mode) {
            .allow => .allow,
            .deny => .deny,
            .fail => error.GuardDown,
            .hang => {
                try r.io.sleep(.fromSeconds(3600), .awake);
                return .deny;
            },
        };
    }

    fn onQuota(ctx: *anyopaque, _: types.Quota) anyerror!void {
        from(ctx).quotas += 1;
    }

    fn onProgress(ctx: *anyopaque, tokens: i64) anyerror!void {
        const r = from(ctx);
        if (r.fail_progress) return error.BreakerBroke;
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        try r.progress.append(r.gpa, tokens);
    }

    fn onSpawn(ctx: *anyopaque, pid: std.posix.pid_t) anyerror!void {
        const r = from(ctx);
        if (r.fail_spawn_hook) return error.PidWriteFailed;
        r.pid = pid;
    }

    fn logError(ctx: *anyopaque, message: []const u8) void {
        const r = from(ctx);
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const copy = r.gpa.dupe(u8, message) catch return;
        r.logged.append(r.gpa, copy) catch r.gpa.free(copy);
    }

    pub fn countKind(r: *Recorder, kind: types.EventKind) usize {
        var n: usize = 0;
        for (r.events.items) |e| {
            if (e.kind == kind) n += 1;
        }
        return n;
    }

    /// The bodies of every message event, concatenated.
    pub fn said(r: *Recorder, gpa: std.mem.Allocator) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        for (r.events.items) |e| {
            if (e.kind == .message) try out.appendSlice(gpa, e.body);
        }
        return out.toOwnedSlice(gpa);
    }

    pub fn firstOf(r: *Recorder, kind: types.EventKind) ?Rec {
        for (r.events.items) |e| {
            if (e.kind == kind) return e;
        }
        return null;
    }
};

/// The PATH the test process runs with: setup-bun and Homebrew put bun in places a fixed list
/// would miss.
pub fn testPath() []const u8 {
    return testing.environ.getPosix("PATH") orelse "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin";
}

/// The absolute path of bun, found on PATH. The tests run the fake agent with it, so a missing
/// bun fails them here with a message that says so.
fn findBun(gpa: std.mem.Allocator, io: Io) ![]u8 {
    var dirs = std.mem.splitScalar(u8, testPath(), ':');
    while (dirs.next()) |dir| {
        if (dir.len == 0) continue;
        const candidate = try std.fs.path.join(gpa, &.{ dir, "bun" });
        Io.Dir.cwd().access(io, candidate, .{ .execute = true }) catch {
            gpa.free(candidate);
            continue;
        };
        return candidate;
    }
    std.debug.print("bun is not on PATH ({s}); the runtimes tests run scripts/fake-acp-agent.ts with it\n", .{testPath()});
    return error.BunNotOnPath;
}

/// A directory, an environment and the paths a scripted fake agent needs.
pub const Fake = struct {
    gpa: std.mem.Allocator,
    tmp: testing.TmpDir,
    dir: [:0]u8,
    script: [:0]u8,
    pid_file: []u8,
    log_file: []u8,
    env: std.process.Environ.Map,
    argv: [2][]const u8,
    bun: []u8,

    pub fn init(gpa: std.mem.Allocator, io: Io, script_json: []const u8) !*Fake {
        const fake = try gpa.create(Fake);
        errdefer gpa.destroy(fake);
        fake.gpa = gpa;
        fake.tmp = testing.tmpDir(.{});
        errdefer fake.tmp.cleanup();
        fake.dir = try fake.tmp.dir.realPathFileAlloc(io, ".", gpa);
        errdefer gpa.free(fake.dir);
        // `zig build test` runs from the build root, zig/, so the repo's code/ is one level up.
        fake.script = Io.Dir.cwd().realPathFileAlloc(io, "../code/scripts/fake-acp-agent.ts", gpa) catch |err| {
            std.debug.print("fake agent script not found at ../code/scripts/fake-acp-agent.ts: {t}\n", .{err});
            return err;
        };
        errdefer gpa.free(fake.script);
        fake.bun = try findBun(gpa, io);
        errdefer gpa.free(fake.bun);
        fake.pid_file = try std.fs.path.join(gpa, &.{ fake.dir, "pid" });
        errdefer gpa.free(fake.pid_file);
        fake.log_file = try std.fs.path.join(gpa, &.{ fake.dir, "log" });
        errdefer gpa.free(fake.log_file);
        fake.env = std.process.Environ.Map.init(gpa);
        errdefer fake.env.deinit();
        try fake.env.put("PATH", testPath());
        try fake.env.put("FAKE_AGENT_SCRIPT", script_json);
        try fake.env.put("FAKE_AGENT_PIDFILE", fake.pid_file);
        try fake.env.put("FAKE_AGENT_LOG", fake.log_file);
        fake.argv = .{ fake.bun, fake.script };
        return fake;
    }

    pub fn deinit(fake: *Fake) void {
        fake.env.deinit();
        fake.gpa.free(fake.log_file);
        fake.gpa.free(fake.pid_file);
        fake.gpa.free(fake.bun);
        fake.gpa.free(fake.script);
        fake.gpa.free(fake.dir);
        fake.tmp.cleanup();
        fake.gpa.destroy(fake);
    }

    pub fn config(fake: *Fake, spec_id: []const u8) types.RunConfig {
        return .{
            .run_id = "run-1",
            .cwd = fake.dir,
            .prompt = "go",
            .model = null,
            .spec = .{
                .id = spec_id,
                .argv = &fake.argv,
                .mode_option = .{ .config_id = "mode", .value = "default" },
            },
            .argv = &fake.argv,
            .env = &fake.env,
            .idle_timeout_ms = 10_000,
        };
    }

    /// The pid the fake agent wrote about itself, which is the agent proper, not the launcher.
    pub fn agentPid(fake: *Fake, io: Io) !std.posix.pid_t {
        const text = try Io.Dir.cwd().readFileAlloc(io, fake.pid_file, fake.gpa, .limited(64));
        defer fake.gpa.free(text);
        return std.fmt.parseInt(std.posix.pid_t, std.mem.trim(u8, text, " \n"), 10);
    }

    /// The JSON-RPC methods the agent received, in order, one per line.
    pub fn receivedMethods(fake: *Fake, io: Io) ![]u8 {
        const text = Io.Dir.cwd().readFileAlloc(io, fake.log_file, fake.gpa, .limited(1 << 20)) catch |err| switch (err) {
            error.FileNotFound => return fake.gpa.dupe(u8, ""),
            else => return err,
        };
        defer fake.gpa.free(text);
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(fake.gpa);
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            const parsed = try std.json.parseFromSlice(std.json.Value, fake.gpa, line, .{});
            defer parsed.deinit();
            const method = parsed.value.object.get("method") orelse continue;
            try out.appendSlice(fake.gpa, method.string);
            try out.append(fake.gpa, '\n');
        }
        return out.toOwnedSlice(fake.gpa);
    }
};
