//! Build-time generator: emits migrations.zig with one @embedFile per NNN_*.sql in sorted order. Filled in by the db slice.
const std = @import("std");

pub fn main() u8 {
    std.debug.print("not implemented: migrategen\n", .{});
    return 2;
}

test "migrategen: stub compiles" {}
