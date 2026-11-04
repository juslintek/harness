//! Agent specs as data: code/src/server/features/agents/specs.ts. The seven built-in entries (the
//! claude-agent-acp and codex-acp adapters first) and the test override read from
//! HARNESS_TEST_AGENTS, which is only honoured with HARNESS_TEST=1.
const std = @import("std");

pub const Lane = enum { acp, agy, api };

pub const EnvPair = struct { name: []const u8, value: []const u8 };

pub const LoggedInWhen = union(enum) {
    exit0,
    stdout_includes: []const u8,
};

pub const LoginProbe = struct {
    /// Full argv, read-only.
    args: []const []const u8,
    logged_in_when: LoggedInWhen,
    env: []const EnvPair = &.{},
};

pub const ModeOption = struct { config_id: []const u8, value: []const u8 };

pub const Spec = struct {
    id: []const u8,
    name: []const u8,
    lane: Lane,
    bin: []const u8,
    args: []const []const u8,
    /// Full argv of the installed CLI (not the adapter) that prints its version.
    version_args: []const []const u8,
    login_probe: ?LoginProbe,
    /// Full argv of the interactive login command, null when the CLI has none.
    login_args: ?[]const []const u8,
    mode_option: ?ModeOption,
    egress: []const []const u8,
    state_write: []const []const u8,
    /// Opens com.apple.trustd.agent in srt; needed by Go and Rust TLS clients (codex, agy).
    weaker_network_isolation: bool,
    claude_meta: bool,
};

/// Where the adapters live (`adapterBin` in specs.ts: `<code>/node_modules/.bin`) and the user's
/// home (`homedir()`, for the Codex probe).
pub const Paths = struct {
    adapter_dir: []const u8,
    home: []const u8,
};

/// The built-in table. Strings that do not depend on the environment are static; the adapter
/// paths and CODEX_HOME are joined into `arena`.
pub fn builtin(arena: std.mem.Allocator, paths: Paths) std.mem.Allocator.Error![]const Spec {
    const claude_bin = try std.fs.path.join(arena, &.{ paths.adapter_dir, "claude-agent-acp" });
    const codex_bin = try std.fs.path.join(arena, &.{ paths.adapter_dir, "codex-acp" });
    // Runs get a private CODEX_HOME that only symlinks ~/.codex/auth.json, so the login that
    // matters is the one in ~/.codex, even if the server was started with another CODEX_HOME.
    const codex_env = try arena.dupe(EnvPair, &.{.{
        .name = "CODEX_HOME",
        .value = try std.fs.path.join(arena, &.{ paths.home, ".codex" }),
    }});
    return arena.dupe(Spec, &.{
        .{
            .id = "claude",
            .name = "Claude Code",
            .lane = .acp,
            .bin = claude_bin,
            .args = &.{},
            .version_args = &.{ "claude", "--version" },
            .login_probe = .{
                .args = &.{ "claude", "auth", "status" },
                .logged_in_when = .{ .stdout_includes = "\"loggedIn\": true" },
            },
            .login_args = &.{ "claude", "auth", "login" },
            .mode_option = .{ .config_id = "mode", .value = "default" },
            .egress = &.{"api.anthropic.com"},
            .state_write = &.{ "~/.claude", "/private/tmp/claude-<uid>", "/private/tmp/claude-*-cwd" },
            .weaker_network_isolation = false,
            .claude_meta = true,
        },
        .{
            .id = "codex",
            .name = "Codex",
            .lane = .acp,
            .bin = codex_bin,
            .args = &.{},
            .version_args = &.{ "codex", "--version" },
            .login_probe = .{
                .args = &.{ "codex", "login", "status" },
                .logged_in_when = .{ .stdout_includes = "Logged in using ChatGPT" },
                .env = codex_env,
            },
            .login_args = &.{ "codex", "login" },
            .mode_option = .{ .config_id = "mode", .value = "workspace-write" },
            .egress = &.{"chatgpt.com"},
            .state_write = &.{},
            .weaker_network_isolation = true,
            .claude_meta = false,
        },
        .{
            .id = "junie",
            .name = "Junie",
            .lane = .acp,
            .bin = "junie",
            .args = &.{"--acp=true"},
            .version_args = &.{ "junie", "--version" },
            .login_probe = null,
            .login_args = null,
            .mode_option = null,
            .egress = &.{ "junie.jetbrains.com", "api.jetbrains.ai" },
            .state_write = &.{"~/.junie"},
            .weaker_network_isolation = false,
            .claude_meta = false,
        },
        .{
            .id = "copilot",
            .name = "GitHub Copilot",
            .lane = .acp,
            .bin = "copilot",
            .args = &.{ "--acp", "--stdio" },
            .version_args = &.{ "copilot", "--version" },
            .login_probe = null,
            .login_args = &.{ "copilot", "login" },
            .mode_option = null,
            .egress = &.{ "api.github.com", "api.githubcopilot.com", "github.com" },
            .state_write = &.{"~/.copilot"},
            .weaker_network_isolation = false,
            .claude_meta = false,
        },
        .{
            .id = "cursor",
            .name = "Cursor",
            .lane = .acp,
            .bin = "agent",
            .args = &.{"acp"},
            .version_args = &.{ "agent", "--version" },
            .login_probe = null,
            .login_args = &.{ "agent", "login" },
            .mode_option = null,
            .egress = &.{ "api2.cursor.sh", "cursor.com" },
            .state_write = &.{"~/.cursor"},
            .weaker_network_isolation = false,
            .claude_meta = false,
        },
        .{
            .id = "gemini",
            .name = "Gemini CLI",
            .lane = .acp,
            .bin = "gemini",
            .args = &.{"--acp"},
            .version_args = &.{ "gemini", "--version" },
            .login_probe = null,
            .login_args = null,
            .mode_option = null,
            .egress = &.{"generativelanguage.googleapis.com"},
            .state_write = &.{"~/.gemini"},
            .weaker_network_isolation = false,
            .claude_meta = false,
        },
        .{
            .id = "agy",
            .name = "Antigravity",
            .lane = .agy,
            .bin = "agy",
            .args = &.{},
            .version_args = &.{ "agy", "--version" },
            .login_probe = .{ .args = &.{ "agy", "models" }, .logged_in_when = .exit0 },
            .login_args = null,
            .mode_option = null,
            .egress = &.{ "daily-cloudcode-pa.googleapis.com", "www.googleapis.com" },
            .state_write = &.{"~/.gemini"},
            .weaker_network_isolation = true,
            .claude_meta = false,
        },
    });
}

pub const LoadError = error{ InvalidAgentSpecs, OutOfMemory };

/// What the zod `specSchema` accepts, field names as in the JSON. Unknown keys are ignored, as
/// zod's object does; every field except `loginProbe.env` must be present.
const Raw = struct {
    id: []const u8,
    name: []const u8,
    lane: Lane,
    bin: []const u8,
    args: []const []const u8,
    versionArgs: []const []const u8,
    loginProbe: ?struct {
        args: []const []const u8,
        loggedInWhen: std.json.Value,
        env: ?std.json.ArrayHashMap([]const u8) = null,
    },
    loginArgs: ?[]const []const u8,
    modeOption: ?struct { configId: []const u8, value: []const u8 },
    egress: []const []const u8,
    stateWrite: []const []const u8,
    weakerNetworkIsolation: bool,
    claudeMeta: bool,
};

fn loggedInWhen(value: std.json.Value) ?LoggedInWhen {
    switch (value) {
        .string => |text| return if (std.mem.eql(u8, text, "exit0")) .exit0 else null,
        .object => |object| {
            const needle = object.get("stdoutIncludes") orelse return null;
            return switch (needle) {
                .string => |text| .{ .stdout_includes = text },
                else => null,
            };
        },
        else => return null,
    }
}

/// `loadAgentSpecs`: the built-in table, or the HARNESS_TEST_AGENTS override when HARNESS_TEST is
/// exactly "1". A bad override fails (TS throws at import and the server never starts).
pub fn load(arena: std.mem.Allocator, env: *const std.process.Environ.Map, defaults: []const Spec) LoadError![]const Spec {
    const test_mode = if (env.get("HARNESS_TEST")) |value| std.mem.eql(u8, value, "1") else false;
    if (!test_mode) return defaults;
    const override = env.get("HARNESS_TEST_AGENTS") orelse return defaults;
    if (override.len == 0) return defaults;
    return parseOverride(arena, override);
}

pub fn parseOverride(arena: std.mem.Allocator, text: []const u8) LoadError![]const Spec {
    const options: std.json.ParseOptions = .{ .duplicate_field_behavior = .use_last, .ignore_unknown_fields = true };
    const raws = std.json.parseFromSliceLeaky([]const Raw, arena, text, options) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidAgentSpecs,
    };
    const specs = try arena.alloc(Spec, raws.len);
    for (raws, specs) |raw, *spec| {
        if (raw.id.len == 0 or raw.bin.len == 0) return error.InvalidAgentSpecs;
        var probe: ?LoginProbe = null;
        if (raw.loginProbe) |raw_probe| {
            var env_pairs: []EnvPair = &.{};
            if (raw_probe.env) |map| {
                env_pairs = try arena.alloc(EnvPair, map.map.count());
                for (map.map.keys(), map.map.values(), env_pairs) |key, value, *pair| pair.* = .{ .name = key, .value = value };
            }
            probe = .{
                .args = raw_probe.args,
                .logged_in_when = loggedInWhen(raw_probe.loggedInWhen) orelse return error.InvalidAgentSpecs,
                .env = env_pairs,
            };
        }
        spec.* = .{
            .id = raw.id,
            .name = raw.name,
            .lane = raw.lane,
            .bin = raw.bin,
            .args = raw.args,
            .version_args = raw.versionArgs,
            .login_probe = probe,
            .login_args = raw.loginArgs,
            .mode_option = if (raw.modeOption) |mode| .{ .config_id = mode.configId, .value = mode.value } else null,
            .egress = raw.egress,
            .state_write = raw.stateWrite,
            .weaker_network_isolation = raw.weakerNetworkIsolation,
            .claude_meta = raw.claudeMeta,
        };
    }
    return specs;
}

pub fn find(specs: []const Spec, id: []const u8) ?*const Spec {
    for (specs) |*spec| if (std.mem.eql(u8, spec.id, id)) return spec;
    return null;
}

test {
    _ = @import("runner.zig");
    _ = @import("discover.zig");
    _ = @import("keys.zig");
    _ = @import("models.zig");
    _ = @import("ollaya.zig");
    _ = @import("routes.zig");
}

const testing = std.testing;

fn testBuiltin(arena: std.mem.Allocator) ![]const Spec {
    return builtin(arena, .{ .adapter_dir = "/repo/code/node_modules/.bin", .home = "/home/alice" });
}

test "agents: the built-in table has the ids, lanes and adapter bins of specs.ts" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const specs = try testBuiltin(arena.allocator());
    const ids = [_][]const u8{ "claude", "codex", "junie", "copilot", "cursor", "gemini", "agy" };
    try testing.expectEqual(ids.len, specs.len);
    for (ids, specs) |id, spec| try testing.expectEqualStrings(id, spec.id);
    try testing.expectEqualStrings("/repo/code/node_modules/.bin/claude-agent-acp", find(specs, "claude").?.bin);
    try testing.expectEqualStrings("/repo/code/node_modules/.bin/codex-acp", find(specs, "codex").?.bin);
    try testing.expectEqual(Lane.agy, find(specs, "agy").?.lane);
    try testing.expect(find(specs, "claude").?.claude_meta);
    try testing.expect(find(specs, "nope") == null);
    const codex = find(specs, "codex").?;
    try testing.expectEqualStrings("/home/alice/.codex", codex.login_probe.?.env[0].value);
    try testing.expectEqualStrings("Logged in using ChatGPT", codex.login_probe.?.logged_in_when.stdout_includes);
    try testing.expect(codex.weaker_network_isolation);
    try testing.expect(find(specs, "junie").?.login_args == null);
    try testing.expect(find(specs, "agy").?.login_probe.?.logged_in_when == .exit0);
}

test "agents: the override is read only with HARNESS_TEST=1" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const defaults = try testBuiltin(arena.allocator());
    const override =
        \\[{"id":"fake","name":"Fake","lane":"acp","bin":"/x","args":["a"],"versionArgs":["fake","-v"],
        \\"loginProbe":{"args":["fake","who"],"loggedInWhen":{"stdoutIncludes":"yes"},"env":{"K":"V"}},
        \\"loginArgs":null,"modeOption":{"configId":"mode","value":"m"},"egress":[],"stateWrite":[],
        \\"weakerNetworkIsolation":false,"claudeMeta":false,"extra":1}]
    ;
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("HARNESS_TEST_AGENTS", override);
    try testing.expectEqual(defaults.len, (try load(arena.allocator(), &env, defaults)).len);
    try env.put("HARNESS_TEST", "true");
    try testing.expectEqual(defaults.len, (try load(arena.allocator(), &env, defaults)).len);
    try env.put("HARNESS_TEST", "1");
    const loaded = try load(arena.allocator(), &env, defaults);
    try testing.expectEqual(@as(usize, 1), loaded.len);
    try testing.expectEqualStrings("fake", loaded[0].id);
    try testing.expectEqualStrings("yes", loaded[0].login_probe.?.logged_in_when.stdout_includes);
    try testing.expectEqualStrings("K", loaded[0].login_probe.?.env[0].name);
    try testing.expectEqualStrings("m", loaded[0].mode_option.?.value);
    try env.put("HARNESS_TEST_AGENTS", "");
    try testing.expectEqual(defaults.len, (try load(arena.allocator(), &env, defaults)).len);
}

test "agents: a bad override is refused" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectError(error.InvalidAgentSpecs, parseOverride(a, "not json"));
    try testing.expectError(error.InvalidAgentSpecs, parseOverride(a, "{}"));
    try testing.expectError(error.InvalidAgentSpecs, parseOverride(a, "[{\"id\":\"x\"}]"));
    const bad_lane =
        \\[{"id":"x","name":"X","lane":"zzz","bin":"/x","args":[],"versionArgs":[],"loginProbe":null,
        \\"loginArgs":null,"modeOption":null,"egress":[],"stateWrite":[],"weakerNetworkIsolation":false,"claudeMeta":false}]
    ;
    try testing.expectError(error.InvalidAgentSpecs, parseOverride(a, bad_lane));
    const empty_bin =
        \\[{"id":"x","name":"X","lane":"acp","bin":"","args":[],"versionArgs":[],"loginProbe":null,
        \\"loginArgs":null,"modeOption":null,"egress":[],"stateWrite":[],"weakerNetworkIsolation":false,"claudeMeta":false}]
    ;
    try testing.expectError(error.InvalidAgentSpecs, parseOverride(a, empty_bin));
    const bad_rule =
        \\[{"id":"x","name":"X","lane":"acp","bin":"/x","args":[],"versionArgs":[],
        \\"loginProbe":{"args":[],"loggedInWhen":"never"},"loginArgs":null,"modeOption":null,"egress":[],
        \\"stateWrite":[],"weakerNetworkIsolation":false,"claudeMeta":false}]
    ;
    try testing.expectError(error.InvalidAgentSpecs, parseOverride(a, bad_rule));
}
