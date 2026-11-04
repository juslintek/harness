//! WebAuthn registration and authentication verification, and the options JSON the auth routes send.
//!
//! Reference: @simplewebauthn/server 14.0.3 as configured by code/src/server/features/auth/passkeys.ts
//! (`attestationType: "none"`, user verification required at registration and at step-up). The
//! checks run in the same order as `verifyRegistrationResponse.js` and
//! `verifyAuthenticationResponse.js`, so a response with several faults reports the same first one.
//! Deliberate differences are listed at the end of this comment.
//!
//! - `attStmt` is parsed and ignored for every format except `none`, which must carry an empty one
//!   (plan 5.4, C9). simplewebauthn verifies packed, fido-u2f, tpm, android-key, android-safetynet
//!   and apple statements.
//! - The attestation object and a stored COSE key must be exactly one CBOR item; simplewebauthn
//!   ignores trailing bytes. Tags, indefinite lengths and truncated strings are refused; tiny-cbor
//!   silently shortens a truncated byte string.
//! - A credential id longer than 1023 bytes, or empty, is refused at registration.
//! - Base64url fields are decoded strictly; @hexagon/base64 does not validate its input.
//! - `clientDataJSON` goes through std.json, which rejects invalid UTF-8 and lone surrogate escapes
//!   that JSON.parse accepts.
//! - Keys are only accepted when `kty` and the curve fit the algorithm and the key material is
//!   valid; RSA moduli of 2048, 3072 and 4096 bits are supported.
//! - The Firefox 117 EdDSA authData workaround in parseAuthenticatorData.js is not ported.
//! - Failure messages are fixed strings; simplewebauthn's messages embed the offending values.
const std = @import("std");
const cbor = @import("cbor.zig");
const cose = @import("cose.zig");

const Allocator = std.mem.Allocator;
const Sha256 = std.crypto.hash.sha2.Sha256;
const b64 = std.base64.url_safe_no_pad;

pub const challenge_len = 43;
pub const max_credential_id_len = 1023;
/// Largest decoded base64url field (client data, attestation object, authenticator data).
pub const max_field_bytes = 64 * 1024;
pub const default_timeout_ms = 60000;
pub const default_algs = cose.default_algs;

pub const Error = error{
    MissingCredentialId,
    CredentialIdNotBase64Url,
    UnexpectedCredentialType,
    InvalidEncoding,
    InvalidClientData,
    UnexpectedClientDataType,
    UnexpectedChallenge,
    UnexpectedOrigin,
    UnexpectedTopOrigin,
    InvalidTokenBinding,
    InvalidAttestationObject,
    InvalidAuthenticatorData,
    UnexpectedRpIdHash,
    UserNotPresent,
    UserNotVerified,
    NoCredentialId,
    CredentialIdTooLong,
    NoPublicKey,
    MissingPublicKeyAlg,
    UnsupportedAlgorithm,
    InvalidPublicKey,
    UnsupportedAttestationFormat,
    UnexpectedAttestationStatement,
    InvalidBackupFlags,
    CounterNotIncreased,
    SignatureInvalid,
    OutOfMemory,
};

/// The `reason` text for the `{error}` body of a failed ceremony.
pub fn message(err: Error) []const u8 {
    return switch (err) {
        error.MissingCredentialId => "Missing credential ID",
        error.CredentialIdNotBase64Url => "Credential ID was not base64url-encoded",
        error.UnexpectedCredentialType => "Unexpected credential type, expected \"public-key\"",
        error.InvalidEncoding => "Credential response field was not a base64url string",
        error.InvalidClientData => "Credential response clientDataJSON was not valid",
        error.UnexpectedClientDataType => "Unexpected response type",
        error.UnexpectedChallenge => "Unexpected response challenge",
        error.UnexpectedOrigin => "Unexpected response origin",
        error.UnexpectedTopOrigin => "Unexpected top origin in the response",
        error.InvalidTokenBinding => "Unexpected value for TokenBinding",
        error.InvalidAttestationObject => "Attestation object was not valid CBOR",
        error.InvalidAuthenticatorData => "Authenticator data was not valid",
        error.UnexpectedRpIdHash => "Unexpected RP ID hash",
        error.UserNotPresent => "User presence was required, but user was not present",
        error.UserNotVerified => "User verification was required, but user could not be verified",
        error.NoCredentialId => "No credential ID was provided by authenticator",
        error.CredentialIdTooLong => "Credential ID was longer than 1023 bytes",
        error.NoPublicKey => "No public key was provided by authenticator",
        error.MissingPublicKeyAlg => "Credential public key was missing numeric alg",
        error.UnsupportedAlgorithm => "Unexpected public key alg",
        error.InvalidPublicKey => "Credential public key was not valid",
        error.UnsupportedAttestationFormat => "Unsupported Attestation Format",
        error.UnexpectedAttestationStatement => "None attestation had unexpected attestation statement",
        error.InvalidBackupFlags => "Single-device credential indicated that it was backed up, which should be impossible.",
        error.CounterNotIncreased => "Response counter value was lower than expected",
        error.SignatureInvalid => "not verified",
        error.OutOfMemory => "out of memory",
    };
}

/// The JSON a browser's `credentials.create()` and `credentials.get()` produce through
/// `@simplewebauthn/browser`. Every field is optional because the route passes the body through
/// unchecked; a missing one is the verifier's failure. Field names are the JSON keys.
pub const Credential = struct {
    id: ?[]const u8 = null,
    rawId: ?[]const u8 = null,
    type: ?[]const u8 = null,
    response: ?Inner = null,

    pub const Inner = struct {
        clientDataJSON: ?[]const u8 = null,
        attestationObject: ?[]const u8 = null,
        authenticatorData: ?[]const u8 = null,
        signature: ?[]const u8 = null,
        transports: ?[]const []const u8 = null,
    };
};

pub const RegistrationInput = struct {
    response: Credential,
    expected_challenge: []const u8,
    expected_origin: []const u8,
    expected_rp_id: []const u8,
    require_user_presence: bool = true,
    require_user_verification: bool = true,
    supported_algs: []const i32 = &default_algs,
};

pub const Registration = struct {
    /// base64url of the credential id in the authenticator data, the value stored as passkeys.id.
    credential_id: []u8,
    /// COSE key re-encoded the way simplewebauthn does, the value stored as passkeys.public_key.
    public_key: []u8,
    counter: u32,
    alg: i32,
    user_verified: bool,
    backup_eligible: bool,
    backed_up: bool,

    pub fn deinit(self: Registration, gpa: Allocator) void {
        gpa.free(self.credential_id);
        gpa.free(self.public_key);
    }
};

pub const AuthenticationInput = struct {
    response: Credential,
    expected_challenge: []const u8,
    expected_origin: []const u8,
    expected_rp_id: []const u8,
    /// Step-up sets this; login does not (passkeys.ts: `purpose === "step_up"`).
    require_user_verification: bool = true,
    credential_public_key: []const u8,
    credential_counter: u32,
};

pub const Authentication = struct {
    /// Store with max(stored, new_counter) so a slower parallel assertion cannot lower it.
    new_counter: u32,
    user_verified: bool,
    backup_eligible: bool,
    backed_up: bool,
};

const Flags = struct {
    up: bool,
    uv: bool,
    be: bool,
    bs: bool,
    at: bool,
    ed: bool,

    fn parse(byte: u8) Flags {
        return .{
            .up = byte & 0x01 != 0,
            .uv = byte & 0x04 != 0,
            .be = byte & 0x08 != 0,
            .bs = byte & 0x10 != 0,
            .at = byte & 0x40 != 0,
            .ed = byte & 0x80 != 0,
        };
    }
};

const Attested = struct {
    credential_id: []const u8,
    public_key: cbor.Value,
};

const AuthData = struct {
    rp_id_hash: [32]u8,
    flags: Flags,
    counter: u32,
    attested: ?Attested,
};

/// parseAuthenticatorData.js. Every malformed shape is `InvalidAuthenticatorData`.
fn parseAuthData(arena: Allocator, bytes: []const u8) Error!AuthData {
    if (bytes.len < 37) return error.InvalidAuthenticatorData;
    const flags = Flags.parse(bytes[32]);
    var pos: usize = 37;
    var attested: ?Attested = null;
    if (flags.at) {
        // aaguid (16) and the credential id length (2) come before the id.
        if (bytes.len - pos < 18) return error.InvalidAuthenticatorData;
        const id_len = std.mem.readInt(u16, bytes[pos + 16 ..][0..2], .big);
        pos += 18;
        if (id_len > bytes.len - pos) return error.InvalidAuthenticatorData;
        const credential_id = bytes[pos..][0..id_len];
        pos += id_len;
        const key = try decodeItem(arena, bytes[pos..]);
        pos += key.len;
        attested = .{ .credential_id = credential_id, .public_key = key.value };
    }
    if (flags.ed) {
        const extensions = try decodeItem(arena, bytes[pos..]);
        if (extensions.value != .map) return error.InvalidAuthenticatorData;
        pos += extensions.len;
    }
    if (pos != bytes.len) return error.InvalidAuthenticatorData;
    return .{
        .rp_id_hash = bytes[0..32].*,
        .flags = flags,
        .counter = std.mem.readInt(u32, bytes[33..37], .big),
        .attested = attested,
    };
}

fn decodeItem(arena: Allocator, bytes: []const u8) Error!cbor.First {
    return cbor.decodeFirstArena(arena, bytes) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => error.InvalidAuthenticatorData,
    };
}

fn decodeBase64(arena: Allocator, text: []const u8) Error![]u8 {
    // simplewebauthn accepts padding on these fields (isBase64URL trims it).
    const trimmed = std.mem.trimEnd(u8, text, "=");
    const size = b64.Decoder.calcSizeForSlice(trimmed) catch return error.InvalidEncoding;
    if (size > max_field_bytes) return error.InvalidEncoding;
    const out = try arena.alloc(u8, size);
    b64.Decoder.decode(out, trimmed) catch return error.InvalidEncoding;
    return out;
}

fn constEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, b) |x, y| diff |= x ^ y;
    return diff == 0;
}

fn rpIdMatches(hash: [32]u8, rp_id: []const u8) bool {
    var expected: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(rp_id, &expected, .{});
    return std.mem.eql(u8, &expected, &hash);
}

/// JS truthiness of a parsed JSON value, which is what `if (tokenBinding)` and `if (topOrigin)`
/// test in simplewebauthn.
fn truthy(v: std.json.Value) bool {
    return switch (v) {
        .null => false,
        .bool => |b| b,
        .integer => |n| n != 0,
        .float => |f| f != 0,
        .number_string => true,
        .string => |s| s.len != 0,
        .array, .object => true,
    };
}

const ClientData = struct {
    kind: ?[]const u8,
    challenge: ?[]const u8,
    origin: ?[]const u8,
    top_origin: bool,
    token_binding: ?std.json.Value,

    fn stringField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
        const v = obj.get(key) orelse return null;
        return if (v == .string) v.string else null;
    }
};

/// decodeClientDataJSON.js: JSON.parse of the UTF-8 text. A repeated key keeps its last value, as
/// in JS.
fn parseClientData(arena: Allocator, json: []const u8) Error!ClientData {
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena, json, .{ .duplicate_field_behavior = .use_last }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidClientData,
    };
    if (root != .object) return error.InvalidClientData;
    const obj = root.object;
    const top_origin = if (obj.get("topOrigin")) |v| truthy(v) else false;
    const binding = if (obj.get("tokenBinding")) |v| (if (truthy(v)) v else null) else null;
    return .{
        .kind = ClientData.stringField(obj, "type"),
        .challenge = ClientData.stringField(obj, "challenge"),
        .origin = ClientData.stringField(obj, "origin"),
        .top_origin = top_origin,
        .token_binding = binding,
    };
}

fn checkTokenBinding(binding: ?std.json.Value, statuses: []const []const u8) Error!void {
    const v = binding orelse return;
    if (v != .object) return error.InvalidTokenBinding;
    const status = v.object.get("status") orelse return error.InvalidTokenBinding;
    if (status != .string) return error.InvalidTokenBinding;
    for (statuses) |ok| if (std.mem.eql(u8, ok, status.string)) return;
    return error.InvalidTokenBinding;
}

fn isNonEmpty(text: ?[]const u8) ?[]const u8 {
    const t = text orelse return null;
    return if (t.len == 0) null else t;
}

fn isSet(opt: ?[]const u8, want: []const u8) bool {
    return if (opt) |t| std.mem.eql(u8, t, want) else false;
}

fn isBackupInvalid(flags: Flags) bool {
    return flags.bs and !flags.be;
}

const registration_statuses = [_][]const u8{ "present", "supported", "not-supported" };
const authentication_statuses = [_][]const u8{ "present", "supported", "notSupported" };

const attestation_formats = [_][]const u8{ "none", "packed", "fido-u2f", "android-safetynet", "android-key", "tpm", "apple" };

/// verifyRegistrationResponse.js with the attestation policy described at the top of this file.
pub fn verifyRegistration(gpa: Allocator, input: RegistrationInput) Error!Registration {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const credential = input.response;
    const id = isNonEmpty(credential.id) orelse return error.MissingCredentialId;
    if (credential.rawId == null or !std.mem.eql(u8, id, credential.rawId.?)) return error.CredentialIdNotBase64Url;
    if (!isSet(credential.type, "public-key")) return error.UnexpectedCredentialType;
    const inner = credential.response orelse return error.InvalidClientData;

    const client_json = try decodeBase64(arena, inner.clientDataJSON orelse return error.InvalidClientData);
    const client = try parseClientData(arena, client_json);
    if (!isSet(client.kind, "webauthn.create")) return error.UnexpectedClientDataType;
    if (client.challenge == null or !constEql(client.challenge.?, input.expected_challenge)) return error.UnexpectedChallenge;
    if (!isSet(client.origin, input.expected_origin)) return error.UnexpectedOrigin;
    try checkTokenBinding(client.token_binding, &registration_statuses);

    const object_bytes = try decodeBase64(arena, inner.attestationObject orelse return error.InvalidAttestationObject);
    const object = cbor.decodeArena(arena, object_bytes) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidAttestationObject,
    };
    if (object != .map) return error.InvalidAttestationObject;
    const fmt = object.getText("fmt") orelse return error.InvalidAttestationObject;
    const auth_bytes_value = object.getText("authData") orelse return error.InvalidAttestationObject;
    const statement = object.getText("attStmt") orelse return error.InvalidAttestationObject;
    if (fmt != .text or auth_bytes_value != .bytes or statement != .map) return error.InvalidAttestationObject;

    const auth = try parseAuthData(arena, auth_bytes_value.bytes);
    if (!rpIdMatches(auth.rp_id_hash, input.expected_rp_id)) return error.UnexpectedRpIdHash;
    if (input.require_user_presence and !auth.flags.up) return error.UserNotPresent;
    if (input.require_user_verification and !auth.flags.uv) return error.UserNotVerified;
    const attested = auth.attested orelse return error.NoCredentialId;
    if (attested.credential_id.len == 0) return error.NoCredentialId;
    if (attested.credential_id.len > max_credential_id_len) return error.CredentialIdTooLong;
    if (attested.public_key != .map) return error.NoPublicKey;

    const alg = cose.algOf(attested.public_key) catch return error.MissingPublicKeyAlg;
    var supported = false;
    for (input.supported_algs) |candidate| supported = supported or candidate == alg;
    if (!supported) return error.UnsupportedAlgorithm;

    var known_format = false;
    for (attestation_formats) |name| known_format = known_format or std.mem.eql(u8, name, fmt.text);
    if (!known_format) return error.UnsupportedAttestationFormat;
    if (std.mem.eql(u8, fmt.text, "none") and statement.map.len > 0) return error.UnexpectedAttestationStatement;

    const key = cose.parseKey(attested.public_key) catch |err| switch (err) {
        error.UnsupportedAlgorithm => return error.UnsupportedAlgorithm,
        error.MissingAlg => return error.MissingPublicKeyAlg,
        error.InvalidKey => return error.InvalidPublicKey,
    };
    cose.check(key) catch return error.InvalidPublicKey;
    if (isBackupInvalid(auth.flags)) return error.InvalidBackupFlags;

    const credential_id = try gpa.alloc(u8, b64.Encoder.calcSize(attested.credential_id.len));
    errdefer gpa.free(credential_id);
    _ = b64.Encoder.encode(credential_id, attested.credential_id);
    const public_key = cbor.encode(gpa, attested.public_key) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidPublicKey,
    };
    return .{
        .credential_id = credential_id,
        .public_key = public_key,
        .counter = auth.counter,
        .alg = @intCast(alg),
        .user_verified = auth.flags.uv,
        .backup_eligible = auth.flags.be,
        .backed_up = auth.flags.bs,
    };
}

/// verifyAuthenticationResponse.js. The caller looks the credential up by `response.id` first and
/// checks that it belongs to the expected user, as passkeys.ts does.
pub fn verifyAuthentication(gpa: Allocator, input: AuthenticationInput) Error!Authentication {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const credential = input.response;
    const id = isNonEmpty(credential.id) orelse return error.MissingCredentialId;
    if (credential.rawId == null or !std.mem.eql(u8, id, credential.rawId.?)) return error.CredentialIdNotBase64Url;
    if (!isSet(credential.type, "public-key")) return error.UnexpectedCredentialType;
    const inner = credential.response orelse return error.InvalidClientData;

    const client_text = inner.clientDataJSON orelse return error.InvalidClientData;
    const client_json = try decodeBase64(arena, client_text);
    const client = try parseClientData(arena, client_json);
    if (!isSet(client.kind, "webauthn.get")) return error.UnexpectedClientDataType;
    if (client.challenge == null or !constEql(client.challenge.?, input.expected_challenge)) return error.UnexpectedChallenge;
    // passkeys.ts never passes expectedTopOrigin, so any truthy topOrigin is refused, whatever crossOrigin says.
    if (client.top_origin) return error.UnexpectedTopOrigin;
    if (!isSet(client.origin, input.expected_origin)) return error.UnexpectedOrigin;

    const auth_bytes = try decodeBase64(arena, inner.authenticatorData orelse return error.InvalidEncoding);
    const signature = try decodeBase64(arena, inner.signature orelse return error.InvalidEncoding);
    try checkTokenBinding(client.token_binding, &authentication_statuses);

    const auth = try parseAuthData(arena, auth_bytes);
    if (!rpIdMatches(auth.rp_id_hash, input.expected_rp_id)) return error.UnexpectedRpIdHash;
    if (!auth.flags.up) return error.UserNotPresent;
    if (input.require_user_verification and !auth.flags.uv) return error.UserNotVerified;

    var client_hash: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(client_json, &client_hash, .{});
    const signed = try arena.alloc(u8, auth_bytes.len + client_hash.len);
    @memcpy(signed[0..auth_bytes.len], auth_bytes);
    @memcpy(signed[auth_bytes.len..], &client_hash);

    // An authenticator without a counter reports 0 forever; anything else must strictly increase.
    if ((auth.counter > 0 or input.credential_counter > 0) and auth.counter <= input.credential_counter) {
        return error.CounterNotIncreased;
    }

    const stored = cbor.decodeArena(arena, input.credential_public_key) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidPublicKey,
    };
    _ = cose.algOf(stored) catch return error.MissingPublicKeyAlg;
    if (isBackupInvalid(auth.flags)) return error.InvalidBackupFlags;
    const key = cose.parseKey(stored) catch |err| switch (err) {
        error.UnsupportedAlgorithm => return error.UnsupportedAlgorithm,
        error.MissingAlg => return error.MissingPublicKeyAlg,
        error.InvalidKey => return error.InvalidPublicKey,
    };
    try cose.verify(key, signed, signature);
    return .{
        .new_counter = auth.counter,
        .user_verified = auth.flags.uv,
        .backup_eligible = auth.flags.be,
        .backed_up = auth.flags.bs,
    };
}

/// 32 random bytes as base64url, drawn from the OS entropy source, never a seeded generator.
pub fn newChallenge(io: std.Io) error{EntropyUnavailable}![challenge_len]u8 {
    var raw: [32]u8 = undefined;
    io.randomSecure(&raw) catch return error.EntropyUnavailable;
    var out: [challenge_len]u8 = undefined;
    _ = b64.Encoder.encode(&out, &raw);
    return out;
}

pub const CredentialDescriptor = struct {
    id: []const u8,
    transports: ?[]const []const u8 = null,
};

/// passkeys.transports is JSON text (`["internal"]`) or NULL.
pub fn parseTransports(arena: Allocator, raw: ?[]const u8) !?[]const []const u8 {
    const text = raw orelse return null;
    return try std.json.parseFromSliceLeaky([]const []const u8, arena, text, .{});
}

const descriptor_type = "public-key";

const DescriptorJson = struct {
    id: []const u8,
    transports: ?[]const []const u8 = null,
    type: []const u8 = descriptor_type,
};

fn descriptors(arena: Allocator, list: []const CredentialDescriptor) ![]DescriptorJson {
    const out = try arena.alloc(DescriptorJson, list.len);
    for (list, out) |src, *dst| dst.* = .{ .id = src.id, .transports = src.transports };
    return out;
}

pub const RegistrationOptionsInput = struct {
    rp_id: []const u8,
    rp_name: []const u8,
    /// users.id; the options carry the base64url of its UTF-8 bytes.
    user_id: []const u8,
    /// users.email
    user_name: []const u8,
    user_display_name: []const u8,
    challenge: []const u8,
    challenge_id: []const u8,
    exclude: []const CredentialDescriptor = &.{},
};

/// registrationOptions() in passkeys.ts: generateRegistrationOptions with `attestationType: "none"`,
/// `residentKey: "preferred"`, `userVerification: "required"`, the default algorithm list and
/// timeout, plus `challengeId`. Key order follows simplewebauthn's object literal.
pub fn registrationOptionsJson(gpa: Allocator, input: RegistrationOptionsInput) ![]u8 {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const user_id = try arena.alloc(u8, b64.Encoder.calcSize(input.user_id.len));
    _ = b64.Encoder.encode(user_id, input.user_id);
    var params: [default_algs.len]struct { alg: i32, type: []const u8 = descriptor_type } = undefined;
    for (&params, default_algs) |*param, alg| param.* = .{ .alg = alg };

    const body = .{
        .challenge = input.challenge,
        .rp = .{ .name = input.rp_name, .id = input.rp_id },
        .user = .{ .id = user_id, .name = input.user_name, .displayName = input.user_display_name },
        .pubKeyCredParams = params,
        .timeout = default_timeout_ms,
        .attestation = "none",
        .excludeCredentials = try descriptors(arena, input.exclude),
        .authenticatorSelection = .{ .residentKey = "preferred", .userVerification = "required", .requireResidentKey = false },
        .extensions = .{ .credProps = true },
        .hints = [0][]const u8{},
        .challengeId = input.challenge_id,
    };
    return std.json.Stringify.valueAlloc(gpa, body, .{ .emit_null_optional_fields = false });
}

pub const AuthenticationOptionsInput = struct {
    rp_id: []const u8,
    challenge: []const u8,
    challenge_id: []const u8,
    user_verification: enum { preferred, required },
    /// null leaves `allowCredentials` out (discoverable login); a list, even an empty one, emits it.
    allow: ?[]const CredentialDescriptor = null,
};

/// loginOptions() (`preferred`, no allow list) and stepUpOptions() (`required`, the user's
/// credentials) in passkeys.ts, plus `challengeId`.
pub fn authenticationOptionsJson(gpa: Allocator, input: AuthenticationOptionsInput) ![]u8 {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const allow: ?[]DescriptorJson = if (input.allow) |list| try descriptors(arena, list) else null;
    const body = .{
        .rpId = input.rp_id,
        .challenge = input.challenge,
        .allowCredentials = allow,
        .timeout = default_timeout_ms,
        .userVerification = @tagName(input.user_verification),
        .challengeId = input.challenge_id,
    };
    return std.json.Stringify.valueAlloc(gpa, body, .{ .emit_null_optional_fields = false });
}

const testing = std.testing;

const fixtures_json = @embedFile("fixtures/webauthn.json");

const RpJson = struct { id: []const u8, name: []const u8, origin: []const u8 };
const StoredJson = struct { publicKey: []const u8, counter: u32 };
const DescriptorFixture = struct { id: []const u8, transports: ?[]const u8 = null };

const Vector = struct {
    name: []const u8,
    kind: []const u8,
    alg: []const u8,
    zigError: ?[]const u8,
    input: struct {
        challenge: []const u8,
        origin: []const u8,
        rpId: []const u8,
        requireUserVerification: bool,
        response: Credential,
        credential: ?StoredJson = null,
    },
    ts: struct { accepted: bool, message: ?[]const u8 = null },
    divergence: ?[]const u8 = null,
    expect: ?struct {
        credentialId: ?[]const u8 = null,
        publicKey: ?[]const u8 = null,
        counter: ?u32 = null,
        newCounter: ?u32 = null,
        userVerified: ?bool = null,
        transports: ?[]const u8 = null,
    } = null,

    fn isRegistration(self: Vector) bool {
        return std.mem.eql(u8, self.kind, "registration");
    }
};

const OptionSet = struct {
    name: []const u8,
    kind: []const u8,
    input: struct {
        rp: RpJson,
        user: ?struct { id: []const u8, email: []const u8, name: []const u8 } = null,
        exclude: ?[]const DescriptorFixture = null,
        allow: ?[]const DescriptorFixture = null,
        challenge: []const u8,
        challengeId: []const u8,
    },
    expected: std.json.Value,
};

const Fixtures = struct {
    rp: RpJson,
    vectors: []const Vector,
    options: []const OptionSet,
};

fn loadFixtures() !std.json.Parsed(Fixtures) {
    return std.json.parseFromSlice(Fixtures, testing.allocator, fixtures_json, .{ .ignore_unknown_fields = true });
}

fn registrationInputOf(v: Vector) RegistrationInput {
    return .{
        .response = v.input.response,
        .expected_challenge = v.input.challenge,
        .expected_origin = v.input.origin,
        .expected_rp_id = v.input.rpId,
        .require_user_verification = v.input.requireUserVerification,
    };
}

fn authenticationInputOf(arena: Allocator, v: Vector) !AuthenticationInput {
    const stored = v.input.credential.?;
    return .{
        .response = v.input.response,
        .expected_challenge = v.input.challenge,
        .expected_origin = v.input.origin,
        .expected_rp_id = v.input.rpId,
        .require_user_verification = v.input.requireUserVerification,
        .credential_public_key = try decodeBase64(arena, stored.publicKey),
        .credential_counter = stored.counter,
    };
}

fn expectVector(v: Vector) !void {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    if (v.isRegistration()) {
        const result = verifyRegistration(testing.allocator, registrationInputOf(v));
        if (v.zigError) |want| {
            if (result) |ok| {
                ok.deinit(testing.allocator);
                return error.AcceptedButShouldFail;
            } else |err| try testing.expectEqualStrings(want, @errorName(err));
            return;
        }
        const ok = try result;
        defer ok.deinit(testing.allocator);
        const expect = v.expect orelse return;
        try testing.expectEqualStrings(expect.credentialId.?, ok.credential_id);
        try testing.expectEqualSlices(u8, try decodeBase64(arena, expect.publicKey.?), ok.public_key);
        try testing.expectEqual(expect.counter.?, ok.counter);
        try testing.expectEqual(expect.userVerified.?, ok.user_verified);
    } else {
        const result = verifyAuthentication(testing.allocator, try authenticationInputOf(arena, v));
        if (v.zigError) |want| {
            if (result) |_| return error.AcceptedButShouldFail else |err| try testing.expectEqualStrings(want, @errorName(err));
            return;
        }
        const ok = try result;
        try testing.expectEqual(v.expect.?.newCounter.?, ok.new_counter);
    }
}

test "webauthn: every recorded vector gets the recorded verdict" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    var positives: usize = 0;
    for (parsed.value.vectors) |v| {
        expectVector(v) catch |err| {
            std.debug.print("vector failed: {s}\n", .{v.name});
            return err;
        };
        if (v.zigError == null) positives += 1;
    }
    try testing.expect(positives >= 14);
}

test "webauthn: Zig and simplewebauthn agree except where a divergence is written down" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    for (parsed.value.vectors) |v| {
        const zig_accepts = v.zigError == null;
        if (v.divergence != null) {
            try testing.expect(zig_accepts != v.ts.accepted);
        } else if (zig_accepts != v.ts.accepted) {
            std.debug.print("unexplained disagreement: {s}\n", .{v.name});
            return error.UnexplainedDivergence;
        }
    }
}

const required_categories = [_][]const u8{
    "UnexpectedChallenge",      "UnexpectedOrigin",    "UnexpectedRpIdHash",           "SignatureInvalid",
    "UserNotVerified",          "UserNotPresent",      "CounterNotIncreased",          "InvalidAttestationObject",
    "InvalidAuthenticatorData", "UnexpectedTopOrigin", "UnsupportedAlgorithm",         "InvalidBackupFlags",
    "UnexpectedClientDataType", "InvalidTokenBinding", "UnsupportedAttestationFormat", "CredentialIdTooLong",
};

test "webauthn: every algorithm has positive and negative vectors and every failure category is covered" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    for ([_][]const u8{ "es256", "eddsa", "rs256", "mldsa44" }) |alg| {
        var reg_ok = false;
        var auth_ok = false;
        var bad_signature = false;
        for (parsed.value.vectors) |v| {
            if (!std.mem.eql(u8, v.alg, alg)) continue;
            if (v.zigError == null) {
                if (v.isRegistration()) reg_ok = true else auth_ok = true;
            } else if (std.mem.eql(u8, v.zigError.?, "SignatureInvalid")) bad_signature = true;
        }
        try testing.expect(reg_ok and auth_ok and bad_signature);
    }
    for (required_categories) |category| {
        var seen = false;
        for (parsed.value.vectors) |v| seen = seen or (v.zigError != null and std.mem.eql(u8, v.zigError.?, category));
        if (!seen) std.debug.print("no vector for {s}\n", .{category});
        try testing.expect(seen);
    }
}

test "webauthn: public_key blobs written by the TS server parse, check and re-encode to the same bytes" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var seen: [default_algs.len]bool = @splat(false);
    for (parsed.value.vectors) |v| {
        const text = if (v.expect) |e| (e.publicKey orelse continue) else (v.input.credential orelse continue).publicKey;
        const blob = try decodeBase64(arena, text);
        const value = try cbor.decodeArena(arena, blob);
        const key = try cose.parseKey(value);
        try cose.check(key);
        const again = try cbor.encode(arena, value);
        try testing.expectEqualSlices(u8, blob, again);
        seen[
            switch (key) {
                .mldsa44 => 0,
                .eddsa => 1,
                .es256 => 2,
                .rs256 => 3,
            }
        ] = true;
    }
    for (seen) |s| try testing.expect(s);
}

test "webauthn: a stored blob with extra or missing bytes is refused" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var base: ?Vector = null;
    for (parsed.value.vectors) |v| {
        if (!v.isRegistration() and v.zigError == null and std.mem.eql(u8, v.alg, "es256")) {
            base = v;
            break;
        }
    }
    var input = try authenticationInputOf(arena, base.?);
    const blob = input.credential_public_key;
    input.credential_public_key = try std.mem.concat(arena, u8, &.{ blob, &.{0} });
    try testing.expectError(error.InvalidPublicKey, verifyAuthentication(testing.allocator, input));
    input.credential_public_key = blob[0 .. blob.len - 1];
    try testing.expectError(error.InvalidPublicKey, verifyAuthentication(testing.allocator, input));
    input.credential_public_key = "";
    try testing.expectError(error.InvalidPublicKey, verifyAuthentication(testing.allocator, input));
    // a key map without alg, and a key for an algorithm this server does not take
    input.credential_public_key = &.{ 0xa1, 0x01, 0x02 };
    try testing.expectError(error.MissingPublicKeyAlg, verifyAuthentication(testing.allocator, input));
    input.credential_public_key = &.{ 0xa1, 0x03, 0x38, 0x22 };
    try testing.expectError(error.UnsupportedAlgorithm, verifyAuthentication(testing.allocator, input));
}

fn jsonEqual(a: std.json.Value, b: std.json.Value) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    switch (a) {
        .null => return true,
        .bool => |x| return x == b.bool,
        .integer => |x| return x == b.integer,
        .float => |x| return x == b.float,
        .number_string => |x| return std.mem.eql(u8, x, b.number_string),
        .string => |x| return std.mem.eql(u8, x, b.string),
        .array => |x| {
            if (x.items.len != b.array.items.len) return false;
            for (x.items, b.array.items) |l, r| if (!jsonEqual(l, r)) return false;
            return true;
        },
        .object => |x| {
            if (x.count() != b.object.count()) return false;
            var it = x.iterator();
            while (it.next()) |entry| {
                const other = b.object.get(entry.key_ptr.*) orelse return false;
                if (!jsonEqual(entry.value_ptr.*, other)) return false;
            }
            return true;
        },
    }
}

fn descriptorsOf(arena: Allocator, list: ?[]const DescriptorFixture) !?[]const CredentialDescriptor {
    const src = list orelse return null;
    const out = try arena.alloc(CredentialDescriptor, src.len);
    for (src, out) |s, *d| d.* = .{ .id = s.id, .transports = try parseTransports(arena, s.transports) };
    return out;
}

test "webauthn: options JSON equals what the TS routes return" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var kinds: [3]bool = @splat(false);
    for (parsed.value.options) |o| {
        const rp = o.input.rp;
        const text = if (std.mem.eql(u8, o.kind, "registration")) blk: {
            kinds[0] = true;
            const user = o.input.user.?;
            break :blk try registrationOptionsJson(testing.allocator, .{
                .rp_id = rp.id,
                .rp_name = rp.name,
                .user_id = user.id,
                .user_name = user.email,
                .user_display_name = user.name,
                .challenge = o.input.challenge,
                .challenge_id = o.input.challengeId,
                .exclude = (try descriptorsOf(arena, o.input.exclude)) orelse &.{},
            });
        } else blk: {
            const step_up = std.mem.eql(u8, o.kind, "step_up");
            kinds[if (step_up) 2 else 1] = true;
            break :blk try authenticationOptionsJson(testing.allocator, .{
                .rp_id = rp.id,
                .challenge = o.input.challenge,
                .challenge_id = o.input.challengeId,
                .user_verification = if (step_up) .required else .preferred,
                .allow = try descriptorsOf(arena, o.input.allow),
            });
        };
        defer testing.allocator.free(text);
        const got = try std.json.parseFromSliceLeaky(std.json.Value, arena, text, .{});
        if (!jsonEqual(o.expected, got)) {
            std.debug.print("options differ: {s}\n  got: {s}\n", .{ o.name, text });
            return error.OptionsDiffer;
        }
    }
    for (kinds) |k| try testing.expect(k);
}

test "webauthn: options JSON keeps the key order of simplewebauthn's object literals" {
    const text = try registrationOptionsJson(testing.allocator, .{
        .rp_id = "localhost",
        .rp_name = "Harness",
        .user_id = "u1",
        .user_name = "a@example.com",
        .user_display_name = "Ada",
        .challenge = "chal",
        .challenge_id = "cid",
        .exclude = &.{.{ .id = "abc", .transports = &.{"internal"} }},
    });
    defer testing.allocator.free(text);
    try testing.expectEqualStrings(
        "{\"challenge\":\"chal\",\"rp\":{\"name\":\"Harness\",\"id\":\"localhost\"}," ++
            "\"user\":{\"id\":\"dTE\",\"name\":\"a@example.com\",\"displayName\":\"Ada\"}," ++
            "\"pubKeyCredParams\":[{\"alg\":-48,\"type\":\"public-key\"},{\"alg\":-8,\"type\":\"public-key\"}," ++
            "{\"alg\":-7,\"type\":\"public-key\"},{\"alg\":-257,\"type\":\"public-key\"}],\"timeout\":60000," ++
            "\"attestation\":\"none\",\"excludeCredentials\":[{\"id\":\"abc\",\"transports\":[\"internal\"],\"type\":\"public-key\"}]," ++
            "\"authenticatorSelection\":{\"residentKey\":\"preferred\",\"userVerification\":\"required\",\"requireResidentKey\":false}," ++
            "\"extensions\":{\"credProps\":true},\"hints\":[],\"challengeId\":\"cid\"}",
        text,
    );
    const login = try authenticationOptionsJson(testing.allocator, .{
        .rp_id = "localhost",
        .challenge = "chal",
        .challenge_id = "cid",
        .user_verification = .preferred,
    });
    defer testing.allocator.free(login);
    try testing.expectEqualStrings(
        "{\"rpId\":\"localhost\",\"challenge\":\"chal\",\"timeout\":60000,\"userVerification\":\"preferred\",\"challengeId\":\"cid\"}",
        login,
    );
}

test "webauthn: challenges are 43 base64url characters of 32 random bytes and differ" {
    const a = try newChallenge(testing.io);
    const b = try newChallenge(testing.io);
    try testing.expect(!std.mem.eql(u8, &a, &b));
    var raw: [32]u8 = undefined;
    try b64.Decoder.decode(&raw, &a);
}

test "webauthn: the challenge comparison is length-aware and exact" {
    try testing.expect(constEql("abc", "abc"));
    try testing.expect(!constEql("abc", "abd"));
    try testing.expect(!constEql("abc", "abcd"));
    try testing.expect(constEql("", ""));
}

test "webauthn: every error has a message" {
    inline for (@typeInfo(Error).error_set.error_names.?) |name| {
        try testing.expect(message(@field(Error, name)).len > 0);
    }
}

const KnownAnswer = struct {
    auth_data: []u8,
    client_json: []u8,
    signed: []u8,
};

/// An assertion built here instead of recorded from the TS stack: authenticator data with an
/// extension map when `ext` is set, a client data string and the bytes a key must sign.
fn buildAssertion(arena: Allocator, rp_id: []const u8, flags: u8, counter: u32, ext: ?[]const u8, challenge: []const u8) !KnownAnswer {
    var rp_hash: [32]u8 = undefined;
    Sha256.hash(rp_id, &rp_hash, .{});
    var auth: std.ArrayList(u8) = .empty;
    try auth.appendSlice(arena, &rp_hash);
    try auth.append(arena, flags);
    var counter_bytes: [4]u8 = undefined;
    std.mem.writeInt(u32, &counter_bytes, counter, .big);
    try auth.appendSlice(arena, &counter_bytes);
    if (ext) |bytes| try auth.appendSlice(arena, bytes);
    const client_json = try std.fmt.allocPrint(
        arena,
        "{{\"type\":\"webauthn.get\",\"challenge\":\"{s}\",\"origin\":\"https://example.test\",\"crossOrigin\":false}}",
        .{challenge},
    );
    var client_hash: [32]u8 = undefined;
    Sha256.hash(client_json, &client_hash, .{});
    const signed = try std.mem.concat(arena, u8, &.{ auth.items, &client_hash });
    return .{ .auth_data = auth.items, .client_json = client_json, .signed = signed };
}

fn b64Of(arena: Allocator, bytes: []const u8) ![]const u8 {
    const out = try arena.alloc(u8, b64.Encoder.calcSize(bytes.len));
    return b64.Encoder.encode(out, bytes);
}

fn credentialOf(arena: Allocator, answer: KnownAnswer, signature: []const u8) !Credential {
    return .{
        .id = "AQID",
        .rawId = "AQID",
        .type = "public-key",
        .response = .{
            .clientDataJSON = try b64Of(arena, answer.client_json),
            .authenticatorData = try b64Of(arena, answer.auth_data),
            .signature = try b64Of(arena, signature),
        },
    };
}

test "webauthn: ES256 assertion built with std, with authenticator extensions and the ED flag" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const Ecdsa = std.crypto.sign.ecdsa.EcdsaP256Sha256;
    const kp = try Ecdsa.KeyPair.generateDeterministic(@splat(5));
    const sec1 = kp.public_key.toUncompressedSec1();
    const blob = try cbor.encode(arena, .{ .map = &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 2 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -7 } },
        .{ .key = .{ .int = -1 }, .value = .{ .int = 1 } },
        .{ .key = .{ .int = -2 }, .value = .{ .bytes = sec1[1..33] } },
        .{ .key = .{ .int = -3 }, .value = .{ .bytes = sec1[33..65] } },
    } });
    // {"credProtect": 1, "hmac-secret": true}
    const ext = [_]u8{ 0xa2, 0x6b } ++ "credProtect".* ++ [_]u8{ 0x01, 0x6b } ++ "hmac-secret".* ++ [_]u8{0xf5};
    const answer = try buildAssertion(arena, "example.test", 0x01 | 0x04 | 0x80, 7, &ext, "Y2hhbGxlbmdl");
    var der_buf: [Ecdsa.Signature.der_encoded_length_max]u8 = undefined;
    const der = (try kp.sign(answer.signed, null)).toDer(&der_buf);
    const input: AuthenticationInput = .{
        .response = try credentialOf(arena, answer, der),
        .expected_challenge = "Y2hhbGxlbmdl",
        .expected_origin = "https://example.test",
        .expected_rp_id = "example.test",
        .credential_public_key = blob,
        .credential_counter = 6,
    };
    const ok = try verifyAuthentication(testing.allocator, input);
    try testing.expectEqual(@as(u32, 7), ok.new_counter);
    try testing.expect(ok.user_verified);

    // extension data that is not a map, and bytes after the extensions
    var bad = try buildAssertion(arena, "example.test", 0x01 | 0x80, 7, &.{0x01}, "Y2hhbGxlbmdl");
    var in2 = input;
    in2.response = try credentialOf(arena, bad, der);
    try testing.expectError(error.InvalidAuthenticatorData, verifyAuthentication(testing.allocator, in2));
    bad = try buildAssertion(arena, "example.test", 0x01 | 0x80, 7, &(ext ++ [_]u8{0x00}), "Y2hhbGxlbmdl");
    in2.response = try credentialOf(arena, bad, der);
    try testing.expectError(error.InvalidAuthenticatorData, verifyAuthentication(testing.allocator, in2));
    // a counter at the stored value
    in2 = input;
    in2.credential_counter = 7;
    try testing.expectError(error.CounterNotIncreased, verifyAuthentication(testing.allocator, in2));
}

test "webauthn: ML-DSA-44 assertion built with std verifies through the full path" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const MlDsa = std.crypto.sign.mldsa.MLDSA44;
    const kp = try MlDsa.KeyPair.generateDeterministic(@splat(11));
    const pub_bytes = kp.public_key.toBytes();
    const blob = try cbor.encode(arena, .{ .map = &.{
        .{ .key = .{ .int = 1 }, .value = .{ .int = 7 } },
        .{ .key = .{ .int = 3 }, .value = .{ .int = -48 } },
        .{ .key = .{ .int = -1 }, .value = .{ .bytes = &pub_bytes } },
    } });
    const answer = try buildAssertion(arena, "example.test", 0x01 | 0x04, 1, null, "Y2hhbGxlbmdl");
    const sig = (try kp.sign(answer.signed, null)).toBytes();
    var input: AuthenticationInput = .{
        .response = try credentialOf(arena, answer, &sig),
        .expected_challenge = "Y2hhbGxlbmdl",
        .expected_origin = "https://example.test",
        .expected_rp_id = "example.test",
        .credential_public_key = blob,
        .credential_counter = 0,
    };
    const ok = try verifyAuthentication(testing.allocator, input);
    try testing.expectEqual(@as(u32, 1), ok.new_counter);
    var tampered = sig;
    tampered[0] ^= 0x80;
    input.response = try credentialOf(arena, answer, &tampered);
    try testing.expectError(error.SignatureInvalid, verifyAuthentication(testing.allocator, input));
    // a valid signature over different authenticator data
    const other = try buildAssertion(arena, "example.test", 0x01 | 0x04, 2, null, "Y2hhbGxlbmdl");
    input.response = try credentialOf(arena, other, &sig);
    try testing.expectError(error.SignatureInvalid, verifyAuthentication(testing.allocator, input));
}

/// checkAllAllocationFailures needs the same allocation count on every run. An arena that grows
/// its last chunk in place changes that count with the heap layout, so the sweep hides resizing.
const NoResize = struct {
    child: Allocator,

    fn allocator(self: *NoResize) Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
        const self: *NoResize = @ptrCast(@alignCast(ctx));
        return self.child.rawAlloc(len, alignment, ret_addr);
    }

    fn resize(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) bool {
        return false;
    }

    fn remap(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) ?[*]u8 {
        return null;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
        const self: *NoResize = @ptrCast(@alignCast(ctx));
        self.child.rawFree(memory, alignment, ret_addr);
    }
};

fn sweepRegistration(gpa: Allocator, v: Vector) !void {
    var wrapped: NoResize = .{ .child = gpa };
    const ok = try verifyRegistration(wrapped.allocator(), registrationInputOf(v));
    ok.deinit(wrapped.allocator());
}

fn sweepAuthentication(gpa: Allocator, v: Vector) !void {
    var wrapped: NoResize = .{ .child = gpa };
    var arena_state: std.heap.ArenaAllocator = .init(wrapped.allocator());
    defer arena_state.deinit();
    _ = try verifyAuthentication(wrapped.allocator(), try authenticationInputOf(arena_state.allocator(), v));
}

test "webauthn: allocation failure at every point is an error without a leak" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    var reg_done: [4]bool = @splat(false);
    var auth_done: [4]bool = @splat(false);
    for (parsed.value.vectors) |v| {
        if (v.zigError != null) continue;
        const index: usize = if (std.mem.eql(u8, v.alg, "es256")) 0 else if (std.mem.eql(u8, v.alg, "eddsa")) 1 else if (std.mem.eql(u8, v.alg, "rs256")) 2 else 3;
        if (v.isRegistration()) {
            if (reg_done[index]) continue;
            reg_done[index] = true;
            try testing.checkAllAllocationFailures(testing.allocator, sweepRegistration, .{v});
        } else {
            if (auth_done[index]) continue;
            auth_done[index] = true;
            try testing.checkAllAllocationFailures(testing.allocator, sweepAuthentication, .{v});
        }
    }
    for (reg_done ++ auth_done) |d| try testing.expect(d);
}

fn mutatedText(arena: Allocator, rng: std.Random, text: []const u8) ![]const u8 {
    const original = try decodeBase64(arena, text);
    var bytes = try arena.dupe(u8, original);
    switch (rng.uintLessThan(u8, 5)) {
        0 => if (bytes.len > 0) {
            bytes[rng.uintLessThan(usize, bytes.len)] ^= @as(u8, 1) << rng.int(u3);
        },
        1 => if (bytes.len > 0) {
            bytes = bytes[0..rng.uintLessThan(usize, bytes.len)];
        },
        2 => {
            const extra = rng.uintLessThan(u8, 8) + 1;
            const grown = try arena.alloc(u8, bytes.len + extra);
            @memcpy(grown[0..bytes.len], bytes);
            rng.bytes(grown[bytes.len..]);
            bytes = grown;
        },
        3 => if (bytes.len > 0) {
            // overwrite a run with 0xff, which turns lengths and counts into the largest values
            const at = rng.uintLessThan(usize, bytes.len);
            const run = @min(bytes.len - at, rng.uintLessThan(usize, 9) + 1);
            @memset(bytes[at..][0..run], 0xff);
        },
        else => if (bytes.len > 1) {
            const at = rng.uintLessThan(usize, bytes.len - 1);
            std.mem.swap(u8, &bytes[at], &bytes[at + 1]);
        },
    }
    return b64Of(arena, bytes);
}

test "webauthn: a few thousand mutated ceremonies never crash and a mutated assertion never verifies" {
    const parsed = try loadFixtures();
    defer parsed.deinit();
    var prng = std.Random.DefaultPrng.init(0x7765626175746e31);
    const rng = prng.random();
    var seeds: std.ArrayList(Vector) = .empty;
    defer seeds.deinit(testing.allocator);
    for (parsed.value.vectors) |v| if (v.zigError == null) try seeds.append(testing.allocator, v);

    var accepted_registrations: usize = 0;
    for (0..3000) |round| {
        var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        const seed = seeds.items[rng.uintLessThan(usize, seeds.items.len)];
        var v = seed;
        var inner = v.input.response.response.?;
        const field = rng.uintLessThan(u8, 4);
        if (seed.isRegistration()) {
            if (field < 2) {
                inner.clientDataJSON = try mutatedText(arena, rng, inner.clientDataJSON.?);
            } else {
                inner.attestationObject = try mutatedText(arena, rng, inner.attestationObject.?);
            }
            v.input.response.response = inner;
            if (verifyRegistration(testing.allocator, registrationInputOf(v))) |ok| {
                accepted_registrations += 1;
                ok.deinit(testing.allocator);
            } else |_| {}
        } else {
            var changed = true;
            switch (field) {
                0 => {
                    const text = try mutatedText(arena, rng, inner.clientDataJSON.?);
                    changed = !std.mem.eql(u8, text, inner.clientDataJSON.?);
                    inner.clientDataJSON = text;
                },
                1 => {
                    const text = try mutatedText(arena, rng, inner.authenticatorData.?);
                    changed = !std.mem.eql(u8, text, inner.authenticatorData.?);
                    inner.authenticatorData = text;
                },
                else => {
                    const text = try mutatedText(arena, rng, inner.signature.?);
                    changed = !std.mem.eql(u8, text, inner.signature.?);
                    inner.signature = text;
                },
            }
            v.input.response.response = inner;
            var input = try authenticationInputOf(arena, v);
            // every seventh round mutates the stored key blob instead; it must not crash either
            const mutate_key = round % 7 == 0;
            if (mutate_key) {
                input.credential_public_key = try decodeBase64(arena, try mutatedText(arena, rng, v.input.credential.?.publicKey));
            }
            if (verifyAuthentication(testing.allocator, input)) |_| {
                if (changed and !mutate_key) return error.MutatedAssertionVerified;
            } else |_| {}
        }
    }
    // Mutating the AAGUID or attStmt keeps a registration valid, so some must get through.
    try testing.expect(accepted_registrations > 0);
}
