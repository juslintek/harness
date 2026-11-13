import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const zigRoot = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "harness-migration-cache-"));
const fixtureZig = join(fixture, "zig");
const migrations = join(fixture, "code/src/server/db/migrations");

function command(argv: string[], cwd: string): string {
  const execution = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  assert.equal(execution.exitCode, 0, execution.stderr.toString());
  return execution.stdout.toString() + execution.stderr.toString();
}

try {
  mkdirSync(join(fixtureZig, "src"), { recursive: true });
  cpSync(join(zigRoot, "src/db"), join(fixtureZig, "src/db"), { recursive: true });
  cpSync(resolve(zigRoot, "../code/src/server/db/migrations"), migrations, { recursive: true });
  const build = readFileSync(join(zigRoot, "build.zig"), "utf8");
  const configure = `pub fn build(b: *std.Build) void {
    const mod = b.createModule(.{
        .root_source_file = b.path("src/migration_cache.zig"),
        .target = b.standardTargetOptions(.{}),
        .optimize = .ReleaseSafe,
        .link_libc = true,
    });
    const options = b.addOptions();
    options.addOption(usize, "migration_count", addMigrations(b, mod));
    mod.addOptions("build_options", options);
    b.installArtifact(b.addExecutable(.{ .name = "migration-cache", .root_module = mod }));
}

`;
  writeFileSync(join(fixtureZig, "build.zig"), build.slice(0, build.indexOf("pub fn build(")) + configure + build.slice(build.indexOf("fn addVendoredC(")));
  writeFileSync(join(fixtureZig, "src/migration_cache.zig"), `const std = @import("std");
const migrate = @import("db/migrate.zig");
pub fn main() void {
    std.debug.print("{d}\\n{s}", .{ migrate.embedded.len, migrate.embedded[migrate.embedded.len - 1].sql });
}
`);
  const tsMigrations = readFileSync(resolve(zigRoot, "../code/src/server/db/migrations.ts"), "utf8");
  const count = [...tsMigrations.matchAll(/\{ version: (\d+), sql:/g)].length;
  const binary = join(fixtureZig, "zig-out/bin/migration-cache");
  command(["zig", "build"], fixtureZig);
  assert.equal(Number(command([binary], fixtureZig).split("\n")[0]), count);
  const sql = "CREATE TABLE migration_cache_probe (id INTEGER);\n";
  writeFileSync(join(migrations, `${String(count + 1).padStart(3, "0")}_cache_probe.sql`), sql);
  command(["zig", "build"], fixtureZig);
  assert.equal(command([binary], fixtureZig), `${count + 1}\n${sql}`);
  console.log(`migration cache: ${count} -> ${count + 1}, latest SQL embedded with the same .zig-cache (${command(["zig", "version"], fixtureZig).trim()})`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
