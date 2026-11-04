//! Build-time generator: turns ../ui/dist into a StaticStringMap of embedded assets. Filled in by the http slice.
const std = @import("std");

pub fn main() u8 {
    std.debug.print("not implemented: embedgen\n", .{});
    return 2;
}

test "embedgen: stub compiles" {}
