//! The Zig side of code/src/server/features/auth/middleware.ts and rate-limit.ts: the session
//! cookie, the authenticator the HTTP chain calls, the step-up and org-admin gates, the auth rate
//! limiter and the two session endpoints that do not wait for the auth routes (`/api/auth/me` and
//! `/api/auth/logout`). The host and origin guards live in http/policy.zig.
const std = @import("std");
const httpz = @import("httpz");
const app_mod = @import("../app.zig");
const sqlite = @import("../db/sqlite.zig");
const headers = @import("../http/headers.zig");
const policy = @import("../http/policy.zig");
const routes = @import("../http/routes.zig");
const ids = @import("../ids.zig");
const parity = @import("../parity.zig");
const sessions = @import("sessions.zig");

const App = app_mod.App;
const State = app_mod.State;

pub const cookie_name = "harness_session";
/// THIRTY_DAYS_S
pub const cookie_max_age_s: i64 = 30 * 24 * 60 * 60;

/// Where the logic reads the wall clock. Tests replace it to step through expiry and windows.
pub const Clock = *const fn (io: std.Io) i64;

// ---- cookies ----

/// Hono's `trimCookieWhitespace`: spaces and tabs only.
fn trimCookieWhitespace(value: []const u8) []const u8 {
    return std.mem.trim(u8, value, " \t");
}

/// Hono's `validCookieValueRegEx`, `/^[ !#-:<-[\]-~]*$/`: printable ASCII without `"`, `;` and `\`.
fn validCookieValue(value: []const u8) bool {
    for (value) |ch| switch (ch) {
        ' ', '!', '#'...':', '<'...'[', ']'...'~' => {},
        else => return false,
    };
    return true;
}

/// The byte spelled by a `%XX` at `text[at..]`, or null when there is none.
fn percentByte(text: []const u8, at: usize) ?u8 {
    if (at + 3 > text.len or text[at] != '%') return null;
    const high = std.fmt.charToDigit(text[at + 1], 16) catch return null;
    const low = std.fmt.charToDigit(text[at + 2], 16) catch return null;
    return high << 4 | low;
}

/// `tryDecodeURIComponent` of Hono: each run of `%XX` becomes the UTF-8 text it spells; a run that
/// is not valid UTF-8, and any stray `%`, stay as written.
fn percentDecode(arena: std.mem.Allocator, text: []const u8) std.mem.Allocator.Error![]const u8 {
    if (std.mem.findScalar(u8, text, '%') == null) return text;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        var end = i;
        while (percentByte(text, end) != null) end += 3;
        if (end == i) {
            try out.append(arena, text[i]);
            i += 1;
            continue;
        }
        // Decode in place at the end of `out`; an invalid run is replaced by its source text.
        const start = out.items.len;
        for (0..(end - i) / 3) |n| try out.append(arena, percentByte(text, i + n * 3).?);
        if (!std.unicode.utf8ValidateSlice(out.items[start..])) {
            out.shrinkRetainingCapacity(start);
            try out.appendSlice(arena, text[i..end]);
        }
        i = end;
    }
    return out.items;
}

/// `getCookie(c, name)` of hono/cookie over a `Cookie` header value: the first pair of that name
/// whose value is a legal cookie value; surrounding double quotes are dropped, then the value is
/// percent-decoded.
pub fn cookieValue(arena: std.mem.Allocator, header: []const u8, name: []const u8) std.mem.Allocator.Error!?[]const u8 {
    var pairs = std.mem.splitScalar(u8, header, ';');
    while (pairs.next()) |pair| {
        const eq = std.mem.findScalar(u8, pair, '=') orelse continue;
        if (!std.mem.eql(u8, trimCookieWhitespace(pair[0..eq]), name)) continue;
        var value = trimCookieWhitespace(pair[eq + 1 ..]);
        if (value.len > 0 and value[0] == '"' and value[value.len - 1] == '"')
            value = if (value.len >= 2) value[1 .. value.len - 1] else "";
        if (!validCookieValue(value)) continue;
        return try percentDecode(arena, value);
    }
    return null;
}

/// All values of a request header joined with ", ", which is what `Headers.get` returns in TS when
/// a client sent the header more than once. Names in httpz are lowercase.
fn joinedHeader(arena: std.mem.Allocator, req: *const httpz.Request, name: []const u8) std.mem.Allocator.Error!?[]const u8 {
    var joined: std.ArrayList(u8) = .empty;
    var found = false;
    for (req.headers.keys[0..req.headers.len], req.headers.values[0..req.headers.len]) |key, value| {
        if (!std.mem.eql(u8, key, name)) continue;
        if (found) try joined.appendSlice(arena, ", ");
        try joined.appendSlice(arena, value);
        found = true;
    }
    return if (found) joined.items else null;
}

fn sessionToken(arena: std.mem.Allocator, req: *const httpz.Request) std.mem.Allocator.Error!?[]const u8 {
    const header = try joinedHeader(arena, req, "cookie") orelse return null;
    const token = try cookieValue(arena, header, cookie_name) orelse return null;
    return if (token.len == 0) null else token;
}

/// A token that survives `encodeURIComponent` unchanged, which every token we mint does.
fn isPlainToken(token: []const u8) bool {
    if (token.len == 0) return false;
    for (token) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '-' and ch != '_') return false;
    return true;
}

/// `setSessionCookie`: HttpOnly, SameSite=Strict, Path=/, thirty days, Secure when the origin is
/// https. The attribute order is Hono's.
pub fn sessionCookie(arena: std.mem.Allocator, token: []const u8, secure: bool) error{ OutOfMemory, UnsafeToken }![]const u8 {
    if (!isPlainToken(token)) return error.UnsafeToken;
    return std.fmt.allocPrint(arena, "{s}={s}; Max-Age={d}; Path=/; HttpOnly{s}; SameSite=Strict", .{
        cookie_name,
        token,
        cookie_max_age_s,
        if (secure) "; Secure" else "",
    });
}

/// `deleteCookie(c, SESSION_COOKIE, { path: "/" })`.
pub const cleared_cookie = cookie_name ++ "=; Max-Age=0; Path=/";

// ---- session middleware ----

/// `sessionMiddleware`. Only the session cookie opens a session; an Authorization header is never
/// looked at. A lookup that slid the stored expiry also re-sets the cookie on `/api/*`, whose
/// Max-Age would otherwise run out thirty days after login (the `/ws` mount has no origin and
/// skips that).
pub const SessionAuth = struct {
    app: *App,
    /// HARNESS_ORIGIN starts with https:. Without HARNESS_ORIGIN the origin is http://localhost.
    secure_cookie: bool,
    clock: Clock = ids.nowMs,

    pub fn init(app: *App, configured_origin: ?[]const u8) SessionAuth {
        const origin = configured_origin orelse "";
        return .{ .app = app, .secure_cookie = std.mem.startsWith(u8, origin, "https:") };
    }

    pub fn authenticator(self: *SessionAuth) policy.Authenticator {
        return .{ .ctx = self, .authenticate = authenticate };
    }

    /// The session behind the request's cookie, for callers that cannot set a cookie on a response
    /// (the `/ws` upgrade, which runs after the chain has already refreshed it).
    pub fn sessionOf(self: *SessionAuth, arena: std.mem.Allocator, req: *const httpz.Request) anyerror!?sessions.Session {
        const token = try sessionToken(arena, req) orelse return null;
        return sessions.lookup(self.app, arena, token, self.clock(self.app.io));
    }

    fn authenticate(ctx: *anyopaque, req: *httpz.Request, res: *httpz.Response) anyerror!?policy.Actor {
        const self: *SessionAuth = @ptrCast(@alignCast(ctx));
        const arena = res.arena;
        const token = try sessionToken(arena, req) orelse return null;
        const session = try sessions.lookup(self.app, arena, token, self.clock(self.app.io)) orelse return null;
        if (session.slid and policy.isApiPath(req.url.path)) {
            // The token matched a stored hash, so it is one of ours and plain; the check only
            // guards the header against a future change of the token alphabet.
            if (sessionCookie(arena, token, self.secure_cookie)) |value| res.header("set-cookie", value) else |err| switch (err) {
                error.UnsafeToken => {},
                error.OutOfMemory => return error.OutOfMemory,
            }
        }
        return .{
            .instance_admin = session.instance_admin,
            .user_id = session.user_id,
            .session_id = session.id,
            .method = @tagName(session.method),
            .step_up_at = session.step_up_at,
        };
    }
};

// ---- gates ----

/// `stepUpRequired`: 403 `{"error":"step_up_required"}`.
pub fn sendStepUpRequired(res: *httpz.Response) !void {
    try headers.sendError(res, 403, "step_up_required");
}

/// `requireStepUp`, and the inline `hasFreshStepUp` checks of the handlers that TS does not put in
/// middleware: true when the caller may go on, otherwise 403 is already on `res`.
pub fn requireStepUp(res: *httpz.Response, actor: policy.Actor, now: i64) !bool {
    if (sessions.hasFreshStepUp(actor.step_up_at, now)) return true;
    try sendStepUpRequired(res);
    return false;
}

fn administersLocked(user_id: []const u8, state: *State) sessions.Error!bool {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    // `administeredOrgs` of guard/routes.ts: the orgs the user belongs to where `orgAccess` is
    // admin or owner.
    const stmt = try db.prepare(
        \\SELECT 1 FROM members m JOIN orgs o ON o.id = m.org_id
        \\ WHERE m.user_id = ? AND m.role IN ('admin', 'owner') LIMIT 1
    );
    defer stmt.finalize();
    try stmt.bindText(1, user_id);
    return stmt.step();
}

/// Whether the user is owner or admin of at least one org.
pub fn administersAnyOrg(app: *App, user_id: []const u8) sessions.Error!bool {
    return app.withLock(user_id, administersLocked);
}

/// `requireOrgAdmin` of approvalRoutes: the instance admin, or someone who administers an org;
/// everyone else gets 403 `{"error":"forbidden"}`. True when the caller may go on.
pub fn requireOrgAdmin(app: *App, res: *httpz.Response, actor: policy.Actor) !bool {
    if (actor.instance_admin or try administersAnyOrg(app, actor.user_id)) return true;
    try headers.sendError(res, 403, "forbidden");
    return false;
}

// ---- rate limit ----

/// `ATTEMPTS_PER_MINUTE` and its window in routes.ts.
pub const attempts_per_minute: u32 = 10;
pub const attempt_window_ms: i64 = 60_000;

/// `rateLimit`: a fixed window per client key. The counters are in memory on purpose, a restart
/// resets them. `hits` is only touched under the app lock; the key strings belong to `gpa`.
pub const RateLimiter = struct {
    gpa: std.mem.Allocator,
    app: *App,
    limit: u32 = attempts_per_minute,
    window_ms: i64 = attempt_window_ms,
    trust_proxy: bool = false,
    /// MAX_TRACKED: above this many keys, expired entries are swept before the next insert.
    max_tracked: usize = 10_000,
    clock: Clock = ids.nowMs,
    hits: std.StringHashMapUnmanaged(Entry) = .empty,
    sweeps_skipped: u32 = 0,

    const Entry = struct { count: u32, reset_at: i64 };

    pub const Decision = union(enum) {
        allow,
        /// Whole seconds until the window ends, `Math.ceil((resetAt - now) / 1000)`.
        limited: i64,
    };

    pub fn init(gpa: std.mem.Allocator, app: *App, trust_proxy: bool) RateLimiter {
        return .{ .gpa = gpa, .app = app, .trust_proxy = trust_proxy };
    }

    /// Only after the server has stopped: nothing may be calling `hit` any more.
    pub fn deinit(self: *RateLimiter) void {
        var keys = self.hits.keyIterator();
        while (keys.next()) |key| self.gpa.free(key.*);
        self.hits.deinit(self.gpa);
    }

    const HitArgs = struct { limiter: *RateLimiter, key: []const u8, now: i64 };

    fn hitLocked(args: *const HitArgs, _: *State) std.mem.Allocator.Error!Decision {
        const self = args.limiter;
        if (self.hits.count() > self.max_tracked) self.sweep(args.now);
        const entry = try self.entryFor(args.key, args.now);
        entry.count +|= 1;
        if (entry.count > self.limit) return .{ .limited = @divTrunc((entry.reset_at -| args.now) +| 999, 1000) };
        return .allow;
    }

    /// The live entry of `key`, or a new one whose window starts now.
    fn entryFor(self: *RateLimiter, key: []const u8, now: i64) std.mem.Allocator.Error!*Entry {
        const fresh: Entry = .{ .count = 0, .reset_at = now +| self.window_ms };
        if (self.hits.getPtr(key)) |entry| {
            if (entry.reset_at <= now) entry.* = fresh;
            return entry;
        }
        const owned = try self.gpa.dupe(u8, key);
        errdefer self.gpa.free(owned);
        const slot = try self.hits.getOrPut(self.gpa, owned);
        slot.value_ptr.* = fresh;
        return slot.value_ptr;
    }

    /// std documents that a map iterator "is invalidated if the map is modified", so the expired
    /// keys are collected first and removed after the walk. Without memory for the list the sweep
    /// is skipped and `sweeps_skipped` counts it; the next insert over the cap tries again.
    fn sweep(self: *RateLimiter, now: i64) void {
        var expired: std.ArrayList([]const u8) = .empty;
        defer expired.deinit(self.gpa);
        var it = self.hits.iterator();
        while (it.next()) |kv| {
            if (kv.value_ptr.reset_at > now) continue;
            expired.append(self.gpa, kv.key_ptr.*) catch {
                self.sweeps_skipped +|= 1;
                return;
            };
        }
        for (expired.items) |key| {
            const removed = self.hits.fetchRemove(key) orelse continue;
            self.gpa.free(removed.key);
        }
    }

    /// Counts one request of `key` at `now` and says whether it may go on.
    pub fn hit(self: *RateLimiter, key: []const u8, now: i64) std.mem.Allocator.Error!Decision {
        return self.app.withLock(&HitArgs{ .limiter = self, .key = key, .now = now }, hitLocked);
    }

    pub fn throttle(self: *RateLimiter) policy.Throttle {
        return .{ .ctx = self, .check = check };
    }

    fn check(ctx: *anyopaque, req: *httpz.Request, res: *httpz.Response) anyerror!bool {
        const self: *RateLimiter = @ptrCast(@alignCast(ctx));
        const arena = res.arena;
        const path = try percentDecode(arena, req.url.path);
        if (!isLimitedPath(path)) return true;
        const key = try clientKey(arena, req, self.trust_proxy);
        switch (try self.hit(key, self.clock(self.app.io))) {
            .allow => return true,
            .limited => |seconds| {
                res.header("retry-after", try std.fmt.allocPrint(arena, "{d}", .{seconds}));
                try headers.sendError(res, 429, "too many attempts");
                return false;
            },
        }
    }
};

/// The paths `publicAuthRoutes` puts the limiter on: `/login/*`, `/email/*`, `/recovery` and
/// `/enroll/*` below `/api/auth`. A Hono `/x/*` also matches `/x` itself.
pub fn isLimitedPath(path: []const u8) bool {
    const base = "/api/auth";
    if (!std.mem.startsWith(u8, path, base)) return false;
    const rest = path[base.len..];
    if (std.mem.eql(u8, rest, "/recovery")) return true;
    for ([_][]const u8{ "/login", "/email", "/enroll" }) |prefix| {
        if (!std.mem.startsWith(u8, rest, prefix)) continue;
        if (rest.len == prefix.len or rest[prefix.len] == '/') return true;
    }
    return false;
}

/// The IP of the peer, without a port. IPv6 uses the shortest form, as `requestIP().address` does.
fn peerText(buf: *[64]u8, address: std.Io.net.IpAddress) []const u8 {
    switch (address) {
        .ip4 => |ip4| return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{ ip4.bytes[0], ip4.bytes[1], ip4.bytes[2], ip4.bytes[3] }) catch unreachable,
        .ip6 => |ip6| {
            var bare = ip6;
            bare.port = 0;
            var w: std.Io.Writer = .fixed(buf);
            bare.format(&w) catch unreachable;
            // `[addr]:0`
            const text = w.buffered();
            return text[1 .. text.len - 3];
        },
    }
}

/// `clientKey` of rate-limit.ts. Behind a proxy the socket address is the proxy's, so the key is
/// the rightmost X-Forwarded-For entry, the one the proxy appended and the client cannot forge;
/// without a proxy the header is ignored. An empty entry falls back to the socket address.
pub fn clientKey(arena: std.mem.Allocator, req: *const httpz.Request, trust_proxy: bool) std.mem.Allocator.Error![]const u8 {
    var buf: [64]u8 = undefined;
    const socket = peerText(&buf, req.address);
    if (trust_proxy) if (try joinedHeader(arena, req, "x-forwarded-for")) |forwarded| {
        const last = if (std.mem.findScalarLast(u8, forwarded, ',')) |comma| forwarded[comma + 1 ..] else forwarded;
        const entry = parity.jsTrim(last);
        if (entry.len > 0) return entry;
    };
    return arena.dupe(u8, socket);
}

// ---- GET /api/auth/me and POST /api/auth/logout ----

const OrgOut = struct { id: []const u8, slug: []const u8, name: []const u8, createdAt: i64, role: []const u8 };
const UserOut = struct { id: []const u8, email: []const u8, name: []const u8, instanceAdmin: bool, createdAt: i64 };

const MeData = struct { user: ?UserOut, orgs: []const OrgOut };

const MeArgs = struct { arena: std.mem.Allocator, user_id: []const u8 };

fn loadUser(db: sqlite.Db, args: *const MeArgs) sessions.Error!?UserOut {
    const stmt = try db.prepare("SELECT id, email, name, instance_admin, created_at FROM users WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, args.user_id);
    if (!try stmt.step()) return null;
    return .{
        .id = try stmt.textAlloc(args.arena, 0) orelse return error.CorruptRow,
        .email = try stmt.textAlloc(args.arena, 1) orelse return error.CorruptRow,
        .name = try stmt.textAlloc(args.arena, 2) orelse return error.CorruptRow,
        .instanceAdmin = stmt.int(3) == 1,
        .createdAt = stmt.int(4),
    };
}

/// `listOrgsForUser` with `orgAccess` per org; (org_id, user_id) is unique, so the role comes
/// from the same joined row.
fn loadOrgs(db: sqlite.Db, args: *const MeArgs) sessions.Error![]const OrgOut {
    const stmt = try db.prepare(
        \\SELECT o.id, o.slug, o.name, o.created_at, m.role FROM orgs o JOIN members m ON m.org_id = o.id
        \\ WHERE m.user_id = ? ORDER BY o.created_at, o.id
    );
    defer stmt.finalize();
    try stmt.bindText(1, args.user_id);
    var list: std.ArrayList(OrgOut) = .empty;
    while (try stmt.step()) try list.append(args.arena, .{
        .id = try stmt.textAlloc(args.arena, 0) orelse return error.CorruptRow,
        .slug = try stmt.textAlloc(args.arena, 1) orelse return error.CorruptRow,
        .name = try stmt.textAlloc(args.arena, 2) orelse return error.CorruptRow,
        .createdAt = stmt.int(3),
        .role = try stmt.textAlloc(args.arena, 4) orelse return error.CorruptRow,
    });
    return list.items;
}

fn loadMeLocked(args: *const MeArgs, state: *State) sessions.Error!MeData {
    const db: sqlite.Db = .{ .handle = state.db orelse return error.NoDatabase };
    return .{ .user = try loadUser(db, args), .orgs = try loadOrgs(db, args) };
}

/// `GET /api/auth/me`, routes-account.ts:99.
pub fn me(call: *routes.Call) anyerror!void {
    const actor = call.actor orelse return error.Unauthorized;
    const app = call.services.app;
    const now = ids.nowMs(app.io);
    const data = try app.withLock(&MeArgs{ .arena = call.res.arena, .user_id = actor.user_id }, loadMeLocked);
    try headers.sendJson(call.res, .{
        .user = data.user,
        .session = .{
            .id = actor.session_id,
            .method = actor.method,
            .stepUpAt = actor.step_up_at,
            .stepUpFresh = sessions.hasFreshStepUp(actor.step_up_at, now),
        },
        .orgs = data.orgs,
    });
}

/// `POST /api/auth/logout`, routes-account.ts:90: revokes the current session and clears the
/// cookie, whether or not the row was still live.
pub fn logout(call: *routes.Call) anyerror!void {
    const actor = call.actor orelse return error.Unauthorized;
    const app = call.services.app;
    const revoked = try sessions.revoke(app, actor.user_id, actor.session_id, ids.nowMs(app.io));
    if (revoked) if (call.services.hub) |hub| {
        _ = hub.registry.closeSession(actor.session_id);
    };
    call.res.header("set-cookie", cleared_cookie);
    try headers.sendJson(call.res, .{ .ok = true });
}

test {
    _ = @import("middleware_test.zig");
}
