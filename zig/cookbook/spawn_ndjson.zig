//! TS: Bun.spawn with piped stdout and `for await (const line of lines(stdout))`. Spawn in its own
//! process group (so a later signal reaches grandchildren) and read newline-delimited JSON.
const std = @import("std");

pub const Event = struct { n: i64 };

/// A child that is the leader of a new process group: `pgid = 0` makes the child call setpgid(0, 0).
pub fn spawnShell(io: std.Io, script: []const u8) !std.process.Child {
    return std.process.spawn(io, .{
        .argv = &.{ "/bin/sh", "-c", script },
        .stdin = .ignore,
        .stdout = .pipe,
        .stderr = .ignore,
        .pgid = 0,
    });
}

/// Reads NDJSON lines until EOF, summing `n`. The Reader's buffer is the maximum line length: a
/// longer line is skipped, not a hang, because takeDelimiter leaves the stream untouched on
/// error.StreamTooLong and the caller has to discard it. Blank and malformed lines are skipped.
pub fn sumEvents(gpa: std.mem.Allocator, io: std.Io, file: std.Io.File, max_line: usize) !struct { sum: i64, skipped: usize } {
    const buffer = try gpa.alloc(u8, max_line);
    defer gpa.free(buffer);
    var reader = file.reader(io, buffer);
    var sum: i64 = 0;
    var skipped: usize = 0;
    while (true) {
        const maybe_line = reader.interface.takeDelimiter('\n') catch |err| switch (err) {
            error.StreamTooLong => {
                _ = reader.interface.discardDelimiterInclusive('\n') catch |discard_err| switch (discard_err) {
                    error.EndOfStream => break,
                    error.ReadFailed => return error.ReadFailed,
                };
                skipped += 1;
                continue;
            },
            error.ReadFailed => return error.ReadFailed,
        };
        const line = maybe_line orelse break;
        if (line.len == 0) continue;
        const parsed = std.json.parseFromSlice(Event, gpa, line, .{ .ignore_unknown_fields = true }) catch {
            skipped += 1;
            continue;
        };
        defer parsed.deinit();
        sum += parsed.value.n;
    }
    return .{ .sum = sum, .skipped = skipped };
}

test "spawn_ndjson: read events from a child, then wait for its exit status" {
    const io = std.testing.io;
    var child = try spawnShell(io, "printf '{\"n\":1}\\n{\"n\":2}\\n\\nnot json\\n{\"n\":4,\"extra\":true}'");
    defer child.kill(io);

    const result = try sumEvents(std.testing.allocator, io, child.stdout.?, 256);
    try std.testing.expectEqual(@as(i64, 7), result.sum);
    try std.testing.expectEqual(@as(usize, 1), result.skipped);

    const term = try child.wait(io);
    try std.testing.expect(term.success());
}

test "spawn_ndjson: an oversized line is skipped and the next line still arrives" {
    const io = std.testing.io;
    var child = try spawnShell(io, "head -c 500 /dev/zero | tr '\\0' x; printf '\\n{\"n\":9}\\n'");
    defer child.kill(io);

    const result = try sumEvents(std.testing.allocator, io, child.stdout.?, 64);
    try std.testing.expectEqual(@as(i64, 9), result.sum);
    try std.testing.expectEqual(@as(usize, 1), result.skipped);
    _ = try child.wait(io);
}

test "spawn_ndjson: a non-zero exit is reported through Term" {
    const io = std.testing.io;
    var child = try spawnShell(io, "exit 3");
    defer child.kill(io);
    const term = try child.wait(io);
    try std.testing.expectEqual(@as(u8, 3), term.exited);
}

test "spawn_ndjson: the child leads its own process group" {
    const io = std.testing.io;
    var child = try spawnShell(io, "echo $$; ps -o pgid= -p $$");
    defer child.kill(io);
    var buffer: [128]u8 = undefined;
    var reader = child.stdout.?.reader(io, &buffer);
    const pid_line = (try reader.interface.takeDelimiter('\n')).?;
    const pid = try std.fmt.parseInt(i32, pid_line, 10);
    const pgid_line = std.mem.trim(u8, (try reader.interface.takeDelimiter('\n')).?, " ");
    try std.testing.expectEqual(pid, try std.fmt.parseInt(i32, pgid_line, 10));
    try std.testing.expectEqual(pid, child.id.?);
    _ = try child.wait(io);
}
