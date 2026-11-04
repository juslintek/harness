//! Tests for enroll.zig: the link `harness enroll` prints and the first-run line of `harness serve`.
const std = @import("std");
const codes = @import("codes.zig");
const enroll = @import("enroll.zig");
const Ctx = @import("codes_test.zig").Ctx;

const testing = std.testing;

fn argv(comptime items: []const [:0]const u8) []const [:0]const u8 {
    return items;
}

test "enroll: arguments are read like node's parseArgs in strict mode" {
    const parsed = try enroll.parseArgs(argv(&.{ "--email", "a@example.com", "--name=Ada Lovelace" }));
    try testing.expectEqualStrings("a@example.com", parsed.email.?);
    try testing.expectEqualStrings("Ada Lovelace", parsed.name.?);
    const only = try enroll.parseArgs(argv(&.{"--email=a@example.com"}));
    try testing.expect(only.name == null);
    try testing.expect((try enroll.parseArgs(argv(&.{}))).email == null);
    try testing.expectError(error.BadArguments, enroll.parseArgs(argv(&.{ "--email", "a@example.com", "--bogus", "x" })));
    try testing.expectError(error.BadArguments, enroll.parseArgs(argv(&.{ "--email", "a@example.com", "extra" })));
    try testing.expectError(error.BadArguments, enroll.parseArgs(argv(&.{"--email"})));
    // node's parseArgs refuses a separate value that starts with a dash (ERR_PARSE_ARGS_INVALID_OPTION_VALUE).
    try testing.expectError(error.BadArguments, enroll.parseArgs(argv(&.{ "--email", "--name=Alice" })));
    try testing.expectError(error.BadArguments, enroll.parseArgs(argv(&.{ "--email", "a@example.com", "--name", "-x" })));
    // With the equals sign a leading dash is fine.
    try testing.expectEqualStrings("-x", (try enroll.parseArgs(argv(&.{"--name=-x"}))).name.?);
}

test "enroll: an unknown email gets an account and a link that redeems for it" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    const link = try enroll.enrollLink(app, ctx.alloc(), "https://harness.example.com", .{ .email = "Ada@Example.com", .name = "Ada" });
    const prefix = "https://harness.example.com/#/enroll/";
    try testing.expect(std.mem.startsWith(u8, link, prefix));
    const code = link[prefix.len..];
    try testing.expectEqual(@as(usize, 19), code.len);
    const user = (try codes.findUserByEmail(app, ctx.alloc(), "ada@example.com")).?;
    try testing.expectEqualStrings("Ada", user.name);
    try testing.expect(!user.instanceAdmin);
    const redeemed = try codes.redeemEnrollment(app, ctx.alloc(), code, .{ .email = "ada@example.com", .name = "Ada" }, @import("../ids.zig").nowMs(testing.io));
    try testing.expectEqualStrings(user.id, redeemed.?);
}

test "enroll: the name defaults to the part before the at sign and an existing user keeps theirs" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    const app = &ctx.fx.app;
    _ = try enroll.enrollLink(app, ctx.alloc(), "http://localhost:4100", .{ .email = "grace.h@example.com" });
    try testing.expectEqualStrings("grace.h", (try codes.findUserByEmail(app, ctx.alloc(), "grace.h@example.com")).?.name);
    const first = try enroll.enrollLink(app, ctx.alloc(), "http://localhost:4100", .{ .email = "grace.h@example.com", .name = "Someone Else" });
    try testing.expectEqualStrings("grace.h", (try codes.findUserByEmail(app, ctx.alloc(), "GRACE.H@example.com")).?.name);
    try testing.expectEqual(@as(i64, 1), try ctx.count("SELECT count(*) FROM users"));
    // A second link for the same user ends the first.
    const second = try enroll.enrollLink(app, ctx.alloc(), "http://localhost:4100", .{ .email = "grace.h@example.com" });
    const profile: codes.Profile = .{ .email = "grace.h@example.com", .name = "grace.h" };
    const now = @import("../ids.zig").nowMs(testing.io);
    const prefix = "http://localhost:4100/#/enroll/";
    try testing.expect((try codes.redeemEnrollment(app, ctx.alloc(), first[prefix.len..], profile, now)) == null);
    try testing.expect((try codes.redeemEnrollment(app, ctx.alloc(), second[prefix.len..], profile, now)) != null);
}

test "enroll: the first-run line has the contract shape and is printed once per live instance" {
    var ctx = try Ctx.init();
    defer ctx.deinit();
    var first_run: enroll.FirstRun = .{ .app = &ctx.fx.app, .gpa = testing.allocator, .configured_origin = null };
    var buf: [256]u8 = undefined;
    var out: std.Io.Writer = .fixed(&buf);
    try first_run.print(ctx.alloc(), 4100, &out);
    const line = out.buffered();
    const prefix = "first-run enrollment: http://localhost:4100/#/enroll/";
    try testing.expect(std.mem.startsWith(u8, line, prefix));
    try testing.expect(line[line.len - 1] == '\n');
    const code = line[prefix.len .. line.len - 1];
    try testing.expectEqual(@as(usize, 19), code.len);
    for (code, 0..) |ch, i| {
        if (i % 5 == 4) try testing.expectEqual(@as(u8, '-'), ch) else try testing.expect(std.mem.findScalar(u8, "abcdefghijklmnopqrstuvwxyz234567", ch) != null);
    }

    // With HARNESS_ORIGIN set the link starts there, whatever port was bound.
    var configured: enroll.FirstRun = .{ .app = &ctx.fx.app, .gpa = testing.allocator, .configured_origin = "https://harness.example.com" };
    var buf2: [256]u8 = undefined;
    var out2: std.Io.Writer = .fixed(&buf2);
    try configured.print(ctx.alloc(), 4100, &out2);
    try testing.expect(std.mem.startsWith(u8, out2.buffered(), "first-run enrollment: https://harness.example.com/#/enroll/"));

    // Once an admin holds a passkey there is nothing to print.
    const admin = try ctx.user("boss@example.com", true);
    try ctx.addPasskey(admin, "p");
    var buf3: [256]u8 = undefined;
    var out3: std.Io.Writer = .fixed(&buf3);
    try first_run.print(ctx.alloc(), 4100, &out3);
    try testing.expectEqual(@as(usize, 0), out3.buffered().len);
}
