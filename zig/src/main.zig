const std = @import("std");

pub const Command = enum {
    serve,
    migrate,
    enroll,
    @"mcp-stdio",
    @"guard-eval",
};

const usage = "usage: harness <serve|migrate|enroll|mcp-stdio|guard-eval>\n";

pub fn main(init: std.process.Init) u8 {
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
        .serve, .migrate, .enroll, .@"mcp-stdio", .@"guard-eval" => notImplemented(command),
    };
}

fn notImplemented(command: Command) u8 {
    std.debug.print("not implemented: {s}\n", .{@tagName(command)});
    return 2;
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
    _ = @import("logs/zstd_c.zig");
    _ = @import("http/server.zig");
    _ = @import("realtime/hub.zig");
    _ = @import("auth/cbor.zig");
    _ = @import("orgs/repo.zig");
    _ = @import("board/repo.zig");
    _ = @import("chat/repo.zig");
    _ = @import("guard/lexer.zig");
    _ = @import("heartbeat/triggers.zig");
    _ = @import("laya/client.zig");
    _ = @import("mcp/server.zig");
    _ = @import("agents/specs.zig");
    _ = @import("runtimes/process.zig");
    _ = @import("usage/tail.zig");
}
