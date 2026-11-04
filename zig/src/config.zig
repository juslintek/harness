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
    /// HARNESS_ORIGIN, validated: https, or http only for localhost. Null means http://localhost:<bound port>.
    origin: ?[]const u8,
    /// HARNESS_TRUST_PROXY: take the client address from X-Forwarded-For (only behind a proxy that sets it).
    trust_proxy: bool,

    pub fn deinit(config: Config, gpa: std.mem.Allocator) void {
        gpa.free(config.host);
        gpa.free(config.home);
        if (config.origin) |origin| gpa.free(origin);
    }
};

pub const Error = error{ InvalidPort, EmptyHost, EmptyHome, NoHomeDir, InvalidOrigin, InvalidTrustProxy, OutOfMemory };

pub fn load(gpa: std.mem.Allocator, env: *const std.process.Environ.Map) Error!Config {
    const port: u16 = if (env.get("HARNESS_PORT")) |raw|
        std.fmt.parseInt(u16, raw, 10) catch return error.InvalidPort
    else
        default_port;

    const host_raw = env.get("HARNESS_HOST") orelse default_host;
    if (host_raw.len == 0) return error.EmptyHost;

    const home_raw = env.get("HARNESS_HOME") orelse default_home;
    if (home_raw.len == 0) return error.EmptyHome;

    const trust_proxy = if (env.get("HARNESS_TRUST_PROXY")) |raw| try parseStringBool(raw) else false;

    const host = try gpa.dupe(u8, host_raw);
    errdefer gpa.free(host);
    const home = try expandHome(gpa, env, home_raw);
    errdefer gpa.free(home);
    const origin = if (env.get("HARNESS_ORIGIN")) |raw| try normalizeOrigin(gpa, raw) else null;
    errdefer if (origin) |o| gpa.free(o);
    return .{ .host = host, .port = port, .home = home, .origin = origin, .trust_proxy = trust_proxy };
}

/// Mirrors zod's stringbool defaults, which the TS config uses.
fn parseStringBool(raw: []const u8) Error!bool {
    var buf: [16]u8 = undefined;
    if (raw.len > buf.len) return error.InvalidTrustProxy;
    const lower = std.ascii.lowerString(&buf, raw);
    for ([_][]const u8{ "true", "1", "yes", "on", "y", "enabled" }) |word| if (std.mem.eql(u8, lower, word)) return true;
    for ([_][]const u8{ "false", "0", "no", "off", "n", "disabled" }) |word| if (std.mem.eql(u8, lower, word)) return false;
    return error.InvalidTrustProxy;
}

/// https anywhere, plain http only on localhost; cookies and passkeys ride on this origin. Returns
/// scheme://host[:port] with the path, query and default port dropped, like `new URL(raw).origin`.
fn normalizeOrigin(gpa: std.mem.Allocator, raw: []const u8) Error![]u8 {
    const uri = std.Uri.parse(raw) catch return error.InvalidOrigin;
    const host_component = uri.host orelse return error.InvalidOrigin;
    var host_buf: [256]u8 = undefined;
    const host_raw = host_component.toRaw(&host_buf) catch return error.InvalidOrigin;
    if (host_raw.len == 0) return error.InvalidOrigin;
    // IDN hosts must be given as punycode (what browsers send), and encoded delimiters are never a host.
    for (host_raw) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '.' and ch != '-') return error.InvalidOrigin;
    var lower_buf: [256]u8 = undefined;
    const host = std.ascii.lowerString(&lower_buf, host_raw);
    const https = std.ascii.eqlIgnoreCase(uri.scheme, "https");
    if (!https and !(std.ascii.eqlIgnoreCase(uri.scheme, "http") and std.mem.eql(u8, host, "localhost")))
        return error.InvalidOrigin;
    const scheme = if (https) "https" else "http";
    const scheme_port: u16 = if (https) 443 else 80;
    if (uri.port) |port| if (port != scheme_port)
        return std.fmt.allocPrint(gpa, "{s}://{s}:{d}", .{ scheme, host, port });
    return std.fmt.allocPrint(gpa, "{s}://{s}", .{ scheme, host });
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

test "config: origin and trust proxy" {
    var env = try testEnv(&.{
        .{ "HOME", "/h" },
        .{ "HARNESS_ORIGIN", "https://harness.example.com" },
        .{ "HARNESS_TRUST_PROXY", "yes" },
    });
    defer env.deinit();
    const config = try load(std.testing.allocator, &env);
    defer config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("https://harness.example.com", config.origin.?);
    try std.testing.expect(config.trust_proxy);

    var local = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "http://localhost:4100" } });
    defer local.deinit();
    const local_config = try load(std.testing.allocator, &local);
    defer local_config.deinit(std.testing.allocator);
    try std.testing.expect(!local_config.trust_proxy);
}

test "config: plain http is refused off localhost, bad booleans too" {
    var http_remote = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "http://example.com" } });
    defer http_remote.deinit();
    try std.testing.expectError(error.InvalidOrigin, load(std.testing.allocator, &http_remote));

    var not_url = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "example.com" } });
    defer not_url.deinit();
    try std.testing.expectError(error.InvalidOrigin, load(std.testing.allocator, &not_url));

    var bad_bool = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_TRUST_PROXY", "maybe" } });
    defer bad_bool.deinit();
    try std.testing.expectError(error.InvalidTrustProxy, load(std.testing.allocator, &bad_bool));
}

test "config: origin is reduced to scheme, host and non-default port" {
    var env = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "https://Harness.Example.com:443/x?y=1" } });
    defer env.deinit();
    const config = try load(std.testing.allocator, &env);
    defer config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("https://harness.example.com", config.origin.?);

    var local = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "http://localhost:4100/app" } });
    defer local.deinit();
    const local_config = try load(std.testing.allocator, &local);
    defer local_config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("http://localhost:4100", local_config.origin.?);
}

test "config: encoded and non-ASCII hosts are refused" {
    var idn = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "https://b%C3%BCcher.example" } });
    defer idn.deinit();
    try std.testing.expectError(error.InvalidOrigin, load(std.testing.allocator, &idn));

    var slash = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "https://example%2f.com" } });
    defer slash.deinit();
    try std.testing.expectError(error.InvalidOrigin, load(std.testing.allocator, &slash));

    var puny = try testEnv(&.{ .{ "HOME", "/h" }, .{ "HARNESS_ORIGIN", "https://xn--bcher-kva.example" } });
    defer puny.deinit();
    const config = try load(std.testing.allocator, &puny);
    defer config.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("https://xn--bcher-kva.example", config.origin.?);
}
