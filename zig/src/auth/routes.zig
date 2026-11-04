//! The `/api/auth` handlers, a port of code/src/server/features/auth/{routes,routes-account}.ts.
//! The public ones (login, email, recovery, enroll) run without a session, behind the Origin guard
//! and the rate limiter of the chain; the account ones get an actor from the session gate.
//! `me` and `logout` are in middleware.zig.
const std = @import("std");
const httpz = @import("httpz");
const app_mod = @import("../app.zig");
const headers = @import("../http/headers.zig");
const http_routes = @import("../http/routes.zig");
const ids = @import("../ids.zig");
const body = @import("body.zig");
const codes = @import("codes.zig");
const middleware = @import("middleware.zig");
const passkeys = @import("passkeys.zig");
const sessions = @import("sessions.zig");

const App = app_mod.App;
const Call = http_routes.Call;
const Allocator = std.mem.Allocator;

// ---- seams other slices fill in ----

/// What happens to an email code for a user that exists. The default is the stdout line of
/// http.ts. The route answers first and a short-lived thread calls the sink, as TS queues the
/// delivery, so a slow or blocked sink neither delays the reply (which would show whether the
/// address is known) nor holds an HTTP worker.
pub const EmailSink = *const fn (io: std.Io, email: []const u8, code: []const u8) void;
pub var email_sink: EmailSink = printEmailCode;

fn printEmailCode(io: std.Io, email: []const u8, code: []const u8) void {
    var buf: [512]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "email code for {s}: {s}\n", .{ email, code }) catch return;
    std.Io.File.stdout().writeStreamingAll(io, line) catch |err| std.log.warn("email code line not written: {t}", .{err});
}

/// Email codes wait here for a small fixed set of worker threads. Nothing is allocated per code, so
/// a sink that never returns costs a slot, not memory, and a flood cannot grow the thread count.
const delivery_workers = 2;
const delivery_capacity = 64;

const Job = struct {
    email: [254]u8,
    email_len: u8,
    code: [6]u8,
};

const Deliveries = struct {
    mutex: std.Io.Mutex = .init,
    /// Signalled on every enqueue and when the workers are told to stop; idle workers sleep on it.
    wake: std.Io.Condition = .init,
    jobs: [delivery_capacity]Job = undefined,
    head: usize = 0,
    len: usize = 0,
    busy: usize = 0,
    alive: usize = 0,
    started: bool = false,
    stopping: bool = false,
};

var deliveries: Deliveries = .{};

/// How often a worker came out of its wait; the tests read it to see that idle workers sleep.
pub var delivery_wakeups: std.atomic.Value(usize) = .init(0);

fn deliveryWorker(io: std.Io) void {
    while (true) {
        deliveries.mutex.lockUncancelable(io);
        while (deliveries.len == 0 and !deliveries.stopping) {
            deliveries.wake.waitUncancelable(io, &deliveries.mutex);
            _ = delivery_wakeups.fetchAdd(1, .monotonic);
        }
        if (deliveries.len == 0) {
            deliveries.alive -= 1;
            deliveries.mutex.unlock(io);
            return;
        }
        const job = deliveries.jobs[deliveries.head];
        deliveries.head = (deliveries.head + 1) % delivery_capacity;
        deliveries.len -= 1;
        deliveries.busy += 1;
        deliveries.mutex.unlock(io);
        email_sink(io, job.email[0..job.email_len], &job.code);
        deliveries.mutex.lockUncancelable(io);
        deliveries.busy -= 1;
        deliveries.mutex.unlock(io);
    }
}

/// Queues the code for the sink. A full queue or a failed thread start drops it with a log line;
/// the reply the caller already sent is the same either way.
fn deliverAsync(app: *App, email: []const u8, code: [6]u8) void {
    const io = app.io;
    if (email.len > 254) return;
    var job: Job = .{ .email = undefined, .email_len = @intCast(email.len), .code = code };
    @memcpy(job.email[0..email.len], email);
    deliveries.mutex.lockUncancelable(io);
    defer deliveries.mutex.unlock(io);
    if (deliveries.len == delivery_capacity) return std.log.warn("email code dropped: delivery queue is full", .{});
    if (!deliveries.started) {
        deliveries.stopping = false;
        for (0..delivery_workers) |_| {
            const thread = std.Thread.spawn(.{}, deliveryWorker, .{io}) catch |err| {
                std.log.err("email delivery worker not started: {t}", .{err});
                break;
            };
            thread.detach();
            deliveries.alive += 1;
        }
        deliveries.started = deliveries.alive > 0;
        if (!deliveries.started) return std.log.warn("email code dropped: no delivery worker", .{});
    }
    deliveries.jobs[(deliveries.head + deliveries.len) % delivery_capacity] = job;
    deliveries.len += 1;
    deliveries.wake.signal(io);
}

/// How many delivery threads exist right now.
pub fn deliveryThreads(io: std.Io) usize {
    deliveries.mutex.lockUncancelable(io);
    defer deliveries.mutex.unlock(io);
    return deliveries.alive;
}

fn deliveriesIdle(io: std.Io) bool {
    deliveries.mutex.lockUncancelable(io);
    defer deliveries.mutex.unlock(io);
    return deliveries.len == 0 and deliveries.busy == 0;
}

/// Lets queued codes go out, then stops the workers, waiting at most `deadline_ms` in all. A sink
/// that is stuck is abandoned: its worker is detached, owns no heap, and ends when the sink does.
pub fn drainDeliveriesWithin(io: std.Io, deadline_ms: i64) void {
    const end = std.Io.Clock.awake.now(io).toMilliseconds() + deadline_ms;
    while (!deliveriesIdle(io) and std.Io.Clock.awake.now(io).toMilliseconds() < end) io.sleep(.fromMilliseconds(5), .awake) catch return;
    deliveries.mutex.lockUncancelable(io);
    deliveries.stopping = true;
    deliveries.wake.broadcast(io);
    deliveries.mutex.unlock(io);
    while (std.Io.Clock.awake.now(io).toMilliseconds() < end) {
        deliveries.mutex.lockUncancelable(io);
        const alive = deliveries.alive;
        if (alive == 0) deliveries.started = false;
        deliveries.mutex.unlock(io);
        if (alive == 0) return;
        io.sleep(.fromMilliseconds(5), .awake) catch return;
    }
}

/// `harness serve` and the tests wait for a short while; see `drainDeliveriesWithin`.
pub fn drainDeliveries(io: std.Io) void {
    drainDeliveriesWithin(io, 5000);
}

// ---- helpers ----

fn nowOf(call: *Call) i64 {
    return ids.nowMs(call.services.app.io);
}

/// `new URL(origin).hostname`.
pub fn hostnameOf(origin: []const u8) []const u8 {
    const rest = if (std.mem.find(u8, origin, "://")) |at| origin[at + 3 ..] else origin;
    return rest[0 .. std.mem.findAny(u8, rest, ":/") orelse rest.len];
}

fn rpOf(call: *Call) passkeys.Rp {
    return .{ .id = hostnameOf(call.origin), .origin = call.origin };
}

/// `{ ok: true }`, a constant so that answering after a write cannot fail.
const ok_body = "{\"ok\":true}";

/// A body that is already JSON text.
fn sendRaw(call: *Call, json_text: []const u8) void {
    call.res.body = json_text;
    call.res.header("content-type", "application/json");
}

fn sendBad(call: *Call, message: []const u8) !void {
    try headers.sendError(call.res, 400, message);
}

fn unauthorized(call: *Call) !void {
    try headers.sendError(call.res, 401, "unauthorized");
}

/// A route parameter as `c.req.param` returns it: percent-decoded.
fn param(call: *Call, name: []const u8) !?[]const u8 {
    const raw = call.req.param(name) orelse return null;
    return try middleware.percentDecode(call.res.arena, raw);
}

fn actorOf(call: *Call) !http_routes.Actor {
    return call.actor orelse error.Unauthorized;
}

/// `c.req.header("user-agent")?.slice(0, 200)`: JavaScript counts UTF-16 units. Header bytes that
/// are not UTF-8 are read as Latin-1, as a Fetch header value is. A surrogate pair cut in half
/// becomes U+FFFD in the database.
fn userAgentOf(arena: Allocator, req: *const httpz.Request) Allocator.Error!?[]const u8 {
    const raw = req.header("user-agent") orelse return null;
    return try truncateUtf16(arena, raw, 200);
}

pub fn truncateUtf16(arena: Allocator, raw: []const u8, max_units: usize) Allocator.Error![]const u8 {
    var text = raw;
    if (!std.unicode.utf8ValidateSlice(raw)) {
        var latin1: std.ArrayList(u8) = .empty;
        for (raw) |byte| {
            var encoded: [2]u8 = undefined;
            const len = std.unicode.utf8Encode(byte, &encoded) catch unreachable;
            try latin1.appendSlice(arena, encoded[0..len]);
        }
        text = latin1.items;
    }
    var units: usize = 0;
    var end: usize = 0;
    var it = (std.unicode.Utf8View.init(text) catch unreachable).iterator();
    while (it.nextCodepointSlice()) |slice| {
        const wide = (std.unicode.utf8Decode(slice) catch unreachable) >= 0x10000;
        const width: usize = if (wide) 2 else 1;
        if (units + width > max_units) {
            if (wide and units < max_units) return std.mem.concat(arena, u8, &.{ text[0..end], "\u{fffd}" });
            break;
        }
        units += width;
        end += slice.len;
    }
    return text[0..end];
}

/// JSON text in one allocation of fixed size, so the work does not depend on how long the values are.
fn renderJson(arena: Allocator, value: anytype) ![]const u8 {
    var out = try std.Io.Writer.Allocating.initCapacity(arena, 2048);
    try std.json.Stringify.value(value, .{}, &out.writer);
    return out.written();
}

/// What an unknown address gets in place of a user, so that the sign-in is prepared, and fails or
/// not, exactly as for a known one: the reply must not tell whether the account exists.
fn standIn(arena: Allocator, email: []const u8) !codes.User {
    return .{ .id = try arena.dupe(u8, "00000000-0000-7000-8000-000000000000"), .email = try arena.dupe(u8, email), .name = try arena.dupe(u8, "-"), .instanceAdmin = false, .createdAt = 0 };
}

/// Everything a sign-in's answer needs, built before anything is spent or stored: the session
/// plan (entropy), the cookie and the body. After the commit only `finishSignIn` is left, and it
/// cannot fail.
const Prepared = struct { signin: codes.SignIn, cookie: []const u8, body: []const u8 };

fn prepareSignIn(call: *Call, user: codes.User, method: sessions.Method, fresh_codes: ?*const codes.RecoveryCodes) !Prepared {
    const app = call.services.app;
    const arena = call.res.arena;
    const plan = try codes.planSession(app.io, method, try userAgentOf(arena, call.req), nowOf(call));
    const secure = std.mem.startsWith(u8, call.origin, "https:");
    const cookie = middleware.sessionCookie(arena, &plan.token, secure) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.UnsafeToken => return error.BadSessionToken,
    };
    const text = if (fresh_codes) |set|
        try renderJson(arena, .{ .user = user, .recoveryCodes = codes.recoverySlices(set) })
    else
        try renderJson(arena, .{ .user = user });
    return .{ .signin = .{ .plan = plan, .user = user, .io = app.io, .alloc = arena }, .cookie = cookie, .body = text };
}

fn finishSignIn(call: *Call, prepared: Prepared) void {
    call.res.header("set-cookie", prepared.cookie);
    sendRaw(call, prepared.body);
}

/// `signIn` for a passkey login: the session row and the personal org in one transaction.
fn signIn(call: *Call, user_id: []const u8, method: sessions.Method) !void {
    const app = call.services.app;
    const user = try codes.getUser(app, call.res.arena, user_id) orelse return unauthorized(call);
    const prepared = try prepareSignIn(call, user, method, null);
    try codes.signInNow(app, prepared.signin);
    finishSignIn(call, prepared);
}

/// `{ ...options, userId }`: the options JSON ends with `}`, so the key goes in before it.
fn withUserId(arena: Allocator, options: []const u8, user_id: []const u8) ![]const u8 {
    const quoted = try std.json.Stringify.valueAlloc(arena, user_id, .{});
    return std.fmt.allocPrint(arena, "{s},\"userId\":{s}}}", .{ options[0 .. options.len - 1], quoted });
}

// ---- public: login, email, recovery ----

/// `POST /api/auth/login/options`.
pub fn loginOptions(call: *Call) anyerror!void {
    sendRaw(call, try passkeys.loginOptions(call.services.app, call.res.arena, rpOf(call), nowOf(call)));
}

/// `POST /api/auth/login/verify`.
pub fn loginVerify(call: *Call) anyerror!void {
    const parsed = try body.assertion(call.req);
    const outcome = try passkeys.finishLogin(call.services.app, call.res.arena, rpOf(call), parsed.challenge_id, parsed.response, nowOf(call));
    switch (outcome) {
        .ok => |user_id| try signIn(call, user_id, .passkey),
        .failed => try unauthorized(call),
    }
}

/// `POST /api/auth/email/request`: the same reply whether or not the address has an account.
pub fn emailRequest(call: *Call) anyerror!void {
    const parsed = try body.emailOnly(call.req);
    const app = call.services.app;
    const request = try codes.requestEmailCode(app, call.res.arena, parsed.email, nowOf(call));
    if (!request.allowed) return headers.sendError(call.res, 429, "too many attempts");
    sendRaw(call, ok_body);
    if (request.deliver) deliverAsync(app, parsed.email, request.code);
}

/// `POST /api/auth/email/verify`. The session is stored in the transaction that spends the code.
pub fn emailVerify(call: *Call) anyerror!void {
    const parsed = try body.emailAndCode(call.req);
    const app = call.services.app;
    const arena = call.res.arena;
    const found = try codes.findUserByEmail(app, arena, parsed.email);
    const prepared = try prepareSignIn(call, found orelse try standIn(arena, parsed.email), .email, null);
    const spent = try codes.verifyEmailCodeWith(app, arena, parsed.email, parsed.code, nowOf(call), if (found != null) prepared.signin else null);
    if (spent == null or found == null) return unauthorized(call);
    finishSignIn(call, prepared);
}

/// `POST /api/auth/recovery`. The session is stored in the transaction that spends the code.
pub fn recovery(call: *Call) anyerror!void {
    const parsed = try body.emailAndCode(call.req);
    const app = call.services.app;
    const arena = call.res.arena;
    const found = try codes.findUserByEmail(app, arena, parsed.email);
    const prepared = try prepareSignIn(call, found orelse try standIn(arena, parsed.email), .recovery, null);
    const spent = try codes.useRecoveryCodeWith(app, arena, parsed.email, parsed.code, nowOf(call), if (found != null) prepared.signin else null);
    if (spent == null or found == null) return unauthorized(call);
    finishSignIn(call, prepared);
}

// ---- public: enrollment ----

const not_valid = "enrollment code is not valid";

/// `POST /api/auth/enroll/:code/options`. The options step fixes the user so the passkey can be
/// bound to a real id, and may be repeated after a cancelled prompt.
pub fn enrollOptions(call: *Call) anyerror!void {
    const parsed = try body.enrollOptions(call.req);
    const app = call.services.app;
    const arena = call.res.arena;
    const code = try param(call, "code") orelse return sendBad(call, not_valid);
    const user_id = try codes.redeemEnrollment(app, arena, code, .{ .email = parsed.email, .name = parsed.name }, nowOf(call)) orelse return sendBad(call, not_valid);
    const options = try passkeys.registrationOptions(app, arena, rpOf(call), user_id, nowOf(call)) orelse return sendBad(call, "unknown user");
    sendRaw(call, try withUserId(arena, options, user_id));
}

/// `POST /api/auth/enroll/:code/verify`. Only a registered passkey finishes the code. The passkey,
/// the recovery codes, the code's used mark, the session and the personal org are one transaction,
/// and everything the answer needs is built before it: a failure anywhere leaves nothing behind
/// and lets go of the claim, so the same code can try again.
pub fn enrollVerify(call: *Call) anyerror!void {
    const parsed = try body.enrollVerify(call.req);
    const app = call.services.app;
    const arena = call.res.arena;
    const code = try param(call, "code") orelse return sendBad(call, not_valid);
    const hash = try codes.enrollmentHash(arena, code) orelse return sendBad(call, not_valid);
    // Without this the route would register a passkey for any user id, enrollment or not.
    const redeemed = try codes.enrollmentUser(app, arena, code, nowOf(call)) orelse return sendBad(call, not_valid);
    if (!std.mem.eql(u8, redeemed, parsed.user_id)) return sendBad(call, not_valid);
    const claim = try codes.claimEnrollmentToken(app, arena, code, nowOf(call)) orelse return headers.sendError(call.res, 409, passkeys.claim_lost_reason);
    errdefer codes.releaseByHash(app, hash, claim) catch |release_err| std.log.warn("enrollment claim not released: {t}", .{release_err});
    const user = try codes.getUser(app, arena, parsed.user_id) orelse return sendBad(call, not_valid);
    const recovery_set = try codes.drawRecoveryCodes(app.io);
    const prepared = try prepareSignIn(call, user, .enroll, &recovery_set);
    const outcome = try passkeys.finishRegistrationWith(app, arena, rpOf(call), parsed.user_id, parsed.challenge_id, parsed.response, parsed.name, nowOf(call), .{ .hash = hash, .claim = claim }, &recovery_set, prepared.signin);
    switch (outcome) {
        .failed => |reason| {
            // A lost claim belongs to the request that took it over: leave it alone.
            if (std.mem.eql(u8, reason, passkeys.claim_lost_reason)) return headers.sendError(call.res, 409, reason);
            try codes.releaseByHash(app, hash, claim);
            return sendBad(call, reason);
        },
        .ok => {},
    }
    finishSignIn(call, prepared);
}

// ---- account: passkeys ----

/// `GET /api/auth/passkeys`.
pub fn passkeyList(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    try headers.sendJson(call.res, try passkeys.listPasskeys(call.services.app, call.res.arena, actor.user_id));
}

/// `POST /api/auth/passkeys/options`, after a step-up.
pub fn passkeyOptions(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    if (!try middleware.requireStepUp(call.res, actor, nowOf(call))) return;
    const options = try passkeys.registrationOptions(call.services.app, call.res.arena, rpOf(call), actor.user_id, nowOf(call)) orelse return sendBad(call, "unknown user");
    sendRaw(call, options);
}

/// `POST /api/auth/passkeys/verify`, after a step-up.
pub fn passkeyVerify(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    if (!try middleware.requireStepUp(call.res, actor, nowOf(call))) return;
    const parsed = try body.passkey(call.req);
    const outcome = try passkeys.finishRegistration(call.services.app, call.res.arena, rpOf(call), actor.user_id, parsed.challenge_id, parsed.response, parsed.name, nowOf(call));
    switch (outcome) {
        .ok => |id| try headers.sendJson(call.res, .{ .id = id }),
        .failed => |reason| try sendBad(call, reason),
    }
}

/// `DELETE /api/auth/passkeys/:id`, after a step-up.
pub fn passkeyDelete(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    if (!try middleware.requireStepUp(call.res, actor, nowOf(call))) return;
    const id = try param(call, "id") orelse return headers.sendError(call.res, 404, "unknown passkey");
    switch (try passkeys.deletePasskey(call.services.app, actor.user_id, id)) {
        .missing => try headers.sendError(call.res, 404, "unknown passkey"),
        .last => try headers.sendError(call.res, 409, "cannot delete the last passkey"),
        .deleted => sendRaw(call, ok_body),
    }
}

/// `POST /api/auth/recovery/regenerate`, after a step-up.
pub fn recoveryRegenerate(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    if (!try middleware.requireStepUp(call.res, actor, nowOf(call))) return;
    // Drawn and rendered first: the old set is replaced only once the answer that shows the new one
    // is ready to go out.
    const set = try codes.drawRecoveryCodes(call.services.app.io);
    const text = try std.json.Stringify.valueAlloc(call.res.arena, .{ .recoveryCodes = codes.recoverySlices(&set) }, .{});
    try codes.storeRecoveryCodes(call.services.app, actor.user_id, &set);
    sendRaw(call, text);
}

// ---- account: step-up ----

/// `POST /api/auth/step-up/options`.
pub fn stepUpOptions(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    sendRaw(call, try passkeys.stepUpOptions(call.services.app, call.res.arena, rpOf(call), actor.user_id, nowOf(call)));
}

/// `POST /api/auth/step-up/verify`.
pub fn stepUpVerify(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    const parsed = try body.assertion(call.req);
    const outcome = try passkeys.finishStepUp(call.services.app, call.res.arena, rpOf(call), actor.session_id, actor.user_id, parsed.challenge_id, parsed.response, nowOf(call));
    switch (outcome) {
        .ok => sendRaw(call, ok_body),
        .failed => try headers.sendError(call.res, 401, "step-up failed"),
    }
}

// ---- account: sessions ----

/// `SessionInfo` plus `current`, in the order the route sends them.
const SessionOut = struct {
    id: []const u8,
    method: []const u8,
    userAgent: ?[]const u8,
    createdAt: i64,
    lastSeenAt: i64,
    expiresAt: i64,
    current: bool,
};

const ListArgs = struct { alloc: Allocator, user_id: []const u8, current_id: []const u8, now: i64 };

fn listSessionsLocked(db: @import("../db/sqlite.zig").Db, a: ListArgs) codes.Error![]SessionOut {
    const stmt = try codes.prepared(
        db,
        \\SELECT id, method, user_agent, created_at, last_seen_at, expires_at FROM sessions
        \\ WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC
    ,
        &.{ .{ .text = a.user_id }, .{ .int = a.now } },
    );
    defer stmt.finalize();
    var list: std.ArrayList(SessionOut) = .empty;
    while (try stmt.step()) {
        const id = try stmt.textAlloc(a.alloc, 0) orelse return error.CorruptRow;
        try list.append(a.alloc, .{
            .id = id,
            .method = try stmt.textAlloc(a.alloc, 1) orelse return error.CorruptRow,
            .userAgent = try stmt.textAlloc(a.alloc, 2),
            .createdAt = stmt.int(3),
            .lastSeenAt = stmt.int(4),
            .expiresAt = stmt.int(5),
            .current = std.mem.eql(u8, id, a.current_id),
        });
    }
    return list.items;
}

/// `GET /api/auth/sessions`.
pub fn sessionList(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    const list = try codes.run(call.services.app, ListArgs{ .alloc = call.res.arena, .user_id = actor.user_id, .current_id = actor.session_id, .now = nowOf(call) }, listSessionsLocked);
    try headers.sendJson(call.res, list);
}

/// `DELETE /api/auth/sessions/:id`. Revoking the current session is the same as logout, so it
/// skips step-up on purpose.
pub fn sessionDelete(call: *Call) anyerror!void {
    const actor = try actorOf(call);
    const id = try param(call, "id") orelse return headers.sendError(call.res, 404, "unknown session");
    if (!std.mem.eql(u8, id, actor.session_id) and !try middleware.requireStepUp(call.res, actor, nowOf(call))) return;
    if (try sessions.revoke(call.services.app, actor.user_id, id, nowOf(call))) {
        sendRaw(call, ok_body);
    } else {
        try headers.sendError(call.res, 404, "unknown session");
    }
}

test {
    _ = @import("routes_test.zig");
}
