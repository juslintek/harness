const std = @import("std");

const sqlite_flags: []const []const u8 = &.{
    "-DSQLITE_ENABLE_FTS5",
    "-DSQLITE_THREADSAFE=1",
    "-DSQLITE_DQS=0",
    "-DSQLITE_OMIT_LOAD_EXTENSION",
};

const zstd_flags: []const []const u8 = &.{ "-DZSTD_DISABLE_ASM", "-DXXH_NAMESPACE=ZSTD_" };

const zstd_sources: []const []const u8 = &.{
    "common/debug.c",
    "common/entropy_common.c",
    "common/error_private.c",
    "common/fse_decompress.c",
    "common/pool.c",
    "common/threading.c",
    "common/xxhash.c",
    "common/zstd_common.c",
    "compress/fse_compress.c",
    "compress/hist.c",
    "compress/huf_compress.c",
    "compress/zstd_compress.c",
    "compress/zstd_compress_literals.c",
    "compress/zstd_compress_sequences.c",
    "compress/zstd_compress_superblock.c",
    "compress/zstd_double_fast.c",
    "compress/zstd_fast.c",
    "compress/zstd_lazy.c",
    "compress/zstd_ldm.c",
    "compress/zstd_opt.c",
    "compress/zstd_preSplit.c",
    "compress/zstdmt_compress.c",
    "decompress/huf_decompress.c",
    "decompress/zstd_ddict.c",
    "decompress/zstd_decompress.c",
    "decompress/zstd_decompress_block.c",
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const test_filters = b.option([]const []const u8, "test-filter", "Only run tests whose name contains this string (repeatable)") orelse &.{};

    const embed_ui = b.option(bool, "embed-ui", "Embed ../ui/dist into the binary (default true; false gives an API-only build)") orelse true;

    // Sibling inputs are optional until their producers land; a missing one is recorded, never an error.
    const sibling = b.addOptions();
    sibling.addOption(bool, "embed_ui", embed_ui and pathIfExists(b, "../ui/dist") != null);
    sibling.addOption(bool, "has_migrations", pathIfExists(b, "../code/src/server/db/migrations") != null);
    sibling.addOption(bool, "has_contract", pathIfExists(b, "../contract") != null);

    const httpz = b.dependency("httpz", .{ .target = target, .optimize = optimize });

    const server_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    server_mod.addImport("httpz", httpz.module("httpz"));
    server_mod.addOptions("build_options", sibling);
    addVendoredC(b, server_mod);

    const hook_mod = b.createModule(.{
        .root_source_file = b.path("src/hook_main.zig"),
        .target = target,
        .optimize = optimize,
    });

    const cookbook_mod = b.createModule(.{
        .root_source_file = b.path("cookbook.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    cookbook_mod.addImport("httpz", httpz.module("httpz"));
    addVendoredC(b, cookbook_mod);

    const server = b.addExecutable(.{ .name = "harness", .root_module = server_mod });
    const hook = b.addExecutable(.{ .name = "harness-hook", .root_module = hook_mod });
    b.installArtifact(server);
    b.installArtifact(hook);

    const run = b.addRunArtifact(server);
    run.step.dependOn(b.getInstallStep());
    run.addPassthruArgs();
    b.step("run", "Run the harness server binary (arguments after --)").dependOn(&run.step);

    b.step("hook", "Build the harness-hook binary").dependOn(&b.addInstallArtifact(hook, .{}).step);

    const server_tests = b.addTest(.{ .root_module = server_mod, .filters = test_filters });
    const hook_tests = b.addTest(.{ .root_module = hook_mod, .filters = test_filters });
    // The slice modules are imported only from `test` blocks, so the diagnostics loop compiles the
    // test artifacts (never run, never installed): `zig build check -fincremental --watch`.
    const cookbook_tests = b.addTest(.{ .root_module = cookbook_mod, .filters = test_filters });
    const check = b.step("check", "Compile the code and its tests for errors only");
    check.dependOn(&server_tests.step);
    check.dependOn(&hook_tests.step);
    check.dependOn(&cookbook_tests.step);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&b.addRunArtifact(server_tests).step);
    test_step.dependOn(&b.addRunArtifact(hook_tests).step);
    const cookbook_run = b.addRunArtifact(cookbook_tests);
    b.step("cookbook", "Run the compiled cookbook snippets").dependOn(&cookbook_run.step);
    test_step.dependOn(&cookbook_run.step);
}

fn addVendoredC(b: *std.Build, mod: *std.Build.Module) void {
    mod.addIncludePath(b.path("vendor/sqlite3"));
    mod.addCSourceFile(.{ .file = b.path("vendor/sqlite3/sqlite3.c"), .flags = sqlite_flags });
    mod.addIncludePath(b.path("vendor/zstd/lib"));
    mod.addCSourceFiles(.{ .root = b.path("vendor/zstd/lib"), .files = zstd_sources, .flags = zstd_flags });
}

fn pathIfExists(b: *std.Build, rel: []const u8) ?std.Build.LazyPath {
    b.root.root_dir.handle.access(b.graph.io, b.pathJoin(&.{ b.root.sub_path, rel }), .{}) catch return null;
    return b.path(rel);
}
