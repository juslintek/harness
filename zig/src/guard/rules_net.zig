//! Fetchers, raw sockets, uploads and running what was downloaded. Port of guard/rules-net.ts.
const std = @import("std");
const core = @import("rules_core.zig");
const exec = @import("rules_exec.zig");
const secret = @import("rules_secret.zig");
const Cmd = core.Cmd;
const Ctx = core.Ctx;
const Result = core.Result;
const Error = core.Error;

pub const Fetched = std.StringHashMapUnmanaged(void);

fn isFetcher(n: []const u8) bool {
    return core.oneOf(n, &.{ "curl", "wget", "fetch", "http", "https", "xh", "aria2c" });
}

fn isUploadFlag(a: []const u8) bool {
    return core.oneOf(a, &.{ "-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form", "--json" });
}

// TS: /(^|=)@/ — an `@` at the start or right after any `=`.
fn atFileValue(s: []const u8) bool {
    if (std.mem.startsWith(u8, s, "@")) return true;
    return std.mem.find(u8, s, "=@") != null;
}

// TS: /^--(upload-file|post-file|body-file)(=|$)/
fn isUploadLong(a: []const u8) bool {
    inline for (.{ "--upload-file", "--post-file", "--body-file" }) |f| {
        if (std.mem.startsWith(u8, a, f) and (a.len == f.len or a[f.len] == '=')) return true;
    }
    return false;
}

// TS: /^(-d|--data[a-z-]*|-F|--form|--json)=?@/
fn isInlineAtFile(a: []const u8) bool {
    var rest: []const u8 = undefined;
    if (std.mem.startsWith(u8, a, "--data")) {
        var n: usize = "--data".len;
        while (n < a.len and (std.ascii.isLower(a[n]) or a[n] == '-')) n += 1;
        rest = a[n..];
    } else inline for (.{ "-d", "-F", "--form", "--json" }) |f| {
        if (std.mem.startsWith(u8, a, f)) {
            rest = a[f.len..];
            break;
        }
    } else return false;
    if (std.mem.startsWith(u8, rest, "=@") or std.mem.startsWith(u8, rest, "@")) return true;
    return false;
}

fn uploadsFile(args: []const []const u8) bool {
    for (args, 0..) |a, i| {
        if (std.mem.eql(u8, a, "-T") or isUploadLong(a)) return true;
        if (isInlineAtFile(a)) return true;
        if (isUploadFlag(a) and atFileValue(if (i + 1 < args.len) args[i + 1] else "")) return true;
    }
    return false;
}

pub fn network(cmd: *const Cmd, ctx: Ctx) Error!?Result {
    const name = core.name0(cmd);
    if (cmd.download_exec) return core.deny("net.fetch-exec", "downloaded code is executed", .network);
    if (core.oneOf(name, &.{ "nc", "ncat", "netcat", "socat" })) {
        var leaks = false;
        for (cmd.argv) |w| if (try secret.isSecretPath(ctx, w)) {
            leaks = true;
        };
        for (cmd.redirects) |r| if (try secret.isSecretPath(ctx, r.path)) {
            leaks = true;
        };
        if (leaks) return core.deny("net.exfil-secret", "sends a credential file over a raw socket", .network);
        return core.ask("net.raw-socket", "raw sockets can exfiltrate data", .network);
    }
    if (core.oneOf(name, &.{ "ssh", "sftp" })) {
        return core.ask("net.ssh", "a remote shell runs commands the guard cannot see", .network);
    }
    if (!isFetcher(name)) return null;
    if (cmd.piped) for (cmd.after) |c| if (exec.isRunner(core.name0(c))) {
        return core.deny("net.pipe-to-shell", "downloaded content is piped into an interpreter", .network);
    };
    for (cmd.argv) |w| if (try secret.isSecretPath(ctx, w)) {
        return core.deny("net.exfil-secret", "sends a credential file over the network", .network);
    };
    return if (uploadsFile(cmd.argv[1..])) core.ask("net.upload", "uploads a local file", .network) else null;
}

// TS: /^[^-].*\/[^/]+$/ — `.` refuses line terminators, so the text before the last slash must have none.
fn looksLikeUrlPath(a: []const u8) bool {
    if (a.len < 3 or a[0] == '-') return false;
    const slash = std.mem.findScalarLast(u8, a, '/') orelse return false;
    if (slash < 1 or slash + 1 >= a.len) return false;
    return !core.hasLineTerminator(a[1..slash]);
}

fn isOutputFlag(a: []const u8) bool {
    return core.oneOf(a, &.{ "-o", "--output", "-O", "--output-document" });
}

/// Files a fetcher saves are remembered so a later `sh a.sh` or `./a.sh` is judged as run-what-you-downloaded.
pub fn recordFetch(cmd: *const Cmd, ctx: Ctx, fetched: *Fetched) Error!void {
    if (!isFetcher(core.name0(cmd))) return;
    var outputs: std.ArrayList([]const u8) = .empty;
    for (cmd.redirects) |r| if (r.op == .out) try outputs.append(ctx.env.a, r.path);
    if (core.contains(cmd.argv, "-O")) {
        for (cmd.argv) |a| if (looksLikeUrlPath(a)) try outputs.append(ctx.env.a, core.basename(a));
    }
    for (cmd.argv, 0..) |a, i| {
        if (isOutputFlag(a) and i + 1 < cmd.argv.len and cmd.argv[i + 1].len > 0) try outputs.append(ctx.env.a, cmd.argv[i + 1]);
    }
    for (outputs.items) |o| {
        if (try core.resolvePath(ctx, o, null)) |abs| try fetched.put(ctx.env.a, abs, {});
    }
}

fn hits(ctx: Ctx, fetched: *const Fetched, w: ?[]const u8) Error!bool {
    const word = w orelse return false;
    if (word.len == 0) return false;
    const abs = (try core.resolvePath(ctx, word, null)) orelse return false;
    return fetched.contains(abs);
}

pub fn runsFetched(cmd: *const Cmd, ctx: Ctx, fetched: *const Fetched) Error!?Result {
    if (fetched.count() == 0) return null;
    const first = core.name0(cmd);
    const runs = exec.isRunner(first) or core.oneOf(first, &.{ "source", "." });
    var hit = try hits(ctx, fetched, core.argv0(cmd));
    if (!hit and runs and cmd.argv.len > 1) {
        for (cmd.argv[1..]) |a| if (try hits(ctx, fetched, a)) {
            hit = true;
            break;
        };
    }
    if (!hit) return null;
    return core.deny("net.fetch-exec", "runs a file downloaded earlier in this command line", .network);
}
