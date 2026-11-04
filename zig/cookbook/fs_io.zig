//! TS: fs.readFileSync, fs.writeFileSync, fs.readdirSync, fs.mkdirSync({recursive}). There is no
//! std.fs.cwd() any more: every call takes the `io` value and a std.Io.Dir handle.
const std = @import("std");

/// Whole file into memory, refusing anything over `max_bytes` (error.StreamTooLong).
pub fn readAll(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, path: []const u8, max_bytes: usize) ![]u8 {
    return dir.readFileAlloc(io, path, gpa, .limited(max_bytes));
}

/// Names of the regular files in `dir`, sorted. The caller frees each name and the slice.
pub fn listFiles(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir) ![][]u8 {
    var names: std.ArrayList([]u8) = .empty;
    errdefer {
        for (names.items) |name| gpa.free(name);
        names.deinit(gpa);
    }
    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        if (entry.kind != .file) continue;
        try names.append(gpa, try gpa.dupe(u8, entry.name));
    }
    std.mem.sort([]u8, names.items, {}, struct {
        fn lessThan(_: void, a: []u8, b: []u8) bool {
            return std.mem.lessThan(u8, a, b);
        }
    }.lessThan);
    return names.toOwnedSlice(gpa);
}

test "fs_io: write, read back and cap the size" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(io, .{ .sub_path = "note.txt", .data = "hello" });
    const text = try readAll(std.testing.allocator, io, tmp.dir, "note.txt", 64);
    defer std.testing.allocator.free(text);
    try std.testing.expectEqualStrings("hello", text);

    try std.testing.expectError(error.StreamTooLong, readAll(std.testing.allocator, io, tmp.dir, "note.txt", 3));
    try std.testing.expectError(error.FileNotFound, readAll(std.testing.allocator, io, tmp.dir, "missing", 64));
}

test "fs_io: list files, skipping directories" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(io, "nested/deeper");
    try tmp.dir.writeFile(io, .{ .sub_path = "b.json", .data = "{}" });
    try tmp.dir.writeFile(io, .{ .sub_path = "a.json", .data = "{}" });

    const names = try listFiles(std.testing.allocator, io, tmp.dir);
    defer {
        for (names) |name| std.testing.allocator.free(name);
        std.testing.allocator.free(names);
    }
    try std.testing.expectEqual(@as(usize, 2), names.len);
    try std.testing.expectEqualStrings("a.json", names[0]);
    try std.testing.expectEqualStrings("b.json", names[1]);
}

test "fs_io: line by line through a File.Reader" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "log.ndjson", .data = "{\"a\":1}\n{\"a\":2}\n" });

    var file = try tmp.dir.openFile(io, "log.ndjson", .{});
    defer file.close(io);
    var buf: [256]u8 = undefined;
    var reader = file.reader(io, &buf);
    var count: usize = 0;
    while (try reader.interface.takeDelimiter('\n')) |line| {
        try std.testing.expect(line.len == 7);
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), count);
}
