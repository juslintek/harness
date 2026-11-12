//! The request bodies of shared/orgs.ts. Every schema there is `.strict()`, so an unknown key, a
//! wrong type or a value out of range makes the whole body invalid. The parsers answer null for
//! such a body and only fail on running out of memory. Lengths count code points, as zod 4 does,
//! and `title` is trimmed with the JS whitespace set first.
const std = @import("std");
const auth_body = @import("../auth/body.zig");
const json = @import("../json.zig");
const parity = @import("../parity.zig");
const repo = @import("repo.zig");

const Allocator = std.mem.Allocator;
const Value = std.json.Value;
const Map = std.json.ObjectMap;
const Opt = repo.Opt;
const Invalid = error{InvalidBody};

pub const CreateOrg = struct { name: []const u8, slug: []const u8 };
pub const Name = struct { name: []const u8 };
pub const MemberId = struct { member_id: []const u8 };
pub const AddHuman = struct { email: []const u8, role: repo.Role, name: ?[]const u8, handle: ?[]const u8 };
pub const AddAgent = struct {
    agent_id: []const u8,
    handle: []const u8,
    display_name: []const u8,
    model: ?[]const u8,
    specialties: ?[]const []const u8,
    heartbeat_minutes: ?i64,
};
pub const Position = struct {
    title: []const u8,
    team_id: ?[]const u8,
    member_id: ?[]const u8,
    reports_to: ?[]const u8,
    is_manager: ?bool,
};
pub const Project = struct { key: []const u8, name: []const u8, team_id: ?[]const u8, repo: ?[]const u8 };
pub const Grant = struct { org_id: []const u8, permission: repo.Permission };
pub const Revoke = struct { org_id: []const u8 };

// ---- primitives ----

fn root(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!Map {
    const bytes = raw orelse return error.InvalidBody;
    const value = std.json.parseFromSliceLeaky(Value, arena, bytes, json.parse_options) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidBody,
    };
    return switch (value) {
        .object => |map| map,
        else => error.InvalidBody,
    };
}

fn known(key: []const u8, comptime allowed: []const []const u8) bool {
    inline for (allowed) |allowed_key| if (std.mem.eql(u8, key, allowed_key)) return true;
    return false;
}

/// `.strict()`: no key outside `allowed`.
fn onlyKeys(map: Map, comptime allowed: []const []const u8) Invalid!void {
    for (map.keys()) |key| if (!known(key, allowed)) return error.InvalidBody;
}

fn string(value: Value) Invalid![]const u8 {
    return switch (value) {
        .string => |text| text,
        else => error.InvalidBody,
    };
}

fn length(text: []const u8) Invalid!usize {
    return parity.codePoints(text) catch error.InvalidBody;
}

/// `z.string().min(min).max(max)`.
fn bounded(value: Value, min: usize, max: usize) Invalid![]const u8 {
    const text = try string(value);
    const len = try length(text);
    if (len < min or len > max) return error.InvalidBody;
    return text;
}

/// `title`: `z.string().trim().min(1).max(80)`.
fn title(value: Value) Invalid![]const u8 {
    const text = parity.jsTrim(try string(value));
    const len = try length(text);
    if (len < 1 or len > 80) return error.InvalidBody;
    return text;
}

/// `id`: `z.string().min(1).max(64)`.
fn id(value: Value) Invalid![]const u8 {
    return bounded(value, 1, 64);
}

fn handle(value: Value) Invalid![]const u8 {
    const text = try string(value);
    return if (repo.isHandle(text)) text else error.InvalidBody;
}

fn boolean(value: Value) Invalid!bool {
    return switch (value) {
        .bool => |flag| flag,
        else => error.InvalidBody,
    };
}

/// `z.number().int().min(1).max(10080)`: 5.0 is an integer in JS.
fn heartbeat(value: Value) Invalid!i64 {
    const n: f64 = switch (value) {
        .integer => |whole| @floatFromInt(whole),
        .float => |real| real,
        else => return error.InvalidBody,
    };
    if (!std.math.isFinite(n) or @floor(n) != n or n < 1 or n > 10080) return error.InvalidBody;
    return @intFromFloat(n);
}

fn role(value: Value) Invalid!repo.Role {
    return std.meta.stringToEnum(repo.Role, try string(value)) orelse error.InvalidBody;
}

/// `z.array(z.string().min(1).max(40)).max(20)`.
fn specialties(arena: Allocator, value: Value) (Allocator.Error || Invalid)![]const []const u8 {
    const items = switch (value) {
        .array => |list| list.items,
        else => return error.InvalidBody,
    };
    if (items.len > 20) return error.InvalidBody;
    const out = try arena.alloc([]const u8, items.len);
    for (items, out) |item, *slot| slot.* = try bounded(item, 1, 40);
    return out;
}

fn Checked(comptime check: anytype) type {
    return @typeInfo(@typeInfo(@TypeOf(check)).@"fn".return_type.?).error_union.payload;
}

fn optional(map: Map, key: []const u8, comptime check: anytype) Invalid!?Checked(check) {
    const value = map.get(key) orelse return null;
    return try check(value);
}

fn required(map: Map, key: []const u8, comptime check: anytype) Invalid!Checked(check) {
    return check(map.get(key) orelse return error.InvalidBody);
}

/// A patch field that may also be null (`.nullable().optional()`).
fn patch(comptime T: type, map: Map, key: []const u8, comptime check: anytype) Invalid!Opt(T) {
    const value = map.get(key) orelse return .unset;
    if (value == .null) return .clear;
    return .{ .set = try check(value) };
}

fn model(value: Value) Invalid![]const u8 {
    return bounded(value, 1, 120);
}

fn tag(value: Value) Invalid![]const u8 {
    return bounded(value, 1, 40);
}

/// Folds `InvalidBody` into null so a handler can still run its earlier checks first.
fn finish(comptime T: type, result: (Allocator.Error || Invalid)!T) Allocator.Error!?T {
    return result catch |err| switch (err) {
        error.InvalidBody => null,
        error.OutOfMemory => error.OutOfMemory,
    };
}

// ---- bodies ----

fn createOrgOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!CreateOrg {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "name", "slug" });
    return .{ .name = try required(map, "name", title), .slug = try required(map, "slug", handle) };
}
pub fn createOrg(arena: Allocator, raw: ?[]const u8) Allocator.Error!?CreateOrg {
    return finish(CreateOrg, createOrgOf(arena, raw));
}

fn nameOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!Name {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{"name"});
    return .{ .name = try required(map, "name", title) };
}
pub fn name(arena: Allocator, raw: ?[]const u8) Allocator.Error!?Name {
    return finish(Name, nameOf(arena, raw));
}

fn memberIdOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!MemberId {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{"memberId"});
    return .{ .member_id = try required(map, "memberId", id) };
}
pub fn memberId(arena: Allocator, raw: ?[]const u8) Allocator.Error!?MemberId {
    return finish(MemberId, memberIdOf(arena, raw));
}

fn email(arena: Allocator, value: Value) (Allocator.Error || Invalid)![]const u8 {
    return auth_body.normalizeEmail(arena, try string(value));
}

fn addHumanOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!AddHuman {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "email", "role", "name", "handle" });
    return .{
        .email = try email(arena, map.get("email") orelse return error.InvalidBody),
        .role = try required(map, "role", role),
        .name = try optional(map, "name", title),
        .handle = try optional(map, "handle", handle),
    };
}
pub fn addHuman(arena: Allocator, raw: ?[]const u8) Allocator.Error!?AddHuman {
    return finish(AddHuman, addHumanOf(arena, raw));
}

fn addAgentOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!AddAgent {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "agentId", "handle", "displayName", "model", "specialties", "heartbeatMinutes" });
    return .{
        .agent_id = try required(map, "agentId", id),
        .handle = try required(map, "handle", handle),
        .display_name = try required(map, "displayName", title),
        .model = try optional(map, "model", model),
        .specialties = if (map.get("specialties")) |value| try specialties(arena, value) else null,
        .heartbeat_minutes = try optional(map, "heartbeatMinutes", heartbeat),
    };
}
pub fn addAgent(arena: Allocator, raw: ?[]const u8) Allocator.Error!?AddAgent {
    return finish(AddAgent, addAgentOf(arena, raw));
}

fn memberPatchOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!repo.MemberPatch {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "displayName", "role", "model", "specialties", "heartbeatMinutes", "paused" });
    return .{
        .display_name = try optional(map, "displayName", title),
        .role = try optional(map, "role", role),
        .model = try patch([]const u8, map, "model", model),
        .specialties = if (map.get("specialties")) |value| try specialties(arena, value) else null,
        .heartbeat_minutes = try patch(i64, map, "heartbeatMinutes", heartbeat),
        .paused = try optional(map, "paused", boolean),
    };
}
pub fn memberPatch(arena: Allocator, raw: ?[]const u8) Allocator.Error!?repo.MemberPatch {
    return finish(repo.MemberPatch, memberPatchOf(arena, raw));
}

fn positionOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!Position {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "title", "teamId", "memberId", "reportsTo", "isManager" });
    return .{
        .title = try required(map, "title", title),
        .team_id = try optional(map, "teamId", id),
        .member_id = try optional(map, "memberId", id),
        .reports_to = try optional(map, "reportsTo", id),
        .is_manager = try optional(map, "isManager", boolean),
    };
}
pub fn position(arena: Allocator, raw: ?[]const u8) Allocator.Error!?Position {
    return finish(Position, positionOf(arena, raw));
}

fn positionPatchOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!repo.PositionPatch {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "title", "teamId", "memberId", "reportsTo", "isManager" });
    return .{
        .title = try optional(map, "title", title),
        .team_id = try patch([]const u8, map, "teamId", id),
        .member_id = try patch([]const u8, map, "memberId", id),
        .reports_to = try patch([]const u8, map, "reportsTo", id),
        .is_manager = try optional(map, "isManager", boolean),
    };
}
pub fn positionPatch(arena: Allocator, raw: ?[]const u8) Allocator.Error!?repo.PositionPatch {
    return finish(repo.PositionPatch, positionPatchOf(arena, raw));
}

/// `/^[A-Za-z0-9_-]+$/` over 1 to 16 characters.
fn projectKey(value: Value) Invalid![]const u8 {
    const text = try bounded(value, 1, 16);
    for (text) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '_' and ch != '-') return error.InvalidBody;
    return text;
}

fn repoPath(value: Value) Invalid![]const u8 {
    return bounded(value, 1, 1024);
}

fn projectOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!Project {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "key", "name", "teamId", "repo" });
    return .{
        .key = try required(map, "key", projectKey),
        .name = try required(map, "name", title),
        .team_id = try optional(map, "teamId", id),
        .repo = try optional(map, "repo", repoPath),
    };
}
pub fn project(arena: Allocator, raw: ?[]const u8) Allocator.Error!?Project {
    return finish(Project, projectOf(arena, raw));
}

fn permission(value: Value) Invalid!repo.Permission {
    return std.meta.stringToEnum(repo.Permission, try string(value)) orelse error.InvalidBody;
}

fn grantOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!Grant {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{ "orgId", "permission" });
    return .{ .org_id = try required(map, "orgId", id), .permission = try required(map, "permission", permission) };
}
pub fn grant(arena: Allocator, raw: ?[]const u8) Allocator.Error!?Grant {
    return finish(Grant, grantOf(arena, raw));
}

fn revokeOf(arena: Allocator, raw: ?[]const u8) (Allocator.Error || Invalid)!Revoke {
    const map = try root(arena, raw);
    try onlyKeys(map, &.{"orgId"});
    return .{ .org_id = try required(map, "orgId", id) };
}
pub fn revoke(arena: Allocator, raw: ?[]const u8) Allocator.Error!?Revoke {
    return finish(Revoke, revokeOf(arena, raw));
}

test {
    _ = @import("body_test.zig");
}
