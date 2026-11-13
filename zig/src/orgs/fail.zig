//! What can go wrong in the orgs slice and the answer each failure gets. Refusals are plain Zig
//! errors so a guard can `try` its way out; every message is a fixed string, as in routes*.ts.
//! A refusal after a write rolls the transaction back, and no TS path writes before it refuses.
const std = @import("std");
const codes = @import("../auth/codes.zig");
const headers = @import("../http/headers.zig");
const sqlite = @import("../db/sqlite.zig");

pub const Error = codes.Error || error{
    NotFound,
    Forbidden,
    StepUpRequired,
    InvalidBody,
    LastOwner,
    /// UNIQUE or PRIMARY KEY failure: 409 `conflict`.
    Conflict,
    /// Any other constraint failure, and a bad slug or handle: 400 `invalid`.
    Invalid,
    AgentsCannotBeAdmins,
    MemberNotInOrg,
    TeamNotInOrg,
    TeamOrMemberNotInOrg,
    InvalidOrg,
    UnknownAgent,
    ReportsToForeign,
    ReportsToCycle,
};

/// `routeError` of route-kit.ts for these errors; anything else falls through to the shared
/// mapping (500 `internal`).
pub fn mapped(err: anyerror) headers.Mapped {
    return switch (err) {
        error.StepUpRequired => .{ .status = 403, .message = "step_up_required" },
        error.LastOwner => .{ .status = 409, .message = "last_owner" },
        error.Invalid => .{ .status = 400, .message = "invalid" },
        error.AgentsCannotBeAdmins => .{ .status = 400, .message = "agents cannot be admins" },
        error.MemberNotInOrg => .{ .status = 400, .message = "member not in org" },
        error.TeamNotInOrg => .{ .status = 400, .message = "team not in org" },
        error.TeamOrMemberNotInOrg => .{ .status = 400, .message = "team or member not in org" },
        error.InvalidOrg => .{ .status = 400, .message = "invalid org" },
        error.UnknownAgent => .{ .status = 400, .message = "unknown agent" },
        error.ReportsToForeign => .{ .status = 400, .message = "reports_to must be a position in the same org" },
        error.ReportsToCycle => .{ .status = 400, .message = "reports_to would create a cycle" },
        else => headers.mapError(err),
    };
}

/// Answers `err` the way the server would, for the handlers that return it directly.
pub fn send(res: anytype, err: anyerror) !void {
    const answer = mapped(err);
    if (answer.status == 500) std.log.err("orgs: request failed: {t}", .{err});
    try headers.sendError(res, answer.status, answer.message);
}

/// SQLite reports UNIQUE and PRIMARY KEY failures as "UNIQUE constraint failed: ..."; the wrapper
/// folds every constraint kind into `error.Constraint`, so the message is the only way left to
/// tell a 409 from a 400. Must be asked before anything else touches the connection.
pub fn classify(db: sqlite.Db, err: anyerror) anyerror {
    if (err != error.Constraint) return err;
    return if (std.mem.startsWith(u8, db.errmsg(), "UNIQUE constraint failed")) error.Conflict else error.Invalid;
}

fn Returns(comptime f: anytype) type {
    return @typeInfo(@TypeOf(f)).@"fn".return_type.?;
}

/// Runs `f(db, args)` in a transaction under the state lock and turns constraint failures into
/// `Conflict` or `Invalid` before the rollback can overwrite the message.
pub fn inTx(app: anytype, args: anytype, comptime f: anytype) Returns(f) {
    const Wrapped = struct {
        fn call(db: sqlite.Db, a: @TypeOf(args)) Returns(f) {
            return f(db, a) catch |err| return @errorCast(classify(db, err));
        }
    };
    return codes.runTx(app, args, Wrapped.call);
}
