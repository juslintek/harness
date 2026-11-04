//! harness-hook: the small binary an agent can run inside the sandbox. It links guard L1 and a
//! minimal HTTP POST only, never the server. `harness-hook claude-pretooluse` reads the hook JSON on
//! stdin, decides with L1, reports to the server and exits 2 on a deny or on any error.
const std = @import("std");
const hook = @import("guard/hook.zig");

const usage = "usage: harness-hook claude-pretooluse\n";

/// Anything that goes wrong before a decision exists is a deny.
const fail_closed = 2;

/// Claude lets the tool call through on any exit code but 2, and a safety-check panic would end
/// the process with SIGABRT, so a panic exits 2 as well.
pub const panic = std.debug.FullPanic(denyOnPanic);

fn denyOnPanic(msg: []const u8, first_trace_addr: ?usize) noreturn {
    _ = first_trace_addr;
    std.debug.print("harness guard: internal error: {s}\n", .{msg});
    std.process.exit(fail_closed);
}

pub fn main(init: std.process.Init) u8 {
    const args = init.minimal.args.toSlice(init.arena.allocator()) catch return fail_closed;
    if (args.len != 2 or !std.mem.eql(u8, args[1], "claude-pretooluse")) {
        std.Io.File.stderr().writeStreamingAll(init.io, usage) catch {};
        return fail_closed;
    }
    return run(init.gpa, init.io, init.environ_map);
}

fn run(gpa: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map) u8 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var read_buffer: [4096]u8 = undefined;
    var stdin = std.Io.File.stdin().readerStreaming(io, &read_buffer);
    const bytes = stdin.interface.allocRemaining(a, .limited(hook.max_input_bytes)) catch {
        std.Io.File.stderr().writeStreamingAll(io, "harness guard: cannot read the hook input\n") catch {};
        return fail_closed;
    };
    return finish(a, gpa, io, env, bytes);
}

/// Decides, reports and writes the answer; the exit code is the only thing Claude acts on.
pub fn finish(a: std.mem.Allocator, gpa: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, stdin: []const u8) u8 {
    const decision = hook.decide(a, gpa, io, env, stdin);
    if (decision.report) |r| hook.sendReport(a, io, env, r);
    if (decision.stdout.len > 0) std.Io.File.stdout().writeStreamingAll(io, decision.stdout) catch return fail_closed;
    if (decision.stderr.len > 0) std.Io.File.stderr().writeStreamingAll(io, decision.stderr) catch {};
    return decision.exit;
}

test {
    _ = @import("guard/hook.zig");
}
