const std = @import("std");
const body = @import("body.zig");
const repo = @import("repo.zig");

const testing = std.testing;

/// Runs `parse` over `raw` in a throwaway arena and says whether the body was accepted.
fn accepts(comptime parse: anytype, raw: ?[]const u8) !bool {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    return (try parse(arena.allocator(), raw)) != null;
}

/// `unit` repeated `n` times; `**` is gone in Zig 0.17.
fn rep(a: std.mem.Allocator, unit: []const u8, n: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (0..n) |_| try out.appendSlice(a, unit);
    return out.items;
}

test "orgs: strict bodies refuse unknown keys, non-objects and missing fields" {
    try testing.expect(try accepts(body.createOrg, "{\"name\":\"Acme\",\"slug\":\"acme\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"Acme\",\"slug\":\"acme\",\"extra\":1}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"Acme\"}"));
    try testing.expect(!try accepts(body.createOrg, "[]"));
    try testing.expect(!try accepts(body.createOrg, "null"));
    try testing.expect(!try accepts(body.createOrg, "{"));
    try testing.expect(!try accepts(body.createOrg, null));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":1,\"slug\":\"acme\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"Acme\",\"slug\":null}"));
}

test "orgs: a duplicate key keeps the last value" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const parsed = (try body.name(arena.allocator(), "{\"name\":\"a\",\"name\":\"b\"}")).?;
    try testing.expectEqualStrings("b", parsed.name);
}

test "orgs: titles are trimmed and counted in code points" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const padded = (try body.name(a, "{\"name\":\"  \\u00a0Acme\\ufeff \"}")).?;
    try testing.expectEqualStrings("Acme", padded.name);
    try testing.expect(!try accepts(body.name, "{\"name\":\"   \"}"));
    try testing.expect(!try accepts(body.name, "{\"name\":\"\"}"));

    // zod 4 counts code points, so 80 emoji pass and 81 do not (160 UTF-16 units).
    var scratch: std.heap.ArenaAllocator = .init(testing.allocator);
    defer scratch.deinit();
    const s = scratch.allocator();
    for ([_]struct { []const u8, usize, bool }{
        .{ "\u{1F600}", 80, true },
        .{ "\u{1F600}", 81, false },
        .{ "\u{e9}", 80, true },
        .{ "a", 80, true },
        .{ "a", 81, false },
    }) |case| {
        const raw = try std.fmt.allocPrint(s, "{{\"name\":\"{s}\"}}", .{try rep(s, case[0], case[1])});
        try testing.expectEqual(case[2], try accepts(body.name, raw));
    }
}

test "orgs: slugs and handles follow the handle pattern" {
    try testing.expect(try accepts(body.createOrg, "{\"name\":\"A\",\"slug\":\"a_b-1\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"A\",\"slug\":\"A\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"A\",\"slug\":\"x\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"A\",\"slug\":\"-ab\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"A\",\"slug\":\"ab\\n\"}"));
}

test "orgs: ids are 1 to 64 characters and not trimmed" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const spaced = (try body.memberId(arena.allocator(), "{\"memberId\":\" x \"}")).?;
    try testing.expectEqualStrings(" x ", spaced.member_id);
    try testing.expect(!try accepts(body.memberId, "{\"memberId\":\"\"}"));
    const long = try std.fmt.allocPrint(arena.allocator(), "{{\"memberId\":\"{s}\"}}", .{try rep(arena.allocator(), "x", 65)});
    try testing.expect(!try accepts(body.memberId, long));
    try testing.expect(!try accepts(body.memberId, "{\"member_id\":\"x\"}"));
}

test "orgs: invite email is trimmed, lowercased and checked" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const ok = (try body.addHuman(arena.allocator(), "{\"email\":\"  Ann@Example.COM \",\"role\":\"admin\",\"name\":\" Ann \",\"handle\":\"ann\"}")).?;
    try testing.expectEqualStrings("ann@example.com", ok.email);
    try testing.expectEqual(repo.Role.admin, ok.role);
    try testing.expectEqualStrings("Ann", ok.name.?);
    try testing.expectEqualStrings("ann", ok.handle.?);
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"nope\",\"role\":\"member\"}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@b.co\",\"role\":\"boss\"}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@b.co\"}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@b.co\",\"role\":\"member\",\"handle\":\"X\"}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@b.co\",\"role\":\"member\",\"name\":null}"));
    const long_local = try std.fmt.allocPrint(arena.allocator(), "{{\"email\":\"{s}@example.com\",\"role\":\"member\"}}", .{try rep(arena.allocator(), "a", 250)});
    try testing.expect(!try accepts(body.addHuman, long_local));
}

test "orgs: agent bodies bound heartbeat, specialties and model" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const base = "{\"agentId\":\"claude\",\"handle\":\"bot\",\"displayName\":\"Bot\"";
    const full = (try body.addAgent(arena.allocator(), base ++ ",\"model\":\"opus\",\"specialties\":[\"a\",\"b\"],\"heartbeatMinutes\":5.0}")).?;
    try testing.expectEqualStrings("opus", full.model.?);
    try testing.expectEqual(@as(usize, 2), full.specialties.?.len);
    try testing.expectEqual(@as(i64, 5), full.heartbeat_minutes.?);

    try testing.expect(try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":1}"));
    try testing.expect(try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":10080}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":0}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":10081}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":1.5}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":\"5\"}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":null}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"heartbeatMinutes\":1e400}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"model\":\"\"}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"specialties\":[\"\"]}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"specialties\":[1]}"));
    try testing.expect(!try accepts(body.addAgent, base ++ ",\"role\":\"admin\"}"));

    const twenty = try rep(arena.allocator(), "\"s\",", 19);
    const with_twenty = try std.fmt.allocPrint(arena.allocator(), "{s},\"specialties\":[{s}\"s\"]}}", .{ base, twenty });
    try testing.expect(try accepts(body.addAgent, with_twenty));
    const with_21 = try std.fmt.allocPrint(arena.allocator(), "{s},\"specialties\":[{s}\"s\",\"s\"]}}", .{ base, twenty });
    try testing.expect(!try accepts(body.addAgent, with_21));
    const long_tag = try std.fmt.allocPrint(arena.allocator(), "{s},\"specialties\":[\"{s}\"]}}", .{ base, try rep(arena.allocator(), "x", 41) });
    try testing.expect(!try accepts(body.addAgent, long_tag));
}

test "orgs: member patches tell absent from null" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const empty = (try body.memberPatch(a, "{}")).?;
    try testing.expect(empty.model == .unset and empty.heartbeat_minutes == .unset and empty.role == null);
    const cleared = (try body.memberPatch(a, "{\"model\":null,\"heartbeatMinutes\":null,\"paused\":false,\"role\":\"viewer\"}")).?;
    try testing.expect(cleared.model == .clear and cleared.heartbeat_minutes == .clear);
    try testing.expectEqual(@as(?bool, false), cleared.paused);
    try testing.expectEqual(@as(?repo.Role, .viewer), cleared.role);
    const set = (try body.memberPatch(a, "{\"model\":\"m\",\"heartbeatMinutes\":7,\"displayName\":\" N \"}")).?;
    try testing.expectEqualStrings("m", set.model.set);
    try testing.expectEqual(@as(i64, 7), set.heartbeat_minutes.set);
    try testing.expectEqualStrings("N", set.display_name.?);
    try testing.expect(!try accepts(body.memberPatch, "{\"displayName\":null}"));
    try testing.expect(!try accepts(body.memberPatch, "{\"paused\":\"yes\"}"));
    try testing.expect(!try accepts(body.memberPatch, "{\"userId\":\"x\"}"));
}

test "orgs: position bodies and patches" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const created = (try body.position(a, "{\"title\":\" Lead \",\"isManager\":true,\"teamId\":\"t\"}")).?;
    try testing.expectEqualStrings("Lead", created.title);
    try testing.expectEqual(@as(?bool, true), created.is_manager);
    try testing.expect(created.member_id == null);
    try testing.expect(!try accepts(body.position, "{\"title\":\"x\",\"teamId\":null}"));
    try testing.expect(!try accepts(body.position, "{}"));

    const patch = (try body.positionPatch(a, "{\"teamId\":null,\"reportsTo\":\"p\"}")).?;
    try testing.expect(patch.team_id == .clear);
    try testing.expectEqualStrings("p", patch.reports_to.set);
    try testing.expect(patch.member_id == .unset and patch.title == null);
    try testing.expect(!try accepts(body.positionPatch, "{\"title\":null}"));
    try testing.expect(!try accepts(body.positionPatch, "{\"teamId\":\"\"}"));
}

test "orgs: project, grant and revoke bodies" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const project = (try body.project(a, "{\"key\":\"AB_c-1\",\"name\":\" App \",\"repo\":\"/tmp/x\"}")).?;
    try testing.expectEqualStrings("AB_c-1", project.key);
    try testing.expectEqualStrings("App", project.name);
    try testing.expectEqualStrings("/tmp/x", project.repo.?);
    try testing.expect(!try accepts(body.project, "{\"key\":\"a b\",\"name\":\"n\"}"));
    try testing.expect(!try accepts(body.project, "{\"key\":\"\",\"name\":\"n\"}"));
    try testing.expect(!try accepts(body.project, "{\"key\":\"abcdefghijklmnopq\",\"name\":\"n\"}"));
    try testing.expect(try accepts(body.project, "{\"key\":\"abcdefghijklmnop\",\"name\":\"n\"}"));
    try testing.expect(!try accepts(body.project, "{\"key\":\"k\",\"name\":\"n\",\"repo\":\"\"}"));
    try testing.expect(!try accepts(body.project, "{\"key\":\"k\\n\",\"name\":\"n\"}"));

    const grant = (try body.grant(a, "{\"orgId\":\"o\",\"permission\":\"write\"}")).?;
    try testing.expectEqual(repo.Permission.write, grant.permission);
    try testing.expect(!try accepts(body.grant, "{\"orgId\":\"o\",\"permission\":\"admin\"}"));
    try testing.expect(!try accepts(body.grant, "{\"orgId\":\"o\"}"));
    try testing.expect(try accepts(body.revoke, "{\"orgId\":\"o\"}"));
    try testing.expect(!try accepts(body.revoke, "{\"orgId\":\"o\",\"permission\":\"read\"}"));
}

test "orgs: a string sent as an array of bytes or a number, and an enum sent as a number, are refused" {
    // std.json would read `[97,99,109,101]` as the bytes of "acme" and `1` as an enum index.
    try testing.expect(!try accepts(body.createOrg, "{\"name\":\"Acme\",\"slug\":[97,99,109,101]}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":[65,99,109,101],\"slug\":\"acme\"}"));
    try testing.expect(!try accepts(body.createOrg, "{\"name\":5,\"slug\":\"acme\"}"));
    try testing.expect(!try accepts(body.name, "{\"name\":[67]}"));
    try testing.expect(!try accepts(body.memberId, "{\"memberId\":[1]}"));
    try testing.expect(try accepts(body.addHuman, "{\"email\":\"a@example.test\",\"role\":\"member\"}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":[97],\"role\":\"member\"}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@example.test\",\"role\":1}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@example.test\",\"role\":0}"));
    try testing.expect(!try accepts(body.addHuman, "{\"email\":\"a@example.test\",\"role\":\"member\",\"name\":[78]}"));
    try testing.expect(!try accepts(body.memberPatch, "{\"role\":2}"));
    try testing.expect(!try accepts(body.memberPatch, "{\"displayName\":[78]}"));
    try testing.expect(!try accepts(body.position, "{\"title\":[80]}"));
    try testing.expect(!try accepts(body.grant, "{\"orgId\":\"o\",\"permission\":0}"));
    try testing.expect(!try accepts(body.grant, "{\"orgId\":[111],\"permission\":\"read\"}"));
    try testing.expect(!try accepts(body.revoke, "{\"orgId\":[111]}"));
}
