const std = @import("std");
const db_command = @import("db/command.zig");
const http_boot = @import("http/boot.zig");
const guard_eval = @import("guard/eval.zig");
const enroll = @import("auth/enroll.zig");
const mcp_server = @import("mcp/server.zig");

pub const Command = enum {
    serve,
    migrate,
    enroll,
    @"mcp-stdio",
    @"guard-eval",
};

const usage = "usage: harness <serve|migrate|enroll|mcp-stdio|guard-eval [--json]>\n";

/// Agents get HARNESS_RUN_TOKEN and run under srt (SANDBOX_RUNTIME=1). The only binary meant to run
/// there is harness-hook; a copy of this one must not serve, migrate or enroll from inside.
fn inAgentSandbox(env: *const std.process.Environ.Map) bool {
    return env.get("HARNESS_RUN_TOKEN") != null or env.get("SANDBOX_RUNTIME") != null;
}

pub fn main(init: std.process.Init) u8 {
    if (inAgentSandbox(init.environ_map)) {
        std.debug.print("harness: refusing to run inside an agent sandbox\n", .{});
        return 2;
    }
    const args = init.minimal.args.toSlice(init.arena.allocator()) catch return 1;
    if (args.len < 2) {
        std.debug.print(usage, .{});
        return 2;
    }
    const command = std.meta.stringToEnum(Command, args[1]) orelse {
        std.debug.print("unknown command: {s}\n{s}", .{ args[1], usage });
        return 2;
    };
    return switch (command) {
        .migrate => db_command.run(init),
        .serve => http_boot.serve(init),
        .@"guard-eval" => guard_eval.run(init),
        .enroll => enroll.run(init),
        .@"mcp-stdio" => mcp_server.runStdio(init),
    };
}

fn notImplemented(command: Command) u8 {
    std.debug.print("not implemented: {s}\n", .{@tagName(command)});
    return 2;
}

test "main: agent sandbox markers are detected" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try std.testing.expect(!inAgentSandbox(&env));
    try env.put("SANDBOX_RUNTIME", "1");
    try std.testing.expect(inAgentSandbox(&env));
    _ = env.swapRemove("SANDBOX_RUNTIME");
    try env.put("HARNESS_RUN_TOKEN", "t");
    try std.testing.expect(inAgentSandbox(&env));
}

test "main: subcommand names resolve" {
    try std.testing.expectEqual(Command.@"mcp-stdio", std.meta.stringToEnum(Command, "mcp-stdio").?);
    try std.testing.expectEqual(Command.serve, std.meta.stringToEnum(Command, "serve").?);
    try std.testing.expect(std.meta.stringToEnum(Command, "bogus") == null);
}

test {
    _ = @import("app.zig");
    _ = @import("config.zig");
    _ = @import("ids.zig");
    _ = @import("json.zig");
    _ = @import("parity.zig");
    _ = @import("errors.zig");
    _ = @import("events.zig");
    _ = @import("git.zig");
    _ = @import("db/c.zig");
    _ = @import("db/sqlite.zig");
    _ = @import("db/migrate.zig");
    _ = @import("db/lock.zig");
    _ = @import("db/command.zig");
    _ = @import("health.zig");
    _ = @import("logs/api.zig");
    _ = @import("http/server.zig");
    _ = @import("http/boot.zig");
    _ = @import("realtime/hub.zig");
    _ = @import("auth/cbor.zig");
    _ = @import("auth/sessions.zig");
    _ = @import("auth/middleware.zig");
    _ = @import("auth/codes.zig");
    _ = @import("auth/passkeys.zig");
    _ = @import("auth/body.zig");
    _ = @import("auth/enroll.zig");
    _ = @import("auth/routes.zig");
    _ = @import("orgs/repo.zig");
    _ = @import("board/repo.zig");
    _ = @import("chat/repo.zig");
    _ = @import("guard/lexer.zig");
    _ = @import("guard/l1.zig");
    _ = @import("guard/eval.zig");
    _ = @import("guard/approvals.zig");
    _ = @import("guard/l2.zig");
    _ = @import("guard/limits.zig");
    _ = @import("guard/routes.zig");
    _ = @import("guard/check.zig");
    _ = @import("heartbeat/triggers.zig");
    _ = @import("laya/client.zig");
    _ = @import("mcp/server.zig");
    _ = @import("agents/specs.zig");
    _ = @import("runtimes/process.zig");
    _ = @import("usage/tail.zig");
}
