//! Request bodies of the auth routes, validated the way code/src/shared/auth.ts does with zod:
//! the same limits (counted in code points, as zod does), trimming, lowercasing and the email pattern; keys
//! the schema does not name are dropped; any violation is `error.InvalidBody`, which the HTTP
//! layer turns into 400 `invalid body`. Everything lives in the request arena.
const std = @import("std");
const httpz = @import("httpz");
const json = @import("../json.zig");
const parity = @import("../parity.zig");
const webauthn = @import("webauthn.zig");

const Value = std.json.Value;
const Allocator = std.mem.Allocator;

pub const Error = error{InvalidBody};

pub const Assertion = struct { challenge_id: []const u8, response: webauthn.Credential };
pub const Passkey = struct { challenge_id: []const u8, response: webauthn.Credential, name: []const u8 };
pub const Email = struct { email: []const u8 };
pub const Code = struct { email: []const u8, code: []const u8 };
pub const EnrollOptions = struct { email: []const u8, name: []const u8 };
pub const EnrollVerify = struct { challenge_id: []const u8, user_id: []const u8, response: webauthn.Credential, name: []const u8 };

const b64_max = 16384;
const challenge_id_max = 64;
const code_max = 64;
const label_max = 80;
const email_max = 254;
const transports_max = 8;
const transport_max = 32;
/// The name a passkey gets when the body has none.
pub const default_passkey_name = "Passkey";

// ---- primitives ----

fn object(value: Value) Error!std.json.ObjectMap {
    return switch (value) {
        .object => |map| map,
        else => error.InvalidBody,
    };
}

fn field(map: std.json.ObjectMap, name: []const u8) ?Value {
    return map.get(name);
}

fn string(value: Value) Error![]const u8 {
    return switch (value) {
        .string => |text| text,
        else => error.InvalidBody,
    };
}

/// `z.string().min(min).max(max)`; lengths are code points.
fn bounded(value: Value, min: usize, max: usize) Error![]const u8 {
    const text = try string(value);
    const len = parity.codePoints(text) catch return error.InvalidBody;
    if (len < min or len > max) return error.InvalidBody;
    return text;
}

fn required(map: std.json.ObjectMap, name: []const u8) Error!Value {
    return field(map, name) orelse error.InvalidBody;
}

fn b64(map: std.json.ObjectMap, name: []const u8) Error![]const u8 {
    return bounded(try required(map, name), 1, b64_max);
}

/// `z.string().trim().min(1).max(n)`.
fn trimmed(value: Value, max: usize) Error![]const u8 {
    const text = parity.jsTrim(try string(value));
    const len = parity.codePoints(text) catch return error.InvalidBody;
    if (len < 1 or len > max) return error.InvalidBody;
    return text;
}

/// `label` with `.default("Passkey")`: a missing key takes the default, an explicit null does not.
fn labelOrDefault(map: std.json.ObjectMap) Error![]const u8 {
    const value = field(map, "name") orelse return default_passkey_name;
    return trimmed(value, label_max);
}

fn challengeId(map: std.json.ObjectMap) Error![]const u8 {
    return bounded(try required(map, "challengeId"), 1, challenge_id_max);
}

// ---- email ----

fn isLocalChar(ch: u8) bool {
    return std.ascii.isAlphanumeric(ch) or ch == '_' or ch == '\'' or ch == '+' or ch == '-';
}

/// zod 4.6's `email` pattern:
/// `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`.
/// The local part is dot-separated non-empty atoms whose last character is not `'`; the domain is
/// at least one label and a letters-only top label of two or more.
pub fn emailPattern(text: []const u8) bool {
    const at = std.mem.findScalar(u8, text, '@') orelse return false;
    const local = text[0..at];
    const domain = text[at + 1 ..];
    if (std.mem.findScalar(u8, domain, '@') != null) return false;
    if (local.len == 0 or local[local.len - 1] == '\'') return false;
    var atoms = std.mem.splitScalar(u8, local, '.');
    while (atoms.next()) |atom| {
        if (atom.len == 0) return false;
        for (atom) |ch| if (!isLocalChar(ch)) return false;
    }
    var labels = std.mem.splitScalar(u8, domain, '.');
    var count: usize = 0;
    var last: []const u8 = "";
    while (labels.next()) |label| {
        count += 1;
        last = label;
        if (label.len == 0) return false;
    }
    if (count < 2) return false;
    var inner = std.mem.splitScalar(u8, domain, '.');
    var seen: usize = 0;
    while (inner.next()) |label| : (seen += 1) {
        if (seen + 1 == count) break;
        if (!std.ascii.isAlphanumeric(label[0])) return false;
        for (label) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '-') return false;
    }
    if (last.len < 2) return false;
    for (last) |ch| if (!std.ascii.isAlphabetic(ch)) return false;
    return true;
}

/// `z.string().trim().toLowerCase().pipe(z.email().max(254))`.
pub fn normalizeEmail(arena: Allocator, raw: []const u8) (Error || Allocator.Error)![]const u8 {
    const lowered = parity.jsLowerEmail(arena, parity.jsTrim(raw)) catch |err| switch (err) {
        error.InvalidUtf8 => return error.InvalidBody,
        error.OutOfMemory => return error.OutOfMemory,
    };
    if (lowered.len > email_max or !emailPattern(lowered)) return error.InvalidBody;
    return lowered;
}

fn email(arena: Allocator, map: std.json.ObjectMap) (Error || Allocator.Error)![]const u8 {
    return normalizeEmail(arena, try string(try required(map, "email")));
}

// ---- credentials ----

fn credentialBase(map: std.json.ObjectMap) Error!webauthn.Credential {
    const id = try b64(map, "id");
    const raw_id = try b64(map, "rawId");
    if (!std.mem.eql(u8, try string(try required(map, "type")), "public-key")) return error.InvalidBody;
    // `z.record(z.string(), z.unknown())`: a plain object, whatever it holds.
    _ = try object(try required(map, "clientExtensionResults"));
    return .{ .id = id, .rawId = raw_id, .type = "public-key" };
}

fn assertionCredential(value: Value) Error!webauthn.Credential {
    const map = try object(value);
    var credential = try credentialBase(map);
    const inner = try object(try required(map, "response"));
    if (field(inner, "userHandle")) |handle| _ = try bounded(handle, 1, b64_max);
    credential.response = .{
        .clientDataJSON = try b64(inner, "clientDataJSON"),
        .authenticatorData = try b64(inner, "authenticatorData"),
        .signature = try b64(inner, "signature"),
    };
    return credential;
}

fn attestationCredential(arena: Allocator, value: Value) (Error || Allocator.Error)!webauthn.Credential {
    const map = try object(value);
    var credential = try credentialBase(map);
    const inner = try object(try required(map, "response"));
    var transports: ?[]const []const u8 = null;
    if (field(inner, "transports")) |raw| {
        const items = switch (raw) {
            .array => |list| list.items,
            else => return error.InvalidBody,
        };
        if (items.len > transports_max) return error.InvalidBody;
        const out = try arena.alloc([]const u8, items.len);
        for (items, out) |item, *slot| slot.* = try bounded(item, 0, transport_max);
        transports = out;
    }
    credential.response = .{
        .clientDataJSON = try b64(inner, "clientDataJSON"),
        .attestationObject = try b64(inner, "attestationObject"),
        .transports = transports,
    };
    return credential;
}

// ---- bodies ----

fn root(req: *httpz.Request) Error!std.json.ObjectMap {
    const bytes = req.body() orelse return error.InvalidBody;
    const value = std.json.parseFromSliceLeaky(Value, req.arena, bytes, json.parse_options) catch return error.InvalidBody;
    return object(value);
}

pub fn assertion(req: *httpz.Request) Error!Assertion {
    const map = try root(req);
    return .{ .challenge_id = try challengeId(map), .response = try assertionCredential(try required(map, "response")) };
}

pub fn passkey(req: *httpz.Request) (Error || Allocator.Error)!Passkey {
    const map = try root(req);
    return .{
        .challenge_id = try challengeId(map),
        .response = try attestationCredential(req.arena, try required(map, "response")),
        .name = try labelOrDefault(map),
    };
}

pub fn emailOnly(req: *httpz.Request) (Error || Allocator.Error)!Email {
    return .{ .email = try email(req.arena, try root(req)) };
}

pub fn emailAndCode(req: *httpz.Request) (Error || Allocator.Error)!Code {
    const map = try root(req);
    return .{ .email = try email(req.arena, map), .code = try trimmed(try required(map, "code"), code_max) };
}

pub fn enrollOptions(req: *httpz.Request) (Error || Allocator.Error)!EnrollOptions {
    const map = try root(req);
    return .{ .email = try email(req.arena, map), .name = try trimmed(try required(map, "name"), label_max) };
}

pub fn enrollVerify(req: *httpz.Request) (Error || Allocator.Error)!EnrollVerify {
    const map = try root(req);
    return .{
        .challenge_id = try challengeId(map),
        .user_id = try bounded(try required(map, "userId"), 1, challenge_id_max),
        .response = try attestationCredential(req.arena, try required(map, "response")),
        .name = try labelOrDefault(map),
    };
}

// ---- tests ----

const testing = std.testing;

fn repeat(comptime unit: []const u8, comptime n: usize) *const [unit.len * n]u8 {
    comptime {
        var buf: [unit.len * n]u8 = undefined;
        for (0..n) |i| @memcpy(buf[i * unit.len ..][0..unit.len], unit);
        const final = buf;
        return &final;
    }
}

test "body: the email pattern accepts and refuses what zod's does" {
    const good = [_][]const u8{ "a@example.com", "o'brien@ex.co", "a.b+c@sub.example.org", "x_y-z@a-b.io", "a@b-.cc", "1@2.ab" };
    for (good) |text| testing.expect(emailPattern(text)) catch |err| {
        std.debug.print("should pass: {s}\n", .{text});
        return err;
    };
    const bad = [_][]const u8{ "", "a", "a@b", "a@b.c", "@x.com", ".a@x.com", "a.@x.com", "a..b@x.com", "a'@x.com", "a@-x.com", "a@x..com", "a@x.c0m", "a@x.com.", "a b@x.com", "a@@x.com", "a@x_y.com", "a@.com" };
    for (bad) |text| testing.expect(!emailPattern(text)) catch |err| {
        std.debug.print("should fail: {s}\n", .{text});
        return err;
    };
}

test "body: an email is trimmed, lowercased, and capped at 254" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqualStrings("a@example.com", try normalizeEmail(arena.allocator(), "  A@Example.COM\n"));
    try testing.expectEqualStrings("kk@example.com", try normalizeEmail(arena.allocator(), "k\u{212a}@example.com"));
    try testing.expectError(error.InvalidBody, normalizeEmail(arena.allocator(), "i\u{0130}@example.com"));
    const long = comptime repeat("a", 245) ++ "@ex.com";
    try testing.expectEqual(@as(usize, 252), long.len);
    _ = try normalizeEmail(arena.allocator(), long);
    try testing.expectError(error.InvalidBody, normalizeEmail(arena.allocator(), "aaa" ++ long));
}

test "body: a login assertion needs every field and drops unknown ones" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.body("{\"challengeId\":\"c\",\"extra\":1,\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"public-key\",\"clientExtensionResults\":{},\"response\":{\"clientDataJSON\":\"x\",\"authenticatorData\":\"y\",\"signature\":\"z\",\"userHandle\":\"u\"}}}");
    const parsed = try assertion(web.req);
    try testing.expectEqualStrings("c", parsed.challenge_id);
    try testing.expectEqualStrings("z", parsed.response.response.?.signature.?);

    const broken = [_][]const u8{
        "",
        "null",
        "[]",
        "{\"challengeId\":\"c\"}",
        "{\"challengeId\":\"\",\"response\":{}}",
        // type must be the literal, clientExtensionResults an object, userHandle a non-empty string
        "{\"challengeId\":\"c\",\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"x\",\"clientExtensionResults\":{},\"response\":{\"clientDataJSON\":\"x\",\"authenticatorData\":\"y\",\"signature\":\"z\"}}}",
        "{\"challengeId\":\"c\",\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"public-key\",\"clientExtensionResults\":[],\"response\":{\"clientDataJSON\":\"x\",\"authenticatorData\":\"y\",\"signature\":\"z\"}}}",
        "{\"challengeId\":\"c\",\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"public-key\",\"clientExtensionResults\":{},\"response\":{\"clientDataJSON\":\"x\",\"authenticatorData\":\"y\",\"signature\":\"z\",\"userHandle\":null}}}",
        "{\"challengeId\":\"c\",\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"public-key\",\"clientExtensionResults\":{},\"response\":{\"clientDataJSON\":\"x\",\"authenticatorData\":\"y\"}}}",
    };
    for (broken) |text| {
        var again = httpz.testing.init(.{});
        defer again.deinit();
        if (text.len > 0) again.body(text);
        testing.expectError(error.InvalidBody, assertion(again.req)) catch |err| {
            std.debug.print("should be refused: {s}\n", .{text});
            return err;
        };
    }
}

test "body: limits count code points and the name defaults to Passkey" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    const cred = "\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"public-key\",\"clientExtensionResults\":{},\"response\":{\"clientDataJSON\":\"x\",\"attestationObject\":\"y\",\"transports\":[\"internal\"]}}";
    web.body("{\"challengeId\":\"c\"," ++ cred ++ "}");
    const plain = try passkey(web.req);
    try testing.expectEqualStrings("Passkey", plain.name);
    try testing.expectEqualStrings("internal", plain.response.response.?.transports.?[0]);

    var named = httpz.testing.init(.{});
    defer named.deinit();
    named.body("{\"challengeId\":\"c\",\"name\":\"  Laptop \"," ++ cred ++ "}");
    try testing.expectEqualStrings("Laptop", (try passkey(named.req)).name);

    // 80 astral characters are 80 code points (fine, though 160 UTF-16 units), 81 are too long.
    var edge = httpz.testing.init(.{});
    defer edge.deinit();
    edge.body("{\"challengeId\":\"c\",\"name\":\"" ++ comptime repeat("\u{1F600}", 80) ++ "\"," ++ cred ++ "}");
    _ = try passkey(edge.req);
    var over = httpz.testing.init(.{});
    defer over.deinit();
    over.body("{\"challengeId\":\"c\",\"name\":\"" ++ comptime repeat("\u{1F600}", 81) ++ "\"," ++ cred ++ "}");
    try testing.expectError(error.InvalidBody, passkey(over.req));

    var blank = httpz.testing.init(.{});
    defer blank.deinit();
    blank.body("{\"challengeId\":\"c\",\"name\":\"   \"," ++ cred ++ "}");
    try testing.expectError(error.InvalidBody, passkey(blank.req));
    var nulled = httpz.testing.init(.{});
    defer nulled.deinit();
    nulled.body("{\"challengeId\":\"c\",\"name\":null," ++ cred ++ "}");
    try testing.expectError(error.InvalidBody, passkey(nulled.req));
}

test "body: email and code bodies trim, enroll bodies need a name" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.body("{\"email\":\" Ada@Example.com \",\"code\":\"  123456 \"}");
    const parsed = try emailAndCode(web.req);
    try testing.expectEqualStrings("ada@example.com", parsed.email);
    try testing.expectEqualStrings("123456", parsed.code);

    var long = httpz.testing.init(.{});
    defer long.deinit();
    long.body("{\"email\":\"a@example.com\",\"code\":\"" ++ comptime repeat("9", 65) ++ "\"}");
    try testing.expectError(error.InvalidBody, emailAndCode(long.req));

    var enroll = httpz.testing.init(.{});
    defer enroll.deinit();
    enroll.body("{\"email\":\"a@example.com\"}");
    try testing.expectError(error.InvalidBody, enrollOptions(enroll.req));
}

test "body: a deeply nested value is walked without recursion" {
    const depth = 100_000;
    const head = "{\"challengeId\":\"c\",\"response\":{\"id\":\"A\",\"rawId\":\"A\",\"type\":\"public-key\",\"clientExtensionResults\":{\"k\":";
    const tail = "},\"response\":{\"clientDataJSON\":\"x\",\"authenticatorData\":\"y\",\"signature\":\"z\"}}}";
    const text = try testing.allocator.alloc(u8, head.len + depth * 2 + tail.len);
    defer testing.allocator.free(text);
    @memcpy(text[0..head.len], head);
    @memset(text[head.len..][0..depth], '[');
    @memset(text[head.len + depth ..][0..depth], ']');
    @memcpy(text[head.len + depth * 2 ..], tail);
    var web = httpz.testing.init(.{});
    defer web.deinit();
    web.body(text);
    _ = try assertion(web.req);
    // The same nesting left open is refused, not a crash.
    var open = httpz.testing.init(.{});
    defer open.deinit();
    open.body(text[0 .. head.len + depth]);
    try testing.expectError(error.InvalidBody, assertion(open.req));
}
