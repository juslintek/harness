//! NDJSON line reading with a size cap. TS: the `for await` split on "\n" in readStdout of
//! code/src/server/features/runtimes/acp-rpc.ts, which has no cap; plan 5.1 requires one and says
//! an oversized line fails the run, not the server: `next` returns error.LineTooLong and the
//! reader is not used after it.
const std = @import("std");

pub const default_max_line = 32 * 1024 * 1024;

pub const LineReader = struct {
    reader: *std.Io.Reader,
    max_line: usize,
    skipped: usize = 0,
    scratch: std.Io.Writer.Allocating,

    pub fn init(gpa: std.mem.Allocator, reader: *std.Io.Reader, max_line: usize) LineReader {
        return .{ .reader = reader, .max_line = max_line, .scratch = .init(gpa) };
    }

    pub fn deinit(lr: *LineReader) void {
        lr.scratch.deinit();
    }

    /// The next non-blank line without its newline, valid until the next call; null at end of
    /// stream. A line longer than `max_line` is counted and fails with error.LineTooLong, leaving
    /// the stream untouched. An unterminated last line is counted as skipped: like the TS reader,
    /// text after the last newline is never delivered.
    pub fn next(lr: *LineReader) error{ ReadFailed, OutOfMemory, LineTooLong }!?[]const u8 {
        while (true) {
            lr.scratch.writer.end = 0;
            const limit: std.Io.Limit = .limited(lr.max_line +| 1);
            const streamed = lr.reader.streamDelimiterLimit(&lr.scratch.writer, '\n', limit) catch |err| switch (err) {
                error.StreamTooLong => {
                    lr.skipped += 1;
                    return error.LineTooLong;
                },
                error.WriteFailed => return error.OutOfMemory,
                error.ReadFailed => return error.ReadFailed,
            };
            _ = lr.reader.takeByte() catch |err| switch (err) {
                error.EndOfStream => {
                    if (streamed > 0) lr.skipped += 1;
                    return null;
                },
                error.ReadFailed => return error.ReadFailed,
            };
            const line = std.mem.trim(u8, lr.scratch.writer.buffered(), " \t\r");
            if (line.len > 0) return line;
        }
    }
};

fn collect(gpa: std.mem.Allocator, bytes: []const u8, max_line: usize, out: *std.ArrayList([]u8)) !usize {
    var reader: std.Io.Reader = .fixed(bytes);
    var lr = LineReader.init(gpa, &reader, max_line);
    defer lr.deinit();
    while (try lr.next()) |line| {
        const copy = try gpa.dupe(u8, line);
        errdefer gpa.free(copy);
        try out.append(gpa, copy);
    }
    return lr.skipped;
}

fn freeAll(gpa: std.mem.Allocator, list: *std.ArrayList([]u8)) void {
    for (list.items) |item| gpa.free(item);
    list.deinit(gpa);
}

test "ndjson: lines split on newline, blanks and surrounding whitespace dropped" {
    var out: std.ArrayList([]u8) = .empty;
    defer freeAll(std.testing.allocator, &out);
    const skipped = try collect(std.testing.allocator, "{\"a\":1}\n\n  \r\n {\"b\":2} \r\n", 64, &out);
    try std.testing.expectEqual(@as(usize, 0), skipped);
    try std.testing.expectEqual(@as(usize, 2), out.items.len);
    try std.testing.expectEqualStrings("{\"a\":1}", out.items[0]);
    try std.testing.expectEqualStrings("{\"b\":2}", out.items[1]);
}

test "ndjson: an oversized line fails the reader after the lines before it" {
    var out: std.ArrayList([]u8) = .empty;
    defer freeAll(std.testing.allocator, &out);
    const big: [100]u8 = @splat('x');
    const input = try std.fmt.allocPrint(std.testing.allocator, "ok\n{s}\nnever\n", .{big});
    defer std.testing.allocator.free(input);
    try std.testing.expectError(error.LineTooLong, collect(std.testing.allocator, input, 8, &out));
    try std.testing.expectEqual(@as(usize, 1), out.items.len);
    try std.testing.expectEqualStrings("ok", out.items[0]);
}

test "ndjson: a line of exactly the limit is accepted" {
    var out: std.ArrayList([]u8) = .empty;
    defer freeAll(std.testing.allocator, &out);
    const skipped = try collect(std.testing.allocator, "12345678\n", 8, &out);
    try std.testing.expectEqual(@as(usize, 0), skipped);
    try std.testing.expectEqual(@as(usize, 1), out.items.len);
}

test "ndjson: an unterminated tail is not delivered and counts as skipped" {
    var out: std.ArrayList([]u8) = .empty;
    defer freeAll(std.testing.allocator, &out);
    const skipped = try collect(std.testing.allocator, "one\ntail", 64, &out);
    try std.testing.expectEqual(@as(usize, 1), skipped);
    try std.testing.expectEqual(@as(usize, 1), out.items.len);
}

test "ndjson: an oversized unterminated tail is also too long" {
    var out: std.ArrayList([]u8) = .empty;
    defer freeAll(std.testing.allocator, &out);
    const tail: [50]u8 = @splat('z');
    try std.testing.expectError(error.LineTooLong, collect(std.testing.allocator, "one\n" ++ tail, 8, &out));
    try std.testing.expectEqual(@as(usize, 1), out.items.len);
}

test "ndjson: allocation failures leave nothing behind" {
    const Run = struct {
        fn run(gpa: std.mem.Allocator) !void {
            var out: std.ArrayList([]u8) = .empty;
            defer freeAll(gpa, &out);
            const filler: [40]u8 = @splat('q');
            _ = collect(gpa, "alpha\nbeta\n" ++ filler ++ "\ngamma\n", 16, &out) catch |err| switch (err) {
                error.LineTooLong => return,
                else => return err,
            };
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Run.run, .{});
}
