//! harness-hook: the small binary an agent can run inside the sandbox. It links guard L1 and a
//! minimal HTTP POST only, never the server. The guard slice fills it in.
const std = @import("std");

pub fn main() u8 {
    std.debug.print("not implemented: harness-hook\n", .{});
    return 2;
}

test "hook_main: stub compiles" {}
