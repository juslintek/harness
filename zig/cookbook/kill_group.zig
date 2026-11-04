//! TS: process.kill(-pid, "SIGTERM"), then SIGKILL after a grace period. The child was spawned with
//! `.pgid = 0` (see spawn_ndjson.zig), so a negative pid reaches the shell and every grandchild.
const std = @import("std");
const spawn = @import("spawn_ndjson.zig");

const Event = union(enum) {
    exited: std.process.Child.WaitError!std.process.Child.Term,
    grace_over: std.Io.Cancelable!void,
};

fn waitChild(io: std.Io, child: *std.process.Child) std.process.Child.WaitError!std.process.Child.Term {
    return child.wait(io);
}

fn grace(io: std.Io, ms: i64) std.Io.Cancelable!void {
    return io.sleep(.fromMilliseconds(ms), .awake);
}

fn signalGroup(pgid: std.posix.pid_t, sig: std.posix.SIG) void {
    std.posix.kill(-pgid, sig) catch |err| switch (err) {
        // The group is already gone, which is the goal.
        error.ProcessNotFound => {},
        else => std.debug.print("kill({d}, {t}) failed: {t}\n", .{ -pgid, sig, err }),
    };
}

fn processExists(pid: std.posix.pid_t) bool {
    std.posix.kill(pid, @fromBackingInt(0)) catch |err| return err != error.ProcessNotFound;
    return true;
}

const poll_ms = 10;

/// SIGTERM to the group, then SIGKILL if the group is still alive after `grace_ms`. The leader
/// exiting is not the end: a grandchild may ignore SIGTERM, so once the leader is reaped the group
/// is probed with signal 0 (ESRCH means empty) for up to `grace_ms` more before the SIGKILL.
/// Returns how the leader ended. Consumes the child: it is waited on exactly once.
pub fn terminateGroup(io: std.Io, child: *std.process.Child, grace_ms: i64) !std.process.Child.Term {
    const pgid = child.id.?;
    var buffer: [2]Event = undefined;
    var select: std.Io.Select(Event) = .init(io, &buffer);
    defer select.cancelDiscard();
    try select.concurrent(.exited, waitChild, .{ io, child });
    try select.concurrent(.grace_over, grace, .{ io, grace_ms });

    signalGroup(pgid, .TERM);
    var killed = false;
    const term = while (true) switch (try select.await()) {
        .exited => |result| break try result,
        .grace_over => {
            signalGroup(pgid, .KILL);
            killed = true;
        },
    };
    if (killed) return term;

    var waited: i64 = 0;
    while (processExists(-pgid)) : (waited += poll_ms) {
        if (waited >= grace_ms) {
            signalGroup(pgid, .KILL);
            break;
        }
        try io.sleep(.fromMilliseconds(poll_ms), .awake);
    }
    return term;
}

test "kill_group: SIGTERM ends a cooperative child and its grandchild" {
    const io = std.testing.io;
    var child = try spawn.spawnShell(io, "sleep 30 & echo $!; wait");
    defer child.kill(io);

    var buffer: [64]u8 = undefined;
    var reader = child.stdout.?.reader(io, &buffer);
    const grandchild = try std.fmt.parseInt(std.posix.pid_t, (try reader.interface.takeDelimiter('\n')).?, 10);
    try std.testing.expect(processExists(grandchild));

    const term = try terminateGroup(io, &child, 2000);
    try std.testing.expectEqual(std.posix.SIG.TERM, term.signal);
    for (0..100) |_| {
        if (!processExists(grandchild)) break;
        try io.sleep(.fromMilliseconds(10), .awake);
    } else return error.GrandchildSurvived;
}

test "kill_group: a child that ignores SIGTERM is killed after the grace period" {
    const io = std.testing.io;
    var child = try spawn.spawnShell(io, "trap '' TERM; echo ready; while :; do sleep 1; done");
    defer child.kill(io);

    var buffer: [64]u8 = undefined;
    var reader = child.stdout.?.reader(io, &buffer);
    _ = try reader.interface.takeDelimiter('\n');

    const term = try terminateGroup(io, &child, 100);
    try std.testing.expectEqual(std.posix.SIG.KILL, term.signal);
}

test "kill_group: a grandchild that ignores SIGTERM outlives the leader and still gets SIGKILL" {
    const io = std.testing.io;
    var child = try spawn.spawnShell(io, "sh -c 'trap \"\" TERM; exec sleep 30' & echo $!; wait");
    defer child.kill(io);

    var buffer: [64]u8 = undefined;
    var reader = child.stdout.?.reader(io, &buffer);
    const grandchild = try std.fmt.parseInt(std.posix.pid_t, (try reader.interface.takeDelimiter('\n')).?, 10);
    const pgid = child.id.?;
    try io.sleep(.fromMilliseconds(100), .awake);
    try std.testing.expect(processExists(grandchild));

    const term = try terminateGroup(io, &child, 300);
    try std.testing.expectEqual(std.posix.SIG.TERM, term.signal);
    for (0..100) |_| {
        if (!processExists(-pgid) and !processExists(grandchild)) break;
        try io.sleep(.fromMilliseconds(10), .awake);
    } else return error.GroupSurvived;
}
