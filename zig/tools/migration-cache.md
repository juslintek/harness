# Migration build cache regression

From the repository root:

```sh
bun zig/tools/migration-cache.test.ts
```

The check copies the SQL migrations and Zig database modules into a temporary directory,
reuses `addMigrations` from the current `build.zig`, and builds a small ReleaseSafe binary
that reports the embedded count and latest SQL. It adds the next migration only to that
copy, rebuilds with the same `.zig-cache`, and asserts both the new count and exact SQL.
The temporary directory is removed on success or failure. The real TS migrations stay unchanged.

Verified with Bun 1.4.4 and Zig 0.17.1:

```text
Before: expected 29 and the probe SQL, received 28 and 028_run_org.sql.
After: migration cache: 28 -> 29, latest SQL embedded with the same .zig-cache (0.17.1)
```

The installed native API is `std.Build.dependOnDirectoryContents`, in
`/opt/homebrew/Cellar/zig/0.17.1/lib/zig/std/Build.zig:2665`. Its documented contract
repeats configuration when directory entry names or existence change, without forcing
all builds to miss the cache. This matches the flat directory scanned by `addMigrations`.
Existing anonymous imports continue to track SQL file content through `@embedFile`.

Related source: [`addMigrations`](../build.zig),
[`embedded`](../src/db/migrate.zig), and the
[TS migration list](../../code/src/server/db/migrations.ts).
