//! Agent discovery: code/src/server/features/agents/discover.ts. Per spec the version command, then
//! `which`, then the login probe, each bounded by the probe timeout. Specs are probed concurrently.
const std = @import("std");
const parity = @import("../parity.zig");
const runner_mod = @import("runner.zig");
const specs_mod = @import("specs.zig");

const Runner = runner_mod.Runner;
const Spec = specs_mod.Spec;

pub const probe_timeout_ms: i64 = 5000;

pub const Discovered = struct {
    id: []const u8,
    installed: bool,
    path: ?[]const u8,
    version: ?[]const u8,
    logged_in: ?bool,
    err: ?[]const u8,
};

pub const Probe = struct {
    runner: Runner,
    timeout_ms: i64 = probe_timeout_ms,
    /// `process.env.GEMINI_API_KEY` is set and not empty.
    gemini_key: bool,
};

/// `parseVersion`: the first match of /\d+\.\d+\.\d+\S*/.
pub fn parseVersion(text: []const u8) ?[]const u8 {
    var start: usize = 0;
    while (start < text.len) {
        if (!std.ascii.isDigit(text[start])) {
            start += 1;
            continue;
        }
        var end = start;
        var matched = true;
        for (0..3) |part| {
            const digits_start = end;
            while (end < text.len and std.ascii.isDigit(text[end])) end += 1;
            if (end == digits_start) {
                matched = false;
                break;
            }
            if (part < 2) {
                if (end >= text.len or text[end] != '.') {
                    matched = false;
                    break;
                }
                end += 1;
            }
        }
        if (matched) {
            while (end < text.len and !std.ascii.isWhitespace(text[end])) end += 1;
            return text[start..end];
        }
        // The next start is past this run of digits: a start inside it would fail the same way.
        while (start < text.len and std.ascii.isDigit(text[start])) start += 1;
    }
    return null;
}

fn timedOutText(arena: std.mem.Allocator, probe: Probe) std.mem.Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "timed out after {d} ms", .{probe.timeout_ms});
}

fn errorText(arena: std.mem.Allocator, probe: Probe, err: runner_mod.Error) std.mem.Allocator.Error![]const u8 {
    return switch (err) {
        error.TimedOut => timedOutText(arena, probe),
        error.OutOfMemory => error.OutOfMemory,
        error.Canceled => "canceled",
    };
}

const LoginState = struct { logged_in: ?bool, err: ?[]const u8 };

fn probeLogin(arena: std.mem.Allocator, probe: Probe, spec: *const Spec) std.mem.Allocator.Error!LoginState {
    const login = spec.login_probe orelse return .{ .logged_in = null, .err = null };
    const out = probe.runner.run(arena, login.args, probe.timeout_ms, login.env) catch |err|
        return .{ .logged_in = null, .err = try errorText(arena, probe, err) };
    const signed_in = out.code == 0 and switch (login.logged_in_when) {
        .exit0 => true,
        .stdout_includes => |needle| std.mem.find(u8, out.stdout, needle) != null or std.mem.find(u8, out.stderr, needle) != null,
    };
    return .{ .logged_in = signed_in, .err = null };
}

/// `discoverOne`. Strings are allocated in `arena`.
pub fn discoverOne(arena: std.mem.Allocator, probe: Probe, spec: *const Spec) std.mem.Allocator.Error!Discovered {
    const missing: Discovered = .{ .id = spec.id, .installed = false, .path = null, .version = null, .logged_in = null, .err = null };
    if (std.mem.eql(u8, spec.id, "gemini") and !probe.gemini_key) {
        var found = missing;
        found.err = "GEMINI_API_KEY is not set";
        return found;
    }
    var failed = missing;
    const version = probe.runner.run(arena, spec.version_args, probe.timeout_ms, &.{}) catch |err| {
        failed.err = try errorText(arena, probe, err);
        return failed;
    };
    if (version.code != 0) {
        if (version.code != runner_mod.not_found_code) {
            const trimmed = parity.jsTrim(version.stderr);
            failed.err = if (trimmed.len > 0) trimmed else try std.fmt.allocPrint(arena, "exit {d}", .{version.code});
        }
        return failed;
    }
    const which = probe.runner.run(arena, &.{ "which", spec.version_args[0] }, probe.timeout_ms, &.{}) catch |err| {
        failed.err = try errorText(arena, probe, err);
        return failed;
    };
    const which_path = parity.jsTrim(which.stdout);
    const login = try probeLogin(arena, probe, spec);
    return .{
        .id = spec.id,
        .installed = true,
        .path = if (which.code == 0 and which_path.len > 0) which_path else null,
        .version = parseVersion(version.stdout),
        .logged_in = login.logged_in,
        .err = login.err,
    };
}

/// The result of one discovery pass, with the strings it points at.
pub const Snapshot = struct {
    arena: std.heap.ArenaAllocator,
    items: []Discovered,
    /// Epoch ms when the pass finished.
    at: i64,

    pub fn deinit(self: *Snapshot) void {
        self.arena.deinit();
    }

    /// A deep copy that lives as long as `into`.
    pub fn cloneInto(self: *const Snapshot, into: std.mem.Allocator) std.mem.Allocator.Error![]Discovered {
        const copy = try into.alloc(Discovered, self.items.len);
        for (self.items, copy) |item, *slot| slot.* = .{
            .id = try into.dupe(u8, item.id),
            .installed = item.installed,
            .path = if (item.path) |text| try into.dupe(u8, text) else null,
            .version = if (item.version) |text| try into.dupe(u8, text) else null,
            .logged_in = item.logged_in,
            .err = if (item.err) |text| try into.dupe(u8, text) else null,
        };
        return copy;
    }
};

fn discoverTask(arena: std.mem.Allocator, probe: Probe, spec: *const Spec, slot: *Discovered) void {
    slot.* = discoverOne(arena, probe, spec) catch .{
        .id = spec.id,
        .installed = false,
        .path = null,
        .version = null,
        .logged_in = null,
        .err = "out of memory",
    };
}

/// `discoverAgents`: all specs at once. `gpa` must be thread safe, as the tasks share one arena.
pub fn discoverAll(gpa: std.mem.Allocator, io: std.Io, probe: Probe, specs: []const Spec, now: i64) std.mem.Allocator.Error!Snapshot {
    var snapshot: Snapshot = .{ .arena = .init(gpa), .items = &.{}, .at = now };
    errdefer snapshot.arena.deinit();
    const arena = snapshot.arena.allocator();
    snapshot.items = try arena.alloc(Discovered, specs.len);
    var group: std.Io.Group = .init;
    defer group.cancel(io);
    for (specs, snapshot.items) |*spec, *slot| {
        group.concurrent(io, discoverTask, .{ arena, probe, spec, slot }) catch discoverTask(arena, probe, spec, slot);
    }
    // Cancelation only reaches here while the server shuts down; whatever finished is reported.
    group.await(io) catch {};
    return snapshot;
}

const testing = std.testing;

const Reply = struct { code: i32 = 0, stdout: []const u8 = "", stderr: []const u8 = "", times_out: bool = false };

/// Answers by the argv joined with spaces, like fakeRunner in discover.test.ts; unknown commands
/// are 127. Remembers the env of every call so a test can look at it.
const Fake = struct {
    replies: []const struct { []const u8, Reply },
    seen_env: [8]?[]const u8 = @splat(null),
    seen_keys: [8][]const u8 = undefined,
    seen: usize = 0,
    /// Off for the concurrent pass: the log is not synchronised.
    record: bool = true,

    fn runner(self: *Fake) Runner {
        return .{ .ctx = self, .run_fn = run };
    }

    fn run(ctx: *anyopaque, arena: std.mem.Allocator, argv: []const []const u8, _: i64, env: []const specs_mod.EnvPair) runner_mod.Error!runner_mod.Out {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        const key = try std.mem.join(arena, " ", argv);
        if (self.record and self.seen < self.seen_env.len) {
            self.seen_keys[self.seen] = key;
            self.seen_env[self.seen] = if (env.len > 0) env[0].value else null;
            self.seen += 1;
        }
        for (self.replies) |entry| {
            if (!std.mem.eql(u8, entry[0], key)) continue;
            if (entry[1].times_out) return error.TimedOut;
            return .{ .code = entry[1].code, .stdout = entry[1].stdout, .stderr = entry[1].stderr };
        }
        return .{ .code = runner_mod.not_found_code, .stdout = "", .stderr = "not found" };
    }
};

fn discoverById(arena: std.mem.Allocator, fake: *Fake, id: []const u8) !Discovered {
    const table = try specs_mod.builtin(arena, .{ .adapter_dir = "/a", .home = "/h" });
    const probe: Probe = .{ .runner = fake.runner(), .gemini_key = true };
    return discoverOne(arena, probe, specs_mod.find(table, id).?);
}

test "agents: a missing binary is reported as not installed" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var fake: Fake = .{ .replies = &.{} };
    const found = try discoverById(arena.allocator(), &fake, "claude");
    try testing.expect(!found.installed);
    try testing.expect(found.path == null and found.version == null and found.logged_in == null and found.err == null);
}

test "agents: version comes from the cli output, the path from which" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var fake: Fake = .{ .replies = &.{
        .{ "claude --version", .{ .stdout = "2.1.316 (Claude Code)\n" } },
        .{ "which claude", .{ .stdout = "/usr/local/bin/claude\n" } },
        .{ "claude auth status", .{ .stdout = "{\n  \"loggedIn\": true\n}" } },
    } };
    const found = try discoverById(arena.allocator(), &fake, "claude");
    try testing.expect(found.installed);
    try testing.expectEqualStrings("2.1.316", found.version.?);
    try testing.expectEqualStrings("/usr/local/bin/claude", found.path.?);
    try testing.expectEqual(@as(?bool, true), found.logged_in);
}

test "agents: a failing probe means logged out, a probe without the expected output too" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var codex: Fake = .{ .replies = &.{
        .{ "codex --version", .{ .stdout = "codex-cli 0.164.0" } },
        .{ "codex login status", .{ .code = 1 } },
    } };
    const out = try discoverById(arena.allocator(), &codex, "codex");
    try testing.expectEqualStrings("0.164.0", out.version.?);
    try testing.expectEqual(@as(?bool, false), out.logged_in);
    try testing.expect(out.err == null);
    var claude: Fake = .{ .replies = &.{
        .{ "claude --version", .{ .stdout = "2.1.316" } },
        .{ "claude auth status", .{ .stdout = "{\"loggedIn\": false}" } },
    } };
    try testing.expectEqual(@as(?bool, false), (try discoverById(arena.allocator(), &claude, "claude")).logged_in);
}

test "agents: codex prints its login status on stderr and still counts as logged in" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var fake: Fake = .{ .replies = &.{
        .{ "codex --version", .{ .stdout = "0.165.0" } },
        .{ "codex login status", .{ .stderr = "Logged in using ChatGPT" } },
    } };
    try testing.expectEqual(@as(?bool, true), (try discoverById(arena.allocator(), &fake, "codex")).logged_in);
}

test "agents: a probe that times out gives unknown login state and the error" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var fake: Fake = .{ .replies = &.{
        .{ "codex --version", .{ .stdout = "0.164.0" } },
        .{ "codex login status", .{ .times_out = true } },
    } };
    const found = try discoverById(arena.allocator(), &fake, "codex");
    try testing.expect(found.installed);
    try testing.expect(found.logged_in == null);
    try testing.expectEqualStrings("timed out after 5000 ms", found.err.?);
}

test "agents: a version command that times out or fails is reported with its error" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var slow: Fake = .{ .replies = &.{.{ "claude --version", .{ .times_out = true } }} };
    const timed_out = try discoverById(arena.allocator(), &slow, "claude");
    try testing.expect(!timed_out.installed);
    try testing.expectEqualStrings("timed out after 5000 ms", timed_out.err.?);
    var broken: Fake = .{ .replies = &.{.{ "claude --version", .{ .code = 2, .stderr = "  boom\n" } }} };
    try testing.expectEqualStrings("boom", (try discoverById(arena.allocator(), &broken, "claude")).err.?);
    var silent: Fake = .{ .replies = &.{.{ "claude --version", .{ .code = 2 } }} };
    try testing.expectEqualStrings("exit 2", (try discoverById(arena.allocator(), &silent, "claude")).err.?);
    var which_slow: Fake = .{ .replies = &.{
        .{ "claude --version", .{ .stdout = "1.0.0" } },
        .{ "which claude", .{ .times_out = true } },
    } };
    const late = try discoverById(arena.allocator(), &which_slow, "claude");
    try testing.expect(!late.installed);
    try testing.expectEqualStrings("timed out after 5000 ms", late.err.?);
}

test "agents: agents without a probe have unknown login state" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var fake: Fake = .{ .replies = &.{.{ "junie --version", .{ .stdout = "junie 1.2.3" } }} };
    const found = try discoverById(arena.allocator(), &fake, "junie");
    try testing.expect(found.installed and found.logged_in == null);
    // which is not answered: the path stays unknown.
    try testing.expect(found.path == null);
}

test "agents: gemini needs GEMINI_API_KEY before anything is run" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const table = try specs_mod.builtin(arena.allocator(), .{ .adapter_dir = "/a", .home = "/h" });
    var fake: Fake = .{ .replies = &.{.{ "gemini --version", .{ .stdout = "0.1.2" } }} };
    const found = try discoverOne(arena.allocator(), .{ .runner = fake.runner(), .gemini_key = false }, specs_mod.find(table, "gemini").?);
    try testing.expect(!found.installed);
    try testing.expectEqualStrings("GEMINI_API_KEY is not set", found.err.?);
    try testing.expectEqual(@as(usize, 0), fake.seen);
}

test "agents: the codex login probe runs against the real ~/.codex" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var fake: Fake = .{ .replies = &.{
        .{ "codex --version", .{ .stdout = "0.165.0" } },
        .{ "codex login status", .{ .stdout = "Logged in using ChatGPT" } },
    } };
    _ = try discoverById(arena.allocator(), &fake, "codex");
    for (fake.seen_keys[0..fake.seen], fake.seen_env[0..fake.seen]) |key, env| {
        if (std.mem.eql(u8, key, "codex login status")) try testing.expectEqualStrings("/h/.codex", env.?) else try testing.expect(env == null);
    }
}

test "agents: the version is the first x.y.z with its non-space tail" {
    try testing.expectEqualStrings("2.1.316", parseVersion("2.1.316 (Claude Code)").?);
    try testing.expectEqualStrings("0.164.0", parseVersion("codex-cli 0.164.0").?);
    try testing.expectEqualStrings("1.2.3-beta.4", parseVersion("v1.2.3-beta.4 x").?);
    try testing.expectEqualStrings("10.20.30.40", parseVersion("10.20.30.40").?);
    try testing.expectEqualStrings("3.4.5", parseVersion("1.2 then 3.4.5").?);
    try testing.expect(parseVersion("1.2") == null);
    try testing.expect(parseVersion("no digits") == null);
    try testing.expect(parseVersion("") == null);
}

test "agents: all specs are probed and the snapshot outlives the probes" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const table = try specs_mod.builtin(arena.allocator(), .{ .adapter_dir = "/a", .home = "/h" });
    var fake: Fake = .{ .replies = &.{
        .{ "claude --version", .{ .stdout = "2.1.316" } },
        .{ "which claude", .{ .stdout = "/bin/claude\n" } },
        .{ "claude auth status", .{ .stdout = "\"loggedIn\": true" } },
        .{ "agy --version", .{ .stdout = "agy 0.0.1" } },
        .{ "agy models", .{} },
    }, .record = false };
    var snapshot = try discoverAll(testing.allocator, testing.io, .{ .runner = fake.runner(), .gemini_key = false }, table, 42);
    defer snapshot.deinit();
    try testing.expectEqual(table.len, snapshot.items.len);
    for (table, snapshot.items) |spec, item| try testing.expectEqualStrings(spec.id, item.id);
    try testing.expect(snapshot.items[0].installed);
    try testing.expectEqual(@as(?bool, true), snapshot.items[0].logged_in);
    try testing.expectEqual(@as(?bool, true), snapshot.items[6].logged_in);
    try testing.expectEqualStrings("GEMINI_API_KEY is not set", snapshot.items[5].err.?);
    const copy = try snapshot.cloneInto(arena.allocator());
    try testing.expectEqualStrings("/bin/claude", copy[0].path.?);
}
