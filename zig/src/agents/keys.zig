//! API keys of the HTTP agent lanes: code/src/server/features/agents/keys.ts. The store is
//! `<home>/secrets.json` (a flat JSON object, mode 0600 in a 0700 home), written through a temp
//! file in the same directory that is fsynced before the rename. Old keys in the login Keychain
//! are moved into the file once per process, because an agent inside srt can run `security` on them.
const std = @import("std");
const builtin = @import("builtin");
const runner_mod = @import("runner.zig");
const specs_mod = @import("specs.zig");

const Io = std.Io;
const Runner = runner_mod.Runner;

pub const Provider = enum { anthropic, openai, gemini, openrouter };
pub const providers = [_]Provider{ .anthropic, .openai, .gemini, .openrouter };

pub fn envName(provider: Provider) []const u8 {
    return switch (provider) {
        .anthropic => "ANTHROPIC_API_KEY",
        .openai => "OPENAI_API_KEY",
        .gemini => "GEMINI_API_KEY",
        .openrouter => "OPENROUTER_API_KEY",
    };
}

/// Service name of the old Keychain items.
const legacy_service = "harness";
const store_name = "secrets.json";

/// A refusal that TS throws as a plain `Error`, which `routeError` answers as 400 with the message.
/// The text never contains anything read from the file: parse errors there can quote a hand-typed key.
pub const Failure = error{StoreRefused};

pub const Diag = struct {
    message: []const u8 = "",
};

pub const Source = enum { env, file };

pub const Status = struct {
    provider: Provider,
    source: ?Source,
    legacy_left: bool,
};

pub const Store = struct {
    gpa: std.mem.Allocator,
    io: Io,
    /// The harness home; outlives the store.
    home: []const u8,
    env: *const std.process.Environ.Map,
    runner: Runner,
    probe_timeout_ms: i64 = 5000,
    /// Read-modify-write, so writes are serialized to keep two stores from dropping each other's key.
    write_mutex: Io.Mutex = .init,
    /// Held across the whole migration, which also makes concurrent callers wait for one attempt.
    migrate_mutex: Io.Mutex = .init,
    migrated: bool = false,
    left: [providers.len]bool = @splat(false),
    /// Read and set from pool threads, so only through `claimWarning`.
    warned: [providers.len]std.atomic.Value(bool) = @splat(.init(false)),

    const Entries = std.StringArrayHashMapUnmanaged([]const u8);

    fn storePath(self: *const Store, arena: std.mem.Allocator) std.mem.Allocator.Error![]const u8 {
        return std.fs.path.join(arena, &.{ self.home, store_name });
    }

    fn refuse(self: *const Store, arena: std.mem.Allocator, diag: *Diag, comptime what: []const u8) (Failure || std.mem.Allocator.Error) {
        diag.message = try std.fmt.allocPrint(arena, "{s} " ++ what, .{try self.storePath(arena)});
        return error.StoreRefused;
    }

    /// `readStore`: a missing file is an empty store; anything else that is not a flat object of
    /// strings is refused.
    fn readStore(self: *Store, arena: std.mem.Allocator, diag: *Diag) !Entries {
        var entries: Entries = .empty;
        const path = try self.storePath(arena);
        const text = Io.Dir.cwd().readFileAlloc(self.io, path, arena, .limited(16 * 1024 * 1024)) catch |err| switch (err) {
            error.FileNotFound => return entries,
            else => return err,
        };
        const options: std.json.ParseOptions = .{ .duplicate_field_behavior = .use_last };
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, text, options) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return self.refuse(arena, diag, "is not valid JSON"),
        };
        const object = switch (parsed) {
            .object => |object| object,
            else => return self.refuse(arena, diag, "has an unexpected shape"),
        };
        for (object.keys(), object.values()) |key, value| switch (value) {
            .string => |string| try entries.put(arena, key, string),
            else => return self.refuse(arena, diag, "has an unexpected shape"),
        };
        return entries;
    }

    fn syncDir(self: *Store, dir: Io.Dir) !void {
        const as_file: Io.File = .{ .handle = dir.handle, .flags = .{ .nonblocking = false } };
        try as_file.sync(self.io);
    }

    /// Temp file in the same directory (same filesystem, also covered by the secrets.* deny), fsynced
    /// before the rename so a crash leaves either the old file or the new one.
    fn writeStore(self: *Store, arena: std.mem.Allocator, next: *const Entries) !void {
        const io = self.io;
        const cwd = Io.Dir.cwd();
        _ = try cwd.createDirPathStatus(io, self.home, .fromMode(0o700));
        var dir = try cwd.openDir(io, self.home, .{ .iterate = true });
        defer dir.close(io);
        try dir.setPermissions(io, .fromMode(0o700));

        var out: Io.Writer.Allocating = .init(arena);
        try out.writer.writeByte('{');
        for (next.keys(), next.values(), 0..) |key, value, index| {
            if (index > 0) try out.writer.writeByte(',');
            try std.json.Stringify.encodeJsonString(key, .{}, &out.writer);
            try out.writer.writeByte(':');
            try std.json.Stringify.encodeJsonString(value, .{}, &out.writer);
        }
        try out.writer.writeByte('}');

        var random: [16]u8 = undefined;
        try io.randomSecure(&random);
        const tmp = try std.fmt.allocPrint(arena, "{s}.{d}.{x}.tmp", .{ store_name, std.c.getpid(), &random });
        const file = try dir.createFile(io, tmp, .{ .exclusive = true, .permissions = .fromMode(0o600) });
        {
            errdefer {
                file.close(io);
                dir.deleteFile(io, tmp) catch {};
            }
            try file.writeStreamingAll(io, out.written());
            try file.sync(io);
        }
        file.close(io);
        dir.rename(tmp, dir, store_name, io) catch |err| {
            dir.deleteFile(io, tmp) catch {};
            return err;
        };
        try self.syncDir(dir);

        // Time Machine would copy the plaintext file to a backup disk. The exclusion is a per-file
        // xattr that needs no admin rights; a failure is logged and never blocks the write.
        const path = try self.storePath(arena);
        const excluded = self.runner.run(arena, &.{ "tmutil", "addexclusion", path }, self.probe_timeout_ms, &.{}) catch |err| {
            if (!builtin.is_test) std.log.warn("could not exclude secrets.json from backups: {t}", .{err});
            return;
        };
        if (excluded.code != 0 and !builtin.is_test) std.log.warn("could not exclude secrets.json from backups: tmutil exited with {d}", .{excluded.code});
    }

    /// `updateStore`: with `only_if_missing` the check and the write share one lock hold, so a key
    /// saved meanwhile is not overwritten. True when the key was written.
    fn updateStore(self: *Store, arena: std.mem.Allocator, diag: *Diag, provider: Provider, key: []const u8, only_if_missing: bool) !bool {
        self.write_mutex.lockUncancelable(self.io);
        defer self.write_mutex.unlock(self.io);
        var current = try self.readStore(arena, diag);
        if (only_if_missing) if (current.get(@tagName(provider))) |existing| if (existing.len > 0) return false;
        try current.put(arena, @tagName(provider), key);
        try self.writeStore(arena, &current);
        return true;
    }

    fn readLegacy(self: *Store, arena: std.mem.Allocator, provider: Provider) !?[]const u8 {
        // Raw bytes: the line reader would trim the value and drop a blank one, and the original
        // is deleted from the Keychain once the stored copy matches.
        const out = self.run(arena, true, &.{ "security", "find-generic-password", "-s", legacy_service, "-a", @tagName(provider), "-w" });
        if (out.code != 0) return null;
        // `replace(/\n$/, "")`: one newline, not all of them.
        const value = if (std.mem.endsWith(u8, out.stdout, "\n")) out.stdout[0 .. out.stdout.len - 1] else out.stdout;
        return if (value.len > 0) value else null;
    }

    /// `spawnBounded`: a locked Keychain can prompt forever, so every call is bounded and a
    /// missing `security` reads as "no key".
    fn run(self: *Store, arena: std.mem.Allocator, raw: bool, argv: []const []const u8) runner_mod.Out {
        const runner = if (raw) &Runner.runRaw else &Runner.run;
        return runner(self.runner, arena, argv, self.probe_timeout_ms, &.{}) catch |err| switch (err) {
            error.TimedOut => .{ .code = runner_mod.timed_out_code, .stdout = "", .stderr = "" },
            else => .{ .code = runner_mod.not_found_code, .stdout = "", .stderr = "" },
        };
    }

    /// `migrateLegacy`: copy if the store lacks the key and check the copy reads back; the Keychain
    /// item is deleted only while the store holds the same value, so a failed delete is retried on
    /// the next start and a different value in the store leaves the old item alone (it may be a
    /// user's valid key). A failure before the delete never deletes. Returns the providers whose
    /// old item is still in the Keychain.
    fn migrateLegacy(self: *Store, arena: std.mem.Allocator, diag: *Diag) ![providers.len]bool {
        var left: [providers.len]bool = @splat(false);
        for (providers, 0..) |provider, index| {
            const legacy = try self.readLegacy(arena, provider) orelse continue;
            const written = try self.updateStore(arena, diag, provider, legacy, true);
            const stored = (try self.readStore(arena, diag)).get(@tagName(provider));
            const same = if (stored) |value| std.mem.eql(u8, value, legacy) else false;
            if (written and !same) {
                diag.message = try std.fmt.allocPrint(arena, "could not migrate the {t} key", .{provider});
                return error.StoreRefused;
            }
            if (!same) {
                left[index] = true;
                continue;
            }
            const deleted = self.run(arena, false, &.{ "security", "delete-generic-password", "-s", legacy_service, "-a", @tagName(provider) });
            if (deleted.code != 0) left[index] = true;
        }
        return left;
    }

    /// Once per process; a failed attempt is retried on the next call.
    fn ready(self: *Store, arena: std.mem.Allocator, diag: *Diag) ![providers.len]bool {
        self.migrate_mutex.lockUncancelable(self.io);
        defer self.migrate_mutex.unlock(self.io);
        if (!self.migrated) {
            self.left = try self.migrateLegacy(arena, diag);
            self.migrated = true;
        }
        return self.left;
    }

    fn claimWarning(self: *Store, index: usize) bool {
        return !self.warned[index].swap(true, .acq_rel);
    }

    fn fromEnv(self: *const Store, provider: Provider) ?[]const u8 {
        const value = self.env.get(envName(provider)) orelse return null;
        return if (value.len > 0) value else null;
    }

    fn fromStore(self: *Store, arena: std.mem.Allocator, diag: *Diag, provider: Provider) !?[]const u8 {
        _ = try self.ready(arena, diag);
        const value = (try self.readStore(arena, diag)).get(@tagName(provider)) orelse return null;
        return if (value.len > 0) value else null;
    }

    /// `keyStatus`. An old Keychain item that is still there is logged once per process.
    pub fn status(self: *Store, arena: std.mem.Allocator, diag: *Diag) ![]const Status {
        const left = try self.ready(arena, diag);
        for (providers, left, 0..) |provider, still_there, index| {
            if (!still_there or !self.claimWarning(index)) continue;
            if (!builtin.is_test) std.log.warn("keys: {t} an old key is still in the login keychain: delete it by hand", .{provider});
        }
        const result = try arena.alloc(Status, providers.len);
        var stored: ?Entries = null;
        for (providers, left, result) |provider, still_there, *slot| {
            slot.* = .{ .provider = provider, .source = null, .legacy_left = still_there };
            if (self.fromEnv(provider) != null) {
                slot.source = .env;
                continue;
            }
            if (stored == null) stored = try self.readStore(arena, diag);
            if (stored.?.get(@tagName(provider))) |value| if (value.len > 0) {
                slot.source = .file;
            };
        }
        return result;
    }

    /// `getKey`: the environment first, then the store.
    pub fn get(self: *Store, arena: std.mem.Allocator, diag: *Diag, provider: Provider) !?[]const u8 {
        return self.fromEnv(provider) orelse try self.fromStore(arena, diag, provider);
    }

    /// `storeKey`. The route only lets printable ASCII through; the check here is the one of keys.ts
    /// for the control characters.
    pub fn put(self: *Store, arena: std.mem.Allocator, diag: *Diag, provider: Provider, key: []const u8) !void {
        for (key) |byte| if (byte < 0x20 or byte == 0x7f) {
            diag.message = "key must be printable text on a single line";
            return error.StoreRefused;
        };
        _ = try self.updateStore(arena, diag, provider, key, false);
    }
};

const testing = std.testing;

/// `security` and `tmutil` as a test double: never the real Keychain.
const FakeTools = struct {
    legacy: [providers.len]?[]const u8 = @splat(null),
    delete_code: i32 = 0,
    tmutil_code: i32 = 0,
    tmutil_calls: usize = 0,
    tmutil_path: ?[]const u8 = null,
    deletes: usize = 0,

    fn runner(self: *FakeTools) Runner {
        return .{ .ctx = self, .run_fn = run };
    }

    fn run(ctx: *anyopaque, arena: std.mem.Allocator, argv: []const []const u8, _: i64, _: []const specs_mod.EnvPair) runner_mod.Error!runner_mod.Out {
        const self: *FakeTools = @ptrCast(@alignCast(ctx));
        if (std.mem.eql(u8, argv[0], "tmutil")) {
            self.tmutil_calls += 1;
            self.tmutil_path = try arena.dupe(u8, argv[2]);
            return .{ .code = self.tmutil_code, .stdout = "", .stderr = "" };
        }
        std.debug.assert(std.mem.eql(u8, argv[0], "security"));
        const provider = std.meta.stringToEnum(Provider, argv[5]).?;
        const slot = &self.legacy[@backingInt(provider)];
        if (std.mem.eql(u8, argv[1], "find-generic-password")) {
            const value = slot.* orelse return .{ .code = 44, .stdout = "", .stderr = "" };
            return .{ .code = 0, .stdout = try std.fmt.allocPrint(arena, "{s}\n", .{value}), .stderr = "" };
        }
        self.deletes += 1;
        if (self.delete_code == 0) slot.* = null;
        return .{ .code = self.delete_code, .stdout = "", .stderr = "" };
    }
};

const Fx = struct {
    tmp: testing.TmpDir,
    home: []u8,
    env: std.process.Environ.Map,
    tools: FakeTools = .{},
    store: Store,

    /// On the heap: the store points at the fixture's own fields.
    fn create(env_pairs: []const [2][]const u8) !*Fx {
        const self = try testing.allocator.create(Fx);
        errdefer testing.allocator.destroy(self);
        self.tmp = testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        var buf: [Io.Dir.max_path_bytes]u8 = undefined;
        const real = buf[0..try self.tmp.dir.realPath(testing.io, &buf)];
        self.home = try std.fmt.allocPrint(testing.allocator, "{s}/home", .{real});
        errdefer testing.allocator.free(self.home);
        self.env = std.process.Environ.Map.init(testing.allocator);
        errdefer self.env.deinit();
        for (env_pairs) |pair| try self.env.put(pair[0], pair[1]);
        self.tools = .{};
        self.store = .{ .gpa = testing.allocator, .io = testing.io, .home = self.home, .env = &self.env, .runner = self.tools.runner() };
        return self;
    }

    fn destroy(self: *Fx) void {
        self.env.deinit();
        testing.allocator.free(self.home);
        self.tmp.cleanup();
        testing.allocator.destroy(self);
    }

    fn secrets(self: *Fx, arena: std.mem.Allocator) ![]u8 {
        const path = try std.fmt.allocPrint(arena, "{s}/secrets.json", .{self.home});
        return Io.Dir.cwd().readFileAlloc(testing.io, path, arena, .limited(1 << 20));
    }

    fn write(self: *Fx, text: []const u8) !void {
        try Io.Dir.cwd().createDirPath(testing.io, self.home);
        var dir = try Io.Dir.cwd().openDir(testing.io, self.home, .{});
        defer dir.close(testing.io);
        try dir.writeFile(testing.io, .{ .sub_path = "secrets.json", .data = text });
    }
};

const secret = "sk-test-0123456789abcdefghij";

test "agents: a stored key is written atomically with mode 0600 in a 0700 home" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var diag: Diag = .{};
    try fx.store.put(arena.allocator(), &diag, .openai, secret);
    try testing.expectEqualStrings("{\"openai\":\"" ++ secret ++ "\"}", try fx.secrets(arena.allocator()));

    var home = try Io.Dir.cwd().openDir(testing.io, fx.home, .{ .iterate = true });
    defer home.close(testing.io);
    try testing.expectEqual(@as(u32, 0o700), (try home.stat(testing.io)).permissions.toMode() & 0o777);
    const file_stat = try home.statFile(testing.io, "secrets.json", .{});
    try testing.expectEqual(@as(u32, 0o600), file_stat.permissions.toMode() & 0o777);
    // No temp file is left behind.
    var names: usize = 0;
    var it = home.iterate();
    while (try it.next(testing.io)) |entry| {
        try testing.expectEqualStrings("secrets.json", entry.name);
        names += 1;
    }
    try testing.expectEqual(@as(usize, 1), names);
    try testing.expectEqualStrings(try std.fmt.allocPrint(arena.allocator(), "{s}/secrets.json", .{fx.home}), fx.tools.tmutil_path.?);
}

test "agents: an existing loose home is tightened to 0700 and the file is replaced at 0600" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try fx.write("{\"gemini\":\"old-key-0123456789abcd\"}");
    var home = try Io.Dir.cwd().openDir(testing.io, fx.home, .{ .iterate = true });
    defer home.close(testing.io);
    try home.setPermissions(testing.io, .fromMode(0o755));
    var diag: Diag = .{};
    try fx.store.put(arena.allocator(), &diag, .openai, secret);
    try testing.expectEqual(@as(u32, 0o700), (try home.stat(testing.io)).permissions.toMode() & 0o777);
    try testing.expectEqual(@as(u32, 0o600), (try home.statFile(testing.io, "secrets.json", .{})).permissions.toMode() & 0o777);
    // The other key stays, in its place, and the new one is appended.
    try testing.expectEqualStrings("{\"gemini\":\"old-key-0123456789abcd\",\"openai\":\"" ++ secret ++ "\"}", try fx.secrets(arena.allocator()));
    try fx.store.put(arena.allocator(), &diag, .gemini, "new-key-0123456789abcdef");
    try testing.expectEqualStrings("{\"gemini\":\"new-key-0123456789abcdef\",\"openai\":\"" ++ secret ++ "\"}", try fx.secrets(arena.allocator()));
}

test "agents: a failing tmutil does not fail the write" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    fx.tools.tmutil_code = 1;
    var diag: Diag = .{};
    try fx.store.put(arena.allocator(), &diag, .gemini, "second-key-0123456789");
    try testing.expectEqual(@as(usize, 1), fx.tools.tmutil_calls);
    try testing.expect(std.mem.find(u8, try fx.secrets(arena.allocator()), "\"gemini\"") != null);
}

test "agents: a malformed store never puts its content into the message" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const leak = "AIzaSyD0123456789abcdefXYZ";
    var diag: Diag = .{};
    try fx.write("{\"gemini\":" ++ leak ++ "}");
    try testing.expectError(error.StoreRefused, fx.store.get(arena.allocator(), &diag, .gemini));
    try testing.expect(std.mem.endsWith(u8, diag.message, "/home/secrets.json is not valid JSON"));
    try testing.expect(std.mem.find(u8, diag.message, leak) == null);
    try fx.write("{\"gemini\":[\"" ++ leak ++ "\"]}");
    try testing.expectError(error.StoreRefused, fx.store.put(arena.allocator(), &diag, .openai, secret));
    try testing.expect(std.mem.endsWith(u8, diag.message, "/home/secrets.json has an unexpected shape"));
    try testing.expect(std.mem.find(u8, diag.message, leak) == null);
    for ([_][]const u8{ "[]", "\"x\"", "null", "{\"a\":1}" }) |text| {
        try fx.write(text);
        try testing.expectError(error.StoreRefused, fx.store.put(arena.allocator(), &diag, .openai, secret));
    }
}

test "agents: status reports env, file and nothing, and an empty variable counts as unset" {
    const fx = try Fx.create(&.{ .{ "ANTHROPIC_API_KEY", "from-env" }, .{ "OPENAI_API_KEY", "" } });
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var diag: Diag = .{};
    try fx.write("{\"openai\":\"filed\",\"gemini\":\"\"}");
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expectEqual(Source.env, status[0].source.?);
    try testing.expectEqual(Source.file, status[1].source.?);
    try testing.expect(status[2].source == null);
    try testing.expect(status[3].source == null);
    try testing.expectEqualStrings("from-env", (try fx.store.get(arena.allocator(), &diag, .anthropic)).?);
    try testing.expectEqualStrings("filed", (try fx.store.get(arena.allocator(), &diag, .openai)).?);
    try testing.expect(try fx.store.get(arena.allocator(), &diag, .gemini) == null);
}

test "agents: a store that is not read when every key comes from the environment" {
    const fx = try Fx.create(&.{ .{ "ANTHROPIC_API_KEY", "a" }, .{ "OPENAI_API_KEY", "b" }, .{ "GEMINI_API_KEY", "c" }, .{ "OPENROUTER_API_KEY", "d" } });
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var diag: Diag = .{};
    try fx.write("garbage");
    const status = try fx.store.status(arena.allocator(), &diag);
    for (status) |entry| try testing.expectEqual(Source.env, entry.source.?);
}

test "agents: a legacy Keychain key moves into the store and its item is deleted" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    fx.tools.legacy[@backingInt(Provider.gemini)] = "legacy-key-0123456789abc";
    var diag: Diag = .{};
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expectEqual(Source.file, status[2].source.?);
    try testing.expect(!status[2].legacy_left);
    try testing.expect(fx.tools.legacy[@backingInt(Provider.gemini)] == null);
    try testing.expectEqualStrings("{\"gemini\":\"legacy-key-0123456789abc\"}", try fx.secrets(arena.allocator()));
    // Once per process: a later call asks the Keychain nothing.
    fx.tools.legacy[@backingInt(Provider.openai)] = "late";
    _ = try fx.store.status(arena.allocator(), &diag);
    try testing.expect(fx.tools.legacy[@backingInt(Provider.openai)] != null);
}

test "agents: a legacy key that differs from the stored one is left alone" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try fx.write("{\"openai\":\"the-stored-key-0123456789\"}");
    fx.tools.legacy[@backingInt(Provider.openai)] = "an-older-key-0123456789";
    var diag: Diag = .{};
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expect(status[1].legacy_left);
    try testing.expectEqual(@as(usize, 0), fx.tools.deletes);
    try testing.expectEqualStrings("the-stored-key-0123456789", (try fx.store.get(arena.allocator(), &diag, .openai)).?);
}

test "agents: a failed delete is reported as left and the copy stays" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    fx.tools.legacy[@backingInt(Provider.anthropic)] = "legacy-key-0123456789abc";
    fx.tools.delete_code = 1;
    var diag: Diag = .{};
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expect(status[0].legacy_left);
    try testing.expectEqual(Source.file, status[0].source.?);
}

test "agents: a store that cannot be read stops the migration before any delete and is retried" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    fx.tools.legacy[@backingInt(Provider.anthropic)] = "legacy-key-0123456789abc";
    try fx.write("{broken");
    var diag: Diag = .{};
    try testing.expectError(error.StoreRefused, fx.store.status(arena.allocator(), &diag));
    try testing.expectEqual(@as(usize, 0), fx.tools.deletes);
    try testing.expect(!fx.store.migrated);
    try fx.write("{}");
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expectEqual(Source.file, status[0].source.?);
}

test "agents: only one trailing newline of the security output is dropped, like replace(/\\n$/, \"\")" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    // The fake prints the value and a newline, so a runner that hands over raw bytes gives "key\n\n".
    fx.tools.legacy[@backingInt(Provider.gemini)] = "key\n";
    var diag: Diag = .{};
    _ = try fx.store.status(arena.allocator(), &diag);
    try testing.expectEqualStrings("{\"gemini\":\"key\\n\"}", try fx.secrets(arena.allocator()));
}

test "agents: a legacy value with edge whitespace is migrated byte for byte, a blank one too" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    fx.tools.legacy[@backingInt(Provider.openai)] = "  pad\t ";
    fx.tools.legacy[@backingInt(Provider.gemini)] = "   ";
    var diag: Diag = .{};
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expect(!status[1].legacy_left and !status[2].legacy_left);
    try testing.expectEqualStrings("{\"openai\":\"  pad\\t \",\"gemini\":\"   \"}", try fx.secrets(arena.allocator()));
    try testing.expectEqual(@as(usize, 2), fx.tools.deletes);
}

test "agents: a legacy item is deleted only when the stored copy equals the raw value" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try fx.write("{\"openai\":\"pad\"}");
    fx.tools.legacy[@backingInt(Provider.openai)] = " pad ";
    var diag: Diag = .{};
    const status = try fx.store.status(arena.allocator(), &diag);
    try testing.expect(status[1].legacy_left);
    try testing.expectEqual(@as(usize, 0), fx.tools.deletes);
}

test "agents: the keychain warning is claimed once per provider across threads" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var claimed: std.atomic.Value(u32) = .init(0);
    const Worker = struct {
        fn run(store: *Store, count: *std.atomic.Value(u32)) void {
            for (0..providers.len) |index| if (store.claimWarning(index)) {
                _ = count.fetchAdd(1, .monotonic);
            };
        }
    };
    var threads: [8]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Worker.run, .{ &fx.store, &claimed });
    for (threads) |thread| thread.join();
    try testing.expectEqual(@as(u32, providers.len), claimed.load(.monotonic));
}

test "agents: control characters are refused" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var diag: Diag = .{};
    try testing.expectError(error.StoreRefused, fx.store.put(arena.allocator(), &diag, .openai, "abc\ndef"));
    try testing.expectEqualStrings("key must be printable text on a single line", diag.message);
}

test "agents: values are escaped like JSON.stringify" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try fx.write("{\"note\":\"a\\\"b\\\\c\\u0001\\u007f\\u00e9\"}");
    var diag: Diag = .{};
    try fx.store.put(arena.allocator(), &diag, .openai, "k\"\\k-0123456789abcdef");
    try testing.expectEqualStrings("{\"note\":\"a\\\"b\\\\c\\u0001\x7f\xc3\xa9\",\"openai\":\"k\\\"\\\\k-0123456789abcdef\"}", try fx.secrets(arena.allocator()));
}

test "agents: concurrent stores of different providers drop none" {
    const fx = try Fx.create(&.{});
    defer fx.destroy();
    const Worker = struct {
        fn run(store: *Store, provider: Provider) void {
            for (0..20) |_| {
                var arena: std.heap.ArenaAllocator = .init(testing.allocator);
                defer arena.deinit();
                var diag: Diag = .{};
                store.put(arena.allocator(), &diag, provider, "key-0123456789abcdefghij") catch @panic("store failed");
            }
        }
    };
    var threads: [4]std.Thread = undefined;
    for (&threads, providers) |*thread, provider| thread.* = try std.Thread.spawn(.{}, Worker.run, .{ &fx.store, provider });
    for (threads) |thread| thread.join();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var diag: Diag = .{};
    const status = try fx.store.status(arena.allocator(), &diag);
    for (status) |entry| try testing.expectEqual(Source.file, entry.source.?);
}
