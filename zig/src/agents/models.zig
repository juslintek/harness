//! Model lists: `refreshModels`, `probeModels`, `saveModels` and `parseAgyModels` of agents/api.ts.
//! The agent is the source of model ids; nothing is hard-coded and a failed probe keeps the old list.
const std = @import("std");
const app_mod = @import("../app.zig");
const parity = @import("../parity.zig");
const sqlite = @import("../db/sqlite.zig");
const runner_mod = @import("runner.zig");
const specs_mod = @import("specs.zig");

const App = app_mod.App;
const State = app_mod.State;
const Io = std.Io;

pub const Model = struct { id: []const u8, name: []const u8 };

const agy_models_timeout_ms: i64 = 5000;

/// `parseAgyModels`: `agy models` prints one model per line, id and display name separated by a tab.
pub fn parseAgy(arena: std.mem.Allocator, stdout: []const u8) std.mem.Allocator.Error![]const Model {
    var models: std.ArrayList(Model) = .empty;
    var lines = std.mem.splitScalar(u8, stdout, '\n');
    while (lines.next()) |line| {
        var parts = std.mem.splitScalar(u8, line, '\t');
        const id = parity.jsTrim(parts.first());
        const name = parity.jsTrim(parts.next() orelse "");
        if (id.len == 0 or std.mem.findAny(u8, id, " \t\r\n\x0b\x0c") != null) continue;
        try models.append(arena, .{ .id = id, .name = if (name.len > 0) name else id });
    }
    return models.items;
}

/// Starts a sandboxed ACP agent and asks for its models; wired by the runtimes slice.
pub const ListAcp = struct {
    ctx: *anyopaque,
    list_fn: *const fn (ctx: *anyopaque, arena: std.mem.Allocator, spec: *const specs_mod.Spec) anyerror![]const Model,
};

/// What `ModelsError` carries, plus the one failure that is not a `ModelsError`.
pub const Outcome = union(enum) {
    models: []const Model,
    /// 404, 409 or 502 with the message of the `ModelsError`.
    refused: struct { status: u16, message: []const u8 },
    /// Two models with one id: the primary key of `agent_models`, which TS lets through as a 409.
    conflict,
};

pub const Deps = struct {
    app: *App,
    specs: []const specs_mod.Spec,
    runner: runner_mod.Runner,
    list_acp: ?ListAcp,
};

const SaveArgs = struct { id: []const u8, models: []const Model, now: i64 };

fn saveLocked(args: *const SaveArgs, state: *State) sqlite.Error!void {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.Open };
    try db.transaction(args, saveInTransaction);
}

fn saveInTransaction(args: *const SaveArgs, db: sqlite.Db) sqlite.Error!void {
    {
        const delete = try db.prepare("DELETE FROM agent_models WHERE agent_id = ?");
        defer delete.finalize();
        try delete.bindText(1, args.id);
        _ = try delete.step();
    }
    const insert = try db.prepare("INSERT INTO agent_models (agent_id, model_id, name, fetched_at) VALUES (?, ?, ?, ?)");
    defer insert.finalize();
    for (args.models) |model| {
        try insert.reset();
        try insert.bindText(1, args.id);
        try insert.bindText(2, model.id);
        try insert.bindText(3, model.name);
        try insert.bindInt(4, args.now);
        _ = try insert.step();
    }
}

/// `saveModels`: replaces the stored list in one transaction.
pub fn save(app: *App, id: []const u8, models: []const Model, now: i64) sqlite.Error!void {
    return app.withLock(&SaveArgs{ .id = id, .models = models, .now = now }, saveLocked);
}

fn refuse(status: u16, message: []const u8) Outcome {
    return .{ .refused = .{ .status = status, .message = message } };
}

/// `probeModels`. Strings are allocated in `arena`.
pub fn probe(arena: std.mem.Allocator, deps: Deps, id: []const u8, now: i64) !Outcome {
    const spec = specs_mod.find(deps.specs, id) orelse return refuse(404, "unknown agent");
    const listed: []const Model = switch (spec.lane) {
        .agy => blk: {
            const out = deps.runner.run(arena, &.{ "agy", "models" }, agy_models_timeout_ms, &.{}) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.Canceled => return error.Canceled,
                error.TimedOut => return refuse(502, try std.fmt.allocPrint(arena, "timed out after {d} ms", .{agy_models_timeout_ms})),
            };
            if (out.code != 0) {
                const stderr = parity.jsTrim(out.stderr);
                return refuse(502, if (stderr.len > 0) stderr else try std.fmt.allocPrint(arena, "agy models exited with {d}", .{out.code}));
            }
            break :blk try parseAgy(arena, out.stdout);
        },
        .acp => blk: {
            const list_acp = deps.list_acp orelse return refuse(502, "ACP model listing is not wired");
            break :blk list_acp.list_fn(list_acp.ctx, arena, spec) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return refuse(502, @errorName(err)),
            };
        },
        .api => return refuse(409, try std.fmt.allocPrint(arena, "{s} has no model list to refresh", .{spec.name})),
    };
    if (listed.len == 0) return refuse(502, "the agent returned no models");
    save(deps.app, id, listed, now) catch |err| switch (err) {
        error.Constraint => return .conflict,
        else => return err,
    };
    return .{ .models = listed };
}

/// A probe starts a sandboxed agent, so concurrent requests for one agent share a single probe.
pub const Flights = struct {
    mutex: Io.Mutex = .init,
    map: std.StringHashMapUnmanaged(*Flight) = .empty,

    const Flight = struct {
        gpa: std.mem.Allocator,
        id: []u8,
        done: Io.Event = .unset,
        refs: u32 = 1,
        /// Set before `done`; null when the leader could not copy its outcome.
        outcome: ?Owned = null,
    };

    /// A copy of an `Outcome` on its own arena, which waiters read while the leader moves on.
    const Owned = struct {
        arena: std.heap.ArenaAllocator,
        outcome: Outcome,

        fn init(gpa: std.mem.Allocator, outcome: Outcome) std.mem.Allocator.Error!Owned {
            var arena: std.heap.ArenaAllocator = .init(gpa);
            errdefer arena.deinit();
            // The arena is copied into the result after the copy is made: it carries its own state.
            const owned = try copy(arena.allocator(), outcome);
            return .{ .arena = arena, .outcome = owned };
        }
    };

    fn copy(into: std.mem.Allocator, outcome: Outcome) std.mem.Allocator.Error!Outcome {
        switch (outcome) {
            .models => |models| {
                const out = try into.alloc(Model, models.len);
                for (models, out) |model, *slot| slot.* = .{ .id = try into.dupe(u8, model.id), .name = try into.dupe(u8, model.name) };
                return .{ .models = out };
            },
            .refused => |refused| return .{ .refused = .{ .status = refused.status, .message = try into.dupe(u8, refused.message) } },
            .conflict => return .conflict,
        }
    }

    pub fn deinit(self: *Flights, gpa: std.mem.Allocator) void {
        std.debug.assert(self.map.count() == 0);
        self.map.deinit(gpa);
    }

    fn release(self: *Flights, io: Io, flight: *Flight) void {
        self.mutex.lockUncancelable(io);
        flight.refs -= 1;
        const last = flight.refs == 0;
        self.mutex.unlock(io);
        if (!last) return;
        if (flight.outcome) |*owned| owned.arena.deinit();
        const gpa = flight.gpa;
        gpa.free(flight.id);
        gpa.destroy(flight);
    }

    /// `refreshModels`: the first caller for an id probes, the callers that arrive while it runs
    /// get its outcome. `gpa` must be thread safe.
    pub fn refresh(self: *Flights, gpa: std.mem.Allocator, io: Io, arena: std.mem.Allocator, deps: Deps, id: []const u8, now: i64) !Outcome {
        self.mutex.lockUncancelable(io);
        if (self.map.get(id)) |running| {
            running.refs += 1;
            self.mutex.unlock(io);
            defer self.release(io, running);
            try running.done.wait(io);
            const shared = running.outcome orelse return error.OutOfMemory;
            return copy(arena, shared.outcome);
        }
        const flight = gpa.create(Flight) catch |err| {
            self.mutex.unlock(io);
            return err;
        };
        flight.* = .{ .gpa = gpa, .id = gpa.dupe(u8, id) catch |err| {
            self.mutex.unlock(io);
            gpa.destroy(flight);
            return err;
        } };
        self.map.put(gpa, flight.id, flight) catch |err| {
            self.mutex.unlock(io);
            gpa.free(flight.id);
            gpa.destroy(flight);
            return err;
        };
        self.mutex.unlock(io);

        defer {
            self.mutex.lockUncancelable(io);
            _ = self.map.remove(flight.id);
            self.mutex.unlock(io);
            flight.done.set(io);
            self.release(io, flight);
        }
        const outcome = try probe(arena, deps, id, now);
        flight.outcome = Owned.init(gpa, outcome) catch null;
        return outcome;
    }
};

const testing = std.testing;

test "agents: agy output is parsed like parseAgyModels" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const models = try parseAgy(arena.allocator(), "Fetching available models...\ngemini-x-low\tGemini X Low\nplain-id\n\n  spaced\t  Spaced Name  \r\n");
    try testing.expectEqual(@as(usize, 3), models.len);
    try testing.expectEqualStrings("gemini-x-low", models[0].id);
    try testing.expectEqualStrings("Gemini X Low", models[0].name);
    try testing.expectEqualStrings("plain-id", models[1].name);
    try testing.expectEqualStrings("spaced", models[2].id);
    try testing.expectEqualStrings("Spaced Name", models[2].name);
    try testing.expectEqual(@as(usize, 0), (try parseAgy(arena.allocator(), "")).len);
}

const Fx = struct {
    fx: *@import("../auth/fixture.zig").Fixture,
    table: []const specs_mod.Spec,
    arena: std.heap.ArenaAllocator,
    agy_out: runner_mod.Out = .{ .code = 0, .stdout = "", .stderr = "" },
    acp_calls: std.atomic.Value(u32) = .init(0),
    acp_gate: Io.Event = .is_set,

    fn create() !*Fx {
        const self = try testing.allocator.create(Fx);
        errdefer testing.allocator.destroy(self);
        self.* = .{ .fx = try @import("../auth/fixture.zig").Fixture.create(testing.allocator, testing.io), .table = &.{}, .arena = .init(testing.allocator) };
        errdefer self.fx.destroy();
        errdefer self.arena.deinit();
        self.table = try specs_mod.builtin(self.arena.allocator(), .{ .adapter_dir = "/a", .home = "/h" });
        return self;
    }

    fn destroy(self: *Fx) void {
        self.fx.destroy();
        self.arena.deinit();
        testing.allocator.destroy(self);
    }

    fn runAgy(ctx: *anyopaque, _: std.mem.Allocator, argv: []const []const u8, _: i64, _: []const specs_mod.EnvPair) runner_mod.Error!runner_mod.Out {
        const self: *Fx = @ptrCast(@alignCast(ctx));
        std.debug.assert(std.mem.eql(u8, argv[1], "models"));
        return self.agy_out;
    }

    fn listAcp(ctx: *anyopaque, arena: std.mem.Allocator, _: *const specs_mod.Spec) anyerror![]const Model {
        const self: *Fx = @ptrCast(@alignCast(ctx));
        _ = self.acp_calls.fetchAdd(1, .monotonic);
        self.acp_gate.waitUncancelable(testing.io);
        return arena.dupe(Model, &.{.{ .id = "m1", .name = "M1" }});
    }

    fn deps(self: *Fx, with_acp: bool) Deps {
        return .{
            .app = &self.fx.app,
            .specs = self.table,
            .runner = .{ .ctx = self, .run_fn = runAgy },
            .list_acp = if (with_acp) .{ .ctx = self, .list_fn = listAcp } else null,
        };
    }

    fn stored(self: *Fx, id: []const u8) !usize {
        const stmt = try self.fx.db.prepare("SELECT count(*) FROM agent_models WHERE agent_id = ?");
        defer stmt.finalize();
        try stmt.bindText(1, id);
        _ = try stmt.step();
        return @intCast(stmt.int(0));
    }
};

test "agents: an agy refresh is saved and a failure keeps the old list" {
    const fx = try Fx.create();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try save(&fx.fx.app, "agy", &.{.{ .id = "old", .name = "Old" }}, 1);

    fx.agy_out = .{ .code = 0, .stdout = "Fetching available models...\ngemini-x-low\tGemini X Low\nplain-id\n\n", .stderr = "" };
    const ok = try probe(a, fx.deps(false), "agy", 5);
    try testing.expectEqual(@as(usize, 2), ok.models.len);
    try testing.expectEqualStrings("Gemini X Low", ok.models[0].name);
    try testing.expectEqual(@as(usize, 2), try fx.stored("agy"));

    fx.agy_out = .{ .code = 1, .stdout = "", .stderr = " Error: please sign in\n" };
    const failed = try probe(a, fx.deps(false), "agy", 6);
    try testing.expectEqual(@as(u16, 502), failed.refused.status);
    try testing.expectEqualStrings("Error: please sign in", failed.refused.message);
    fx.agy_out = .{ .code = 3, .stdout = "", .stderr = "" };
    try testing.expectEqualStrings("agy models exited with 3", (try probe(a, fx.deps(false), "agy", 6)).refused.message);
    fx.agy_out = .{ .code = 0, .stdout = "\n", .stderr = "" };
    const empty = try probe(a, fx.deps(false), "agy", 7);
    try testing.expectEqualStrings("the agent returned no models", empty.refused.message);
    try testing.expectEqual(@as(usize, 2), try fx.stored("agy"));
}

test "agents: unknown agents, api lane and unwired ACP are refused as in TS" {
    const fx = try Fx.create();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const unknown = try probe(a, fx.deps(true), "nope", 1);
    try testing.expectEqual(@as(u16, 404), unknown.refused.status);
    try testing.expectEqualStrings("unknown agent", unknown.refused.message);
    const unwired = try probe(a, fx.deps(false), "claude", 1);
    try testing.expectEqual(@as(u16, 502), unwired.refused.status);
    try testing.expectEqualStrings("ACP model listing is not wired", unwired.refused.message);
    const listed = try probe(a, fx.deps(true), "claude", 1);
    try testing.expectEqualStrings("m1", listed.models[0].id);

    const api_spec = [_]specs_mod.Spec{blk: {
        var spec = fx.table[0];
        spec.id = "http";
        spec.name = "HTTP";
        spec.lane = .api;
        break :blk spec;
    }};
    var deps = fx.deps(true);
    deps.specs = &api_spec;
    const api = try probe(a, deps, "http", 1);
    try testing.expectEqual(@as(u16, 409), api.refused.status);
    try testing.expectEqualStrings("HTTP has no model list to refresh", api.refused.message);
}

test "agents: two models with one id are a conflict and keep the old list" {
    const fx = try Fx.create();
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try save(&fx.fx.app, "agy", &.{.{ .id = "old", .name = "Old" }}, 1);
    fx.agy_out = .{ .code = 0, .stdout = "same\tA\nsame\tB\n", .stderr = "" };
    try testing.expect(try probe(arena.allocator(), fx.deps(false), "agy", 2) == .conflict);
    try testing.expectEqual(@as(usize, 1), try fx.stored("agy"));
}

test "agents: concurrent refreshes of one agent share a single probe" {
    const fx = try Fx.create();
    defer fx.destroy();
    fx.acp_gate = .unset;
    var flights: Flights = .{};
    defer flights.deinit(testing.allocator);

    const Caller = struct {
        fn run(flights_ptr: *Flights, fx_ptr: *Fx, out: *u16) void {
            var arena: std.heap.ArenaAllocator = .init(testing.allocator);
            defer arena.deinit();
            const outcome = flights_ptr.refresh(testing.allocator, testing.io, arena.allocator(), fx_ptr.deps(true), "claude", 1) catch {
                out.* = 500;
                return;
            };
            out.* = if (outcome == .models and std.mem.eql(u8, outcome.models[0].id, "m1")) 200 else 500;
        }
    };
    var statuses: [2]u16 = .{ 0, 0 };
    const first = try std.Thread.spawn(.{}, Caller.run, .{ &flights, fx, &statuses[0] });
    // The second caller must find the first one's flight, so wait until it is registered.
    while (true) {
        flights.mutex.lockUncancelable(testing.io);
        const registered = flights.map.count() == 1;
        flights.mutex.unlock(testing.io);
        if (registered) break;
        try testing.io.sleep(.fromMilliseconds(1), .awake);
    }
    const second = try std.Thread.spawn(.{}, Caller.run, .{ &flights, fx, &statuses[1] });
    while (true) {
        flights.mutex.lockUncancelable(testing.io);
        const joined = if (flights.map.get("claude")) |flight| flight.refs == 2 else false;
        flights.mutex.unlock(testing.io);
        if (joined) break;
        try testing.io.sleep(.fromMilliseconds(1), .awake);
    }
    fx.acp_gate.set(testing.io);
    first.join();
    second.join();
    try testing.expectEqual([2]u16{ 200, 200 }, statuses);
    try testing.expectEqual(@as(u32, 1), fx.acp_calls.load(.monotonic));

    // The flight is gone with its callers: the next refresh probes again.
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    _ = try flights.refresh(testing.allocator, testing.io, arena.allocator(), fx.deps(true), "claude", 2);
    try testing.expectEqual(@as(u32, 2), fx.acp_calls.load(.monotonic));
}
