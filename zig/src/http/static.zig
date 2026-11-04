//! Files from HARNESS_UI_DIST and the PWA headers, same rules as code/src/server/ui-dist.ts and
//! code/src/server/pwa.ts. The embedded UI is a later slice: without a dist directory nothing here
//! answers and the request falls through to the routes.
const std = @import("std");
const httpz = @import("httpz");

/// A dist file is read whole into the request arena; bigger than this is a build error, not a page.
const max_file_bytes = 64 * 1024 * 1024;

pub const Error = error{FileTooBig} || std.mem.Allocator.Error;

/// `pwaHeaders` of pwa.ts: no-cache on all three so a new service worker or manifest is picked up on
/// the next load, and `service-worker-allowed` lets /sw.js control the whole origin.
pub const PwaHeaders = struct {
    content_type: []const u8,
    service_worker_allowed: bool = false,
};

pub fn pwaHeaders(path: []const u8) ?PwaHeaders {
    if (std.mem.eql(u8, path, "/manifest.webmanifest")) return .{ .content_type = "application/manifest+json" };
    if (std.mem.eql(u8, path, "/sw.js")) return .{ .content_type = "text/javascript; charset=utf-8", .service_worker_allowed = true };
    if (std.mem.eql(u8, path, "/icon.svg")) return .{ .content_type = "image/svg+xml" };
    return null;
}

/// `decodeURIComponent`: a `%` must be followed by two hex digits, and the result must be UTF-8.
fn decodeComponent(arena: std.mem.Allocator, raw: []const u8) Error!?[]u8 {
    const out = try arena.alloc(u8, raw.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < raw.len) : (n += 1) {
        if (raw[i] != '%') {
            out[n] = raw[i];
            i += 1;
            continue;
        }
        if (i + 3 > raw.len) return null;
        const hi = std.fmt.charToDigit(raw[i + 1], 16) catch return null;
        const lo = std.fmt.charToDigit(raw[i + 2], 16) catch return null;
        out[n] = hi * 16 + lo;
        i += 3;
    }
    if (!std.unicode.utf8ValidateSlice(out[0..n])) return null;
    return out[0..n];
}

/// `path.resolve(root, relative)` minus the root: dot segments are folded and a `..` that would
/// climb out of the root gives null. A leading `/` makes `resolve` return an absolute path outside
/// the root, so that is refused too, as is a path that resolves to the root itself. Result is
/// written into `out`, which is at least as long as `relative`.
fn resolveBelowRoot(out: []u8, relative: []const u8) ?[]const u8 {
    if (relative.len > 0 and relative[0] == '/') return null;
    var n: usize = 0;
    var parts = std.mem.splitScalar(u8, relative, '/');
    while (parts.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".")) continue;
        if (std.mem.eql(u8, part, "..")) {
            if (n == 0) return null;
            n = std.mem.findScalarLast(u8, out[0..n], '/') orelse 0;
            continue;
        }
        if (n > 0) {
            out[n] = '/';
            n += 1;
        }
        @memcpy(out[n..][0..part.len], part);
        n += part.len;
    }
    return if (n == 0) null else out[0..n];
}

/// The dist-relative file for a request path: `/_app` is index.html, anything else is the decoded
/// path with the leading slash removed. Null for malformed escapes, NUL and paths outside the root.
pub fn relativeFor(arena: std.mem.Allocator, request_path: []const u8) Error!?[]const u8 {
    var raw: []const u8 = "index.html";
    if (!std.mem.eql(u8, request_path, "/_app")) {
        if (request_path.len == 0 or request_path[0] != '/') return null;
        raw = request_path[1..];
    }
    const decoded = (try decodeComponent(arena, raw)) orelse return null;
    if (std.mem.findScalar(u8, decoded, 0) != null) return null;
    const out = try arena.alloc(u8, decoded.len);
    return resolveBelowRoot(out, decoded);
}

/// `uiDistResponse`'s file lookup. Both the root and the target are resolved through symlinks and
/// the target has to stay under the root, because a link inside the dist may point anywhere. The
/// real path is then opened without following a final link and checked to be a regular file (a
/// FIFO would block the worker). A swap of a directory between the check and the open needs write
/// access to the dist, which is build output the server already trusts.
fn readDistFile(io: std.Io, arena: std.mem.Allocator, dist: []const u8, relative: []const u8) Error!?[]u8 {
    var root_dir = std.Io.Dir.cwd().openDir(io, dist, .{}) catch return null;
    defer root_dir.close(io);

    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    var real_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root_len = root_dir.realPath(io, &root_buf) catch return null;
    const real_len = root_dir.realPathFile(io, relative, &real_buf) catch return null;
    const real_root = root_buf[0..root_len];
    const real = real_buf[0..real_len];
    if (!underRoot(real_root, real)) return null;

    var file = std.Io.Dir.cwd().openFile(io, real, .{ .allow_directory = false, .follow_symlinks = false }) catch return null;
    defer file.close(io);
    const stat = file.stat(io) catch return null;
    if (stat.kind != .file) return null;
    if (stat.size > max_file_bytes) return error.FileTooBig;

    var reader = file.reader(io, &.{});
    return reader.interface.allocRemaining(arena, .limited(max_file_bytes)) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.StreamTooLong => error.FileTooBig,
        error.ReadFailed => null,
    };
}

/// `real.startsWith(realRoot + sep)`.
fn underRoot(real_root: []const u8, real: []const u8) bool {
    // A root of "/" is already its own separator: trim it so the check still sees one after it.
    const root = std.mem.trimEnd(u8, real_root, "/");
    return real.len > root.len + 1 and
        std.mem.startsWith(u8, real, root) and
        real[root.len] == std.fs.path.sep;
}

/// Bun's type guess for the files a Vite build emits, with the charset it adds to text types.
fn contentTypeFor(relative: []const u8) []const u8 {
    const Entry = struct { []const u8, []const u8 };
    const table = [_]Entry{
        .{ ".html", "text/html;charset=utf-8" },
        .{ ".htm", "text/html;charset=utf-8" },
        .{ ".js", "text/javascript;charset=utf-8" },
        .{ ".mjs", "text/javascript;charset=utf-8" },
        .{ ".css", "text/css;charset=utf-8" },
        .{ ".json", "application/json;charset=utf-8" },
        .{ ".map", "application/json;charset=utf-8" },
        .{ ".txt", "text/plain;charset=utf-8" },
        .{ ".svg", "image/svg+xml" },
        .{ ".png", "image/png" },
        .{ ".jpg", "image/jpeg" },
        .{ ".jpeg", "image/jpeg" },
        .{ ".gif", "image/gif" },
        .{ ".webp", "image/webp" },
        .{ ".ico", "image/x-icon" },
        .{ ".woff", "font/woff" },
        .{ ".woff2", "font/woff2" },
        .{ ".ttf", "font/ttf" },
        .{ ".otf", "font/otf" },
        .{ ".wasm", "application/wasm" },
        .{ ".webmanifest", "application/manifest+json" },
    };
    const ext = std.fs.path.extension(relative);
    for (table) |entry| if (std.ascii.eqlIgnoreCase(ext, entry[0])) return entry[1];
    return "application/octet-stream";
}

fn respondWith(res: *httpz.Response, body: []u8, relative: []const u8, pwa: ?PwaHeaders) void {
    res.body = body;
    // A dist's own sw.js and manifest need the same cache and scope headers as the built-in ones.
    if (pwa) |headers| {
        res.header("content-type", headers.content_type);
        res.header("cache-control", "no-cache");
        if (headers.service_worker_allowed) res.header("service-worker-allowed", "/");
    } else {
        res.header("content-type", contentTypeFor(relative));
    }
}

/// `staticResponse` of ui-dist.ts. True when a file answered. Dist files are served for GET only;
/// the built-in PWA fallback files need the embedded UI and are not available yet.
pub fn serve(io: std.Io, res: *httpz.Response, dist: ?[]const u8, method: []const u8, path: []const u8) Error!bool {
    const root = dist orelse return false;
    if (!std.mem.eql(u8, method, "GET")) return false;
    const relative = (try relativeFor(res.arena, path)) orelse return false;
    const body = (try readDistFile(io, res.arena, root, relative)) orelse return false;
    respondWith(res, body, relative, pwaHeaders(path));
    return true;
}

/// The `/` entry on any Host but the loopback one: main.ts fetches `/_app`, which is the dist's
/// index.html.
pub fn serveEntry(io: std.Io, res: *httpz.Response, dist: ?[]const u8) Error!bool {
    const root = dist orelse return false;
    const body = (try readDistFile(io, res.arena, root, "index.html")) orelse return false;
    respondWith(res, body, "index.html", null);
    return true;
}

const testing = std.testing;

fn expectRelative(expected: ?[]const u8, request_path: []const u8) !void {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const got = try relativeFor(arena_state.allocator(), request_path);
    if (expected) |want| {
        try testing.expectEqualStrings(want, got orelse return error.TestExpectedNonNull);
    } else {
        try testing.expectEqual(@as(?[]const u8, null), got);
    }
}

test "static: request paths map to dist-relative files" {
    try expectRelative("index.html", "/_app");
    try expectRelative("assets/app.js", "/assets/app.js");
    try expectRelative("a b.txt", "/a%20b.txt");
    try expectRelative("a/b.txt", "/a%2Fb.txt");
    try expectRelative("b.js", "/a/../b.js");
    try expectRelative("a/b.js", "/a/./b.js");
    try expectRelative("a/b.js", "/a//b.js");
    try expectRelative("\u{0105}.txt", "/%C4%85.txt");
}

test "static: paths outside the root and malformed input are refused" {
    try expectRelative(null, "/");
    try expectRelative(null, "/../etc/passwd");
    try expectRelative(null, "/a/../../etc/passwd");
    try expectRelative(null, "/%2e%2e/etc/passwd");
    try expectRelative(null, "/..%2fetc/passwd");
    try expectRelative(null, "//etc/passwd");
    try expectRelative(null, "/%2Fetc/passwd");
    try expectRelative(null, "/bad%zz");
    try expectRelative(null, "/bad%");
    try expectRelative(null, "/bad%4");
    try expectRelative(null, "/nul%00.js");
    try expectRelative(null, "/%ff");
    try expectRelative(null, "/%c3");
    try expectRelative(null, "/a/..");
    try expectRelative(null, "");
    try expectRelative(null, "no-slash");
}

fn relativeOnce(gpa: std.mem.Allocator, request_path: []const u8) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    _ = try relativeFor(arena_state.allocator(), request_path);
}

test "static: path decoding frees everything on allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, relativeOnce, .{"/assets/%C4%85/../app.js"});
}

test "static: PWA headers match pwa.ts" {
    try testing.expectEqualStrings("application/manifest+json", pwaHeaders("/manifest.webmanifest").?.content_type);
    try testing.expectEqualStrings("image/svg+xml", pwaHeaders("/icon.svg").?.content_type);
    const sw = pwaHeaders("/sw.js").?;
    try testing.expectEqualStrings("text/javascript; charset=utf-8", sw.content_type);
    try testing.expect(sw.service_worker_allowed);
    try testing.expect(!pwaHeaders("/icon.svg").?.service_worker_allowed);
    try testing.expect(pwaHeaders("/other.js") == null);
    try testing.expect(pwaHeaders("/sw.js/") == null);
}

fn tmpDist(tmp: *testing.TmpDir) ![:0]u8 {
    return tmp.dir.realPathFileAlloc(testing.io, ".", testing.allocator);
}

test "static: serves a dist file and refuses what lies outside it, symlinks included" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "dist/assets");
    try tmp.dir.writeFile(io, .{ .sub_path = "dist/index.html", .data = "<p>hi</p>" });
    try tmp.dir.writeFile(io, .{ .sub_path = "dist/assets/app.js", .data = "let a" });
    try tmp.dir.writeFile(io, .{ .sub_path = "dist/sw.js", .data = "self" });
    try tmp.dir.writeFile(io, .{ .sub_path = "secret.txt", .data = "top secret" });
    try tmp.dir.symLink(io, "../secret.txt", "dist/leak.txt", .{});
    try tmp.dir.symLink(io, "assets/app.js", "dist/inner.js", .{});
    try tmp.dir.symLink(io, "..", "dist/up", .{});

    const tmp_path = try tmpDist(&tmp);
    defer testing.allocator.free(tmp_path);
    const dist = try std.fs.path.join(testing.allocator, &.{ tmp_path, "dist" });
    defer testing.allocator.free(dist);

    {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        try testing.expect(try serve(io, web.res, dist, "GET", "/_app"));
        try testing.expectEqualStrings("<p>hi</p>", web.res.body);
        try testing.expectEqualStrings("text/html;charset=utf-8", web.res.headers.get("content-type").?);
    }
    {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        try testing.expect(try serve(io, web.res, dist, "GET", "/assets/app.js"));
        try testing.expectEqualStrings("let a", web.res.body);
        try testing.expectEqualStrings("text/javascript;charset=utf-8", web.res.headers.get("content-type").?);
        try testing.expect(web.res.headers.get("cache-control") == null);
    }
    {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        try testing.expect(try serve(io, web.res, dist, "GET", "/inner.js"));
        try testing.expectEqualStrings("let a", web.res.body);
    }
    {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        try testing.expect(try serve(io, web.res, dist, "GET", "/sw.js"));
        try testing.expectEqualStrings("text/javascript; charset=utf-8", web.res.headers.get("content-type").?);
        try testing.expectEqualStrings("no-cache", web.res.headers.get("cache-control").?);
        try testing.expectEqualStrings("/", web.res.headers.get("service-worker-allowed").?);
        try testing.expectEqual(@as(usize, 3), web.res.headers.len);
    }
    const refused = [_][]const u8{ "/leak.txt", "/up/secret.txt", "/up", "/assets", "/missing.js", "/../secret.txt", "/%2e%2e/secret.txt", "/", "/bad%zz" };
    for (refused) |path| {
        var web = httpz.testing.init(.{});
        defer web.deinit();
        try testing.expect(!try serve(io, web.res, dist, "GET", path));
        try testing.expectEqualStrings("", web.res.body);
    }
}

test "static: only GET reads the dist, and no dist means nothing is served" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "index.html", .data = "x" });
    const dist = try tmpDist(&tmp);
    defer testing.allocator.free(dist);

    var web = httpz.testing.init(.{});
    defer web.deinit();
    try testing.expect(!try serve(io, web.res, dist, "POST", "/_app"));
    try testing.expect(!try serve(io, web.res, dist, "HEAD", "/_app"));
    try testing.expect(!try serve(io, web.res, null, "GET", "/_app"));
    try testing.expect(!try serveEntry(io, web.res, null));
    try testing.expect(try serveEntry(io, web.res, dist));
    try testing.expectEqualStrings("x", web.res.body);
}

test "static: a missing or unreadable dist directory answers nothing" {
    var web = httpz.testing.init(.{});
    defer web.deinit();
    try testing.expect(!try serve(testing.io, web.res, "/nonexistent/harness-dist", "GET", "/_app"));
}

test "static: underRoot needs a separator after the root" {
    try testing.expect(underRoot("/srv/dist", "/srv/dist/a.js"));
    try testing.expect(!underRoot("/srv/dist", "/srv/dist"));
    try testing.expect(!underRoot("/srv/dist", "/srv/dist2/a.js"));
    try testing.expect(!underRoot("/srv/dist", "/srv/a.js"));
    try testing.expect(underRoot("/", "/a.js"));
    try testing.expect(underRoot("/", "/a/b.js"));
    try testing.expect(!underRoot("/", "/"));
    try testing.expect(underRoot("/srv/dist/", "/srv/dist/a.js"));
}
