//! Cross-slice event payloads. One variant per slice; a slice replaces its `void` with a payload
//! struct when it has events to publish.
const std = @import("std");

pub const Event = union(enum) {
    db: void,
    http: void,
    realtime: void,
    auth: void,
    orgs: void,
    board: void,
    chat: void,
    guard: void,
    heartbeat: void,
    laya: void,
    logs: void,
    mcp: void,
    agents: void,
    runtimes: void,
    usage: void,
};

test "events: variants are addressable by slice name" {
    const event: Event = .{ .guard = {} };
    try std.testing.expectEqualStrings("guard", @tagName(event));
}
