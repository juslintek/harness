//! What a container may mount or share with the host. Port of guard/rules-container.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

fn isEngine(n: []const u8) bool {
    return core.oneOf(n, &.{ "docker", "podman", "nerdctl", "docker-compose", "podman-compose" });
}

fn takesValue(a: []const u8) bool {
    return core.oneOf(a, &.{ "-H", "--host", "--context", "-c", "--config", "--connection", "-f", "--file", "-p" });
}

fn subcommand(cmd: *const Cmd) []const u8 {
    const args = if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv;
    var words: [2][]const u8 = undefined;
    var n: usize = 0;
    var i: usize = 0;
    while (i < args.len and n < 2) : (i += 1) {
        if (std.mem.startsWith(u8, args[i], "-")) {
            if (takesValue(args[i])) i += 1;
        } else {
            words[n] = args[i];
            n += 1;
        }
    }
    if (n == 0) return "";
    const wrapped = core.oneOf(words[0], &.{ "compose", "container" });
    return if (wrapped) (if (n > 1) words[1] else "") else words[0];
}

// TS: /^(?:-v|--volume=?)(.+)$/ where `.` refuses line terminators.
fn volumeValue(a: []const u8) ?[]const u8 {
    var rest: []const u8 = undefined;
    if (std.mem.startsWith(u8, a, "-v") and a.len > 2) {
        rest = a[2..];
    } else if (std.mem.startsWith(u8, a, "--volume")) {
        rest = a["--volume".len..];
        if (rest.len > 1 and rest[0] == '=') rest = rest[1..];
        if (rest.len == 0) return null;
    } else return null;
    return if (core.hasLineTerminator(rest)) null else rest;
}

// TS: /(?:source|src)=([^,]+)/, the leftmost occurrence that has a value.
fn mountSource(mount: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i < mount.len) : (i += 1) {
        for ([_][]const u8{ "source=", "src=" }) |key| {
            if (!std.mem.startsWith(u8, mount[i..], key)) continue;
            const v = mount[i + key.len ..];
            const end = std.mem.findScalar(u8, v, ',') orelse v.len;
            if (end > 0) return v[0..end];
        }
    }
    return null;
}

// TS: /^--mount=?(.*)$/.exec(a)?.[1] || (a === "--mount" ? args[i + 1] : undefined)
fn mountValue(args: []const []const u8, i: usize) ?[]const u8 {
    const a = args[i];
    if (std.mem.startsWith(u8, a, "--mount")) {
        var rest = a["--mount".len..];
        if (rest.len > 0 and rest[0] == '=') rest = rest[1..];
        if (rest.len > 0 and !core.hasLineTerminator(rest)) return rest;
    }
    if (std.mem.eql(u8, a, "--mount") and i + 1 < args.len) return args[i + 1];
    return null;
}

fn isHostPath(p: []const u8) bool {
    return p.len > 0 and std.mem.findScalar(u8, "/~$.", p[0]) != null;
}

fn mountSources(a: std.mem.Allocator, args: []const []const u8) Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(a);
    for (args, 0..) |arg, i| {
        const vol = volumeValue(arg) orelse if (core.oneOf(arg, &.{ "-v", "--volume" }) and i + 1 < args.len) args[i + 1] else null;
        if (vol) |v| if (v.len > 0) {
            try out.append(a, v[0 .. std.mem.findScalar(u8, v, ':') orelse v.len]);
        };
        if (mountValue(args, i)) |m| if (mountSource(m)) |src| try out.append(a, src);
    }
    var kept: usize = 0;
    for (out.items) |p| if (isHostPath(p)) {
        out.items[kept] = p;
        kept += 1;
    };
    out.shrinkRetainingCapacity(kept);
    return out.toOwnedSlice(a);
}

// TS: /^--privileged(=(true|1))?$/
fn isPrivileged(a: []const u8) bool {
    return std.mem.eql(u8, a, "--privileged") or std.mem.eql(u8, a, "--privileged=true") or std.mem.eql(u8, a, "--privileged=1");
}

fn dangerous(ctx: Ctx, cmd: *const Cmd) Error!?[]const u8 {
    const args = if (cmd.argv.len > 0) cmd.argv[1..] else cmd.argv;
    for (args) |a| if (std.mem.find(u8, a, "docker.sock") != null) return "the docker socket";
    for (args) |a| if (isPrivileged(a)) return "--privileged";
    for (args, 0..) |a, i| {
        if (std.mem.eql(u8, a, "--pid=host")) return "--pid=host";
        if (std.mem.eql(u8, a, "--pid") and i + 1 < args.len and std.mem.eql(u8, args[i + 1], "host")) return "--pid=host";
    }
    for (try mountSources(ctx.env.a, args)) |p| {
        const abs = (try core.resolvePath(ctx, p, null)) orelse continue;
        if (!core.isInside(ctx, abs)) return try core.fmt(ctx, "a bind mount of {s}", .{p});
    }
    return null;
}

/// The container daemon runs outside the sandbox, so what a container may touch is judged here.
pub fn container(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const engine = isEngine(core.name0(cmd));
    if (try dangerous(ctx, cmd)) |risky| {
        var sock = false;
        for (cmd.argv) |a| if (std.mem.find(u8, a, "docker.sock") != null) {
            sock = true;
        };
        if (engine or sock) {
            return core.deny("container.host-access", try core.fmt(ctx, "container access to {s} bypasses the sandbox", .{risky}), .shell);
        }
    }
    if (!engine) return null;
    return if (core.oneOf(subcommand(cmd), &.{ "run", "exec", "create", "up" }))
        core.ask("container.run", "containers run outside the sandbox", .shell)
    else
        null;
}
