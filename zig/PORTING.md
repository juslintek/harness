# Porting the TS server to Zig 0.17

Read this before writing slice code. Zig 0.17.0 changed most of std since the versions that models
and older tutorials know. Every pattern below is a file under `cookbook/` that compiles and passes
its tests on 0.17.0 (`zig build cookbook`). If a snippet here and the installed std disagree, the
installed std wins: `/opt/homebrew/Cellar/zig/0.17.0/lib/zig/std`. Search it with `rg` before you
use an API from memory.

## 1. TS idiom to Zig 0.17 idiom

| TS | Zig 0.17 | File |
|---|---|---|
| `app.post(path, handler)`, `c.json(...)` | httpz route `fn (*Handler, *httpz.Request, *httpz.Response) !void`, `res.json(value, .{})`, `router.post` | [http_route.zig](cookbook/http_route.zig) |
| `await req.json()` plus zod | `std.json.parseFromSliceLeaky` on `req.body()` with `use_last` and `ignore_unknown_fields` | [http_route.zig](cookbook/http_route.zig), [json_parity.zig](cookbook/json_parity.zig) |
| `JSON.parse` quirks, `s.length`, `s.trim()` | `std.unicode.calcUtf16LeLen`, a JS whitespace trim | [json_parity.zig](cookbook/json_parity.zig) |
| `bun:sqlite` `db.query(sql).get(x)` | externs in `src/db/c.zig`: `prepare_v2`, `bind_*`, `step`, `column_*`, `finalize` | [sqlite.zig](cookbook/sqlite.zig) |
| `db.transaction(fn)` | `exec("BEGIN IMMEDIATE")`, work, `COMMIT`, or `ROLLBACK` on error | [sqlite.zig](cookbook/sqlite.zig) |
| FTS5 `MATCH ?` | same externs, bound query string, `ORDER BY rank` | [sqlite.zig](cookbook/sqlite.zig) |
| `Bun.spawn({ stdout: "pipe" })` | `std.process.spawn(io, .{ .stdout = .pipe, .pgid = 0 })` | [spawn_ndjson.zig](cookbook/spawn_ndjson.zig) |
| `for await (line of stdout)` NDJSON | `file.reader(io, buf)` and `takeDelimiter('\n')`, oversized lines discarded | [spawn_ndjson.zig](cookbook/spawn_ndjson.zig) |
| `Promise.race([work, timeout])` | `std.Io.Select(Event)` with `concurrent` tasks and `io.sleep` | [select_timeout.zig](cookbook/select_timeout.zig) |
| `process.kill(-pid, "SIGTERM")` then `SIGKILL` | `std.posix.kill(-pgid, .TERM)`, a grace timer in a Select, `.KILL` | [kill_group.zig](cookbook/kill_group.zig) |
| `server.upgrade(req)`, `ws.send` from anywhere | `httpz.upgradeWebsocket`, a mutex-guarded `*websocket.Conn`, `conn.writeText` | [websocket.zig](cookbook/websocket.zig) |
| `createHash("sha256")`, `timingSafeEqual` | `std.crypto.hash.sha2.Sha256`, `std.crypto.timing_safe.eql` | [crypto.zig](cookbook/crypto.zig) |
| `randomBytes(32)` | `try io.randomSecure(&buf)` | [random_secure.zig](cookbook/random_secure.zig) |
| `Bun.randomUUIDv7()`, `Date.now()` | `ids.uuidV7(io)`, `ids.nowMs(io)` from `src/ids.zig` | [ids_time.zig](cookbook/ids_time.zig) |
| single-threaded handler is atomic | `App.withLock(ctx, fn)` from `src/app.zig` | [app_lock.zig](cookbook/app_lock.zig) |
| garbage collection | `ArenaAllocator` per request or agent turn | [arena_request.zig](cookbook/arena_request.zig) |
| string unions, numeric enums | `enum`, `@tagName`, `std.meta.stringToEnum`, `@backingInt`, `@fromBackingInt`, `std.enums.fromInt` | [enums.zig](cookbook/enums.zig) |
| memory leaks (none in TS) | `std.testing.allocator` and `checkAllAllocationFailures` | [leak_checks.zig](cookbook/leak_checks.zig) |
| `fs.readFileSync`, `readdirSync`, `writeFileSync` | `Dir.readFileAlloc`, `Dir.iterate`, `Dir.writeFile`, all with `io` | [fs_io.zig](cookbook/fs_io.zig) |

Notes the table cannot hold:

- Handlers run on an httpz thread pool, not one thread. All mutable state goes through
  `App.withLock`; never hold the lock across spawn, git or network calls. `withLock` refuses at
  compile time to return the state pointer.
- `req.json(T)` in httpz parses with default options, so a duplicate key is an error there. Parse
  `req.body()` yourself as shown, or call `json.parse` from `src/json.zig`.
- A `*websocket.Conn` may be written and closed from any thread, but the pointer is dead after the
  handler's `close`. Clear it under the same mutex that guards writes.
- `std.json` rejects invalid UTF-8 and unknown enum names with an error, as zod does. It does not
  count UTF-16 length: use `jsLength` for any limit TS enforces with `.max(n)`.
- `std.mem.trim` with an ASCII set leaves U+00A0, U+3000 and U+FEFF; JS `trim()` removes them.
  `jsTrim` in the cookbook has the exact set.

## 2. 0.17 changes and traps

Found while writing G0 (`working-docs/zig-g0-results.md`), the scaffold and the cookbook.

**std.Io everywhere.** Time, sleep, random, files, directories, processes, sockets, mutexes and
tasks all take an `io: std.Io`. `main` takes `std.process.Init` (`init.gpa`, `init.io`,
`init.arena`, `init.minimal.args`, `init.environ_map`). Tests use `std.testing.io` and
`std.testing.allocator`. Pass `io` down explicitly; do not stash it in a global. The old
namespaces are gone: `std.io`, `std.fs.cwd`, `std.fs.File`, `std.net`, `std.time.sleep`,
`std.time.milliTimestamp`, `std.Thread.Mutex`, `std.crypto.random`. Replacements:
`std.Io.Writer`, `std.Io.Dir.cwd()`, `std.Io.File`, `std.Io.net`, `io.sleep`,
`std.Io.Clock.real.now(io).toMilliseconds()`, `std.Io.Mutex`, `io.randomSecure`.

**Clocks.** `Clock.real` is wall time (epoch ms for the database). `Clock.awake` is monotonic, for
durations and timeouts. `io.sleep(.fromMilliseconds(n), .awake)`.

**Select needs `concurrent`.** The std docs say `Select.async` may run the function inline on the
calling thread before `async` returns. A blocking task started that way would finish before the
timer task is even started, so there would be no race. Use `select.concurrent(...)`, which fails
with `error.ConcurrencyUnavailable` instead of running inline. Always `defer select.cancelDiscard()`.
(Inline execution was not observed under `std.testing.io`; this is a precaution from the docs.)

**takeDelimiter and long lines.** The Reader's buffer length is the longest line it can return.
A longer line gives `error.StreamTooLong` and leaves the stream untouched, so the next call fails
the same way. Discard to the newline with `discardDelimiterInclusive` and carry on.

**Build.** `std.Build` has no `args` field: use `run.addPassthruArgs()`. `b.build_root` is gone: use
`b.path()` and `b.pathJoin()`. `addExecutable` and `addTest` take `.root_module = b.createModule(..)`,
not `.root_source_file`. A new package needs the `.fingerprint` that zig prints on the first failed
build, and `.name` is an enum literal. A module file may import only files below its root, so the
cookbook root is `zig/cookbook.zig` (one level above `cookbook/`) to reach `src/`.

**No bare `@cImport`.** Declare extern functions by hand (see `src/db/c.zig`) or use
`b.addTranslateC`. Externs are checked lazily: a wrong declaration compiles until something uses
it. The cookbook found one this way: `transient` was typed as an aligned function pointer, which
cannot hold the address -1 that SQLite expects. It is now `?*align(1) const fn ...`.

**Allocators.** `std.heap.GeneralPurposeAllocator` is gone. `std.heap.DebugAllocator` still exists
but is deprecated. Use `std.heap.SafeAllocator` (and `std.heap.c_allocator` in production).
`std.testing.allocator` is a SafeAllocator, so a leaked byte fails the test. `ArenaAllocator.deinit`
and `reset(.retain_capacity)` are not thread safe: one arena per request.

**Renamed or removed in std.** `ArrayList` has no `.init(gpa)`: write `var list: std.ArrayList(T) =
.empty` and pass the allocator to `append`, `deinit` and friends (`ArrayListUnmanaged` is a
deprecated alias). `std.mem.trimLeft` and `trimRight` are `trimStart` and `trimEnd`.
`std.mem.split` and `tokenize` are `splitScalar`, `splitSequence`, `tokenizeScalar` and friends.
`std.mem.indexOf*` are deprecated for `find*`. `std.json.stringify` is `std.json.Stringify`.
`std.BoundedArray` is gone. `std.process.Child.init` and `Child.run` are `std.process.spawn(io, ..)`
and `std.process.run(gpa, io, ..)`. `std.posix.fork`, `waitpid`, `open`, `close`, `write` and
`getenv` are gone. Enum builtins: `@intFromEnum` and `@enumFromInt` are deprecated for
`@backingInt` and `@fromBackingInt`.

**Syntax.** `usingnamespace`, the `**` array repeat operator and `errdefer |err|` are removed.
Use `@splat`, plain `errdefer`, and explicit re-exports.

**Child processes.** `.pgid = 0` makes the child a group leader; signal the whole tree with a
negative pid. `Term.signal` holds a `std.posix.SIG` value. `child.wait(io)` blocks, so run it as a
Select task when a timeout is needed. Always `defer child.kill(io)`: it is idempotent after `wait`.

**`zig build check` compiles test artifacts.** Slice modules are reached only from `test` blocks in
`src/main.zig`, so `check` includes tests but never runs them. Zig compiles lazily: code that no
test or `main` reaches is not analysed at all, even by `zig build test`. Reference new code from a
test before trusting that it compiles.

**httpz.** Config uses `.address = .localhost(port)` and `.thread_pool = .{ .count = n }`. For port 0
the server does not report the bound port; the cookbook asks the OS for a free port first
(`freePort` in `http_route.zig`). `httpz.testing.init(.{})` gives a request and response for
calling a handler directly. In the cookbook, `server.stop()` followed by `thread.join()` on the
thread from `listenInNewThread` returned cleanly on macOS, also with an open WebSocket.

**Formatting.** `zig fmt --check .` also walks `zig-pkg/` (fetched sources, not formatted to our
rules). Use `--exclude zig-pkg`.

## 3. Workflow

Run everything from `zig/`.

```
zig build check -fincremental --watch                    # errors only, fast; includes the tests
zig build test -Dtest-filter="<slice>: " --summary failures   # one slice; test names start with "<slice>: "
zig build cookbook                                        # only the cookbook
zig fmt --check --exclude zig-pkg .
ast-grep scan src cookbook                                # stale-API rules, expect no output
ast-grep test --skip-snapshot-tests                       # the rules against their own samples
zig build test -Doptimize=ReleaseSafe --summary all       # the gate
```

Binary builds are not incremental on Apple Silicon: every `zig build` of an executable goes through
LLVM. Use `check` while editing and build binaries only to run them. Gates run in ReleaseSafe so
that safety checks stay on; a Debug-only pass is not enough. Name tests `"<slice>: what it checks"`
so `-Dtest-filter` can pick a slice. The filter is repeatable. Every test uses
`std.testing.allocator`.

`sgconfig.yml` points ast-grep at `sgrules/`; the rules apply to `src/`, `cookbook/`, `build.zig`
and `tools/`. Each rule has a sample in `sgtests/`. When you find another stale API, add a rule
and a sample, compile the member path against the installed std first, and run both commands above.

## 4. Never do

These are all caught by `sgrules/stale-std-apis.yml`. The list is what a model reaches for first.

- `std.io.*`, `std.fs.cwd()`, `std.fs.File`, `std.fs.Dir`, `std.net`. Use `std.Io` with `io`.
- `std.time.milliTimestamp()`, `nanoTimestamp()`, `sleep()`, `Timer`, `Instant`. Use the Io clocks.
- `std.Thread.Mutex`, `Condition`, `Pool`, `RwLock`, `Semaphore`, `ResetEvent`, `WaitGroup`, `sleep`.
  Use `std.Io.Mutex` and friends, and `std.Io.Group` or `Select` for tasks.
- `std.crypto.random`, `std.rand`. Use `io.randomSecure` for secrets.
- `std.process.argsAlloc`, `getEnvVarOwned`, `getEnvMap`, `Child.init`, `Child.run`, and the
  `std.posix` calls `fork`, `waitpid`, `open`, `close`, `write`, `getenv`.
- `std.heap.GeneralPurposeAllocator`, `std.heap.DebugAllocator`. Use `SafeAllocator`.
- `std.ArrayList(T).init(gpa)`, `std.ArrayListUnmanaged`, `std.BoundedArray`.
- `std.mem.trimLeft`, `trimRight`, `split`, `tokenize`, and the deprecated `indexOf*` names.
- `std.json.stringify`, `std.fmt.fmtSliceHexLower`, `std.fmt.format`.
- `@cImport`, `@intFromEnum`, `@enumFromInt`, `usingnamespace`, the `**` operator, `errdefer |e|`.
- `b.args`, `b.build_root` in `build.zig`.
- A skipped or weakened test to get green, and any `catch {}` that hides an error.
- Documenting or using an API you did not compile. Add it to `cookbook/` first.
- Calling `sqlite3_*` outside `src/db/`, or opening the database outside `App.withLock`.

## 5. Open items

- The macOS accept-loop cancel hang named in the task brief is not in `working-docs/zig-plan.md` and
  did not reproduce here (see the httpz note above). Stop servers with `server.stop()` and join;
  treat cancelling the accept loop through `Io` as unsafe until someone reproduces the hang.
- WebSocket ping behaviour (plan 2.6) is still unobserved; the cookbook client does not send pings.
- No cookbook entry yet for: zstd streaming, CBOR, CORS and cookie helpers in httpz, `Io.Queue`
  producer and consumer, and the `checkAllAllocationFailures` pattern for a parser with a
  `std.Io.Reader`. Add them with the slice that first needs them.
