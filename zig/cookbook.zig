//! Root of the cookbook test module. It sits one level above cookbook/ so the snippets can import
//! the real code under src/. Every file is a compiled, tested pattern for Zig 0.17; PORTING.md
//! indexes them.
test {
    _ = @import("cookbook/app_lock.zig");
    _ = @import("cookbook/arena_request.zig");
    _ = @import("cookbook/crypto.zig");
    _ = @import("cookbook/enums.zig");
    _ = @import("cookbook/fs_io.zig");
    _ = @import("cookbook/http_route.zig");
    _ = @import("cookbook/ids_time.zig");
    _ = @import("cookbook/json_parity.zig");
    _ = @import("cookbook/leak_checks.zig");
    _ = @import("cookbook/kill_group.zig");
    _ = @import("cookbook/random_secure.zig");
    _ = @import("cookbook/select_timeout.zig");
    _ = @import("cookbook/spawn_ndjson.zig");
    _ = @import("cookbook/sqlite.zig");
    _ = @import("cookbook/websocket.zig");
}
