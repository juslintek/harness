//! Environment configuration. Same variables and defaults as code/src/server/config.ts.
const std = @import("std");

pub const default_host = "127.0.0.1";
pub const default_port: u16 = 4100;
pub const default_home = "~/.harness";

pub const Config = struct {
    host: []const u8,
    /// 0 asks the OS for a free port; the server prints the one it got.
    port: u16,
    home: []const u8,

    pub fn deinit(config: Config, gpa: std.mem.Allocator) void {
        gpa.free(config.host);
        gpa.free(config.home);
    }
};

pub const Error = error{ InvalidPort, EmptyHost, EmptyHome, NoHomeDir, OutOfMemory };

pub fn load(gpa: std.mem.Allocator, env: *const std.process.Environ.Map) Error!Config {
    const port: u16 = if (env.get("HARNESS_PORT")) |raw|
        std.fmt.parseInt(u16, raw, 10) catch return error.InvalidPort
    else
        default_port;

    const host_raw = env.get("HARNESS_HOST") orelse default_host;
    if (host_raw.len == 0) return error.EmptyHost;

    const home_raw = env.get("HARNESS_HOME") orelse default_home;
    if (home_raw.len == 0) return error.EmptyHome;

    const host = try gpa.dupe(u8, host_raw);
    errdefer gpa.free(host);
    const home = try expandHome(gpa, env, home_raw);
    return .{ .host = host, .port = port, .home = home };
}

fn expandHome(gpa: std.mem.Allocator, env: *const std.process.Environ.Map, path: []const u8) Error![]u8 {
    const rest = if (std.mem.eql(u8, path, "~"))
        ""
    else if (std.mem.startsWith(u8, path, "~/"))
        path[1..]
    else
        return gpa.dupe(u8, path);
    const user_home = env.get("HOME") orelse return error.NoHomeDir;
    return std.mem.concat(gpa, u8, &.{ user_home, rest });
}

fn testEnv(pairs: []const [2][]const u8) !std.process.Environ.Map {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    errdefer env.deinit();
    for (pairs) |pair| try env.put(pair[0], pair[1]);
    return env;
}

test "config: defaults" {
    var env = try testEnv(&.{.{ "HOME", "/home/alice" }});
    defer env.deinit();
    const config = try load(std.testing.allocator, &env);
    defer config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("127.0.0.1", config.host);
    try std.testing.expectEqual(@as(u16, 4100), config.port);
    try std.testing.expectEqualStrings("/home/alice/.harness", config.home);
}

test "config: overrides, port 0 and absolute home" {
    var env = try testEnv(&.{
        .{ "HARNESS_HOST", "0.0.0.0" },
        .{ "HARNESS_PORT", "0" },
        .{ "HARNESS_HOME", "/srv/harness" },
    });
    defer env.deinit();
    const config = try load(std.testing.allocator, &env);
    defer config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("0.0.0.0", config.host);
    try std.testing.expectEqual(@as(u16, 0), config.port);
    try std.testing.expectEqualStrings("/srv/harness", config.home);
}

test "config: bare tilde is the user home" {
    var env = try testEnv(&.{ .{ "HARNESS_HOME", "~" }, .{ "HOME", "/home/alice" } });
    defer env.deinit();
    const config = try load(std.testing.allocator, &env);
    defer config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("/home/alice", config.home);
}

test "config: invalid values are rejected" {
    var bad_port = try testEnv(&.{ .{ "HARNESS_PORT", "70000" }, .{ "HOME", "/h" } });
    defer bad_port.deinit();
    try std.testing.expectError(error.InvalidPort, load(std.testing.allocator, &bad_port));

    var text_port = try testEnv(&.{ .{ "HARNESS_PORT", "http" }, .{ "HOME", "/h" } });
    defer text_port.deinit();
    try std.testing.expectError(error.InvalidPort, load(std.testing.allocator, &text_port));

    var empty_host = try testEnv(&.{ .{ "HARNESS_HOST", "" }, .{ "HOME", "/h" } });
    defer empty_host.deinit();
    try std.testing.expectError(error.EmptyHost, load(std.testing.allocator, &empty_host));

    var no_home = try testEnv(&.{});
    defer no_home.deinit();
    try std.testing.expectError(error.NoHomeDir, load(std.testing.allocator, &no_home));
}
