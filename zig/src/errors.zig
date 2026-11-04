//! Error kinds the HTTP layer maps to a status code.
const std = @import("std");

pub const Kind = enum {
    bad_request,
    unauthorized,
    forbidden,
    not_found,
    conflict,
    payload_too_large,
    too_many_requests,
    internal,

    pub fn status(kind: Kind) u16 {
        return switch (kind) {
            .bad_request => 400,
            .unauthorized => 401,
            .forbidden => 403,
            .not_found => 404,
            .conflict => 409,
            .payload_too_large => 413,
            .too_many_requests => 429,
            .internal => 500,
        };
    }
};

test "errors: every kind maps to a 4xx or 5xx status" {
    for (std.enums.values(Kind)) |kind| {
        const code = kind.status();
        try std.testing.expect(code >= 400 and code <= 599);
    }
}
