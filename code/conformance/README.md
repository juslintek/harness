# Conformance suite

Black-box tests that judge a harness server by what it does on the wire. The TS server in `code/`
is the reference. The Zig server must pass the same scenarios.

The suite reaches a server only through HTTP, WebSocket, MCP, its stdout and the SQLite file.
It imports `src/shared/*`, `scripts/fake-acp-agent.ts` and
`src/server/test-support/soft-authenticator.ts` and nothing else from the server; the
`conformance-black-box` rule in `.dependency-cruiser.cjs` fails `bun run deps` otherwise.

## Running

From `code/`:

    bun run conformance                              # TS server (default)
    HARNESS_TARGET=zig bun run conformance           # zig/zig-out/bin/harness
    HARNESS_TARGET=zig HARNESS_ZIG_BIN=/abs/path/harness bun run conformance

Each scenario file boots its own server in a fresh temp `HARNESS_HOME` with `HARNESS_PORT=0` and
`HARNESS_TEST=1`, reads the port from the `harness listening on http://127.0.0.1:<port>/` line, and
kills the process group when it is done. A server that fails to start fails the file with its
captured stdout and stderr.

Users and sessions are written into `harness.db` before the server starts (`kit/seed.ts`); the
schema comes from the migration files. Everything else goes through endpoints. The stub agent
(`fake-agent.ts`) gets its script as an argument because the server scrubs the environment of agents.

The suite is not part of `bun run check` (it needs the srt sandbox, so macOS). CI runs it in the
`conformance` job against TS.

## Scenarios and tags

Every test name starts with a scenario ID (`C0-health`, `C1-session-auth`, ...) followed by tags in
brackets: `[phase:N]`, `[slice:x]`, `[focus:n]`, `[race:*]`. Filter with the test name pattern:

    bun test conformance --timeout 60000 -t "slice:runs"
    bun test conformance --timeout 60000 -t "C1-ws-run-events"

`bun run conformance` already passes `--timeout 60000`; Bun's 5 s default is too short for the
polling waits. Servers boot on first use inside a test, so a filtered run only starts what it
selects. `CONFORMANCE_TRACE=1` prints one `conformance: boot <target>` line per boot.

`-t` matches against the full test name, so it works for IDs and tags alike.

## Differential mode

`kit/normalize.ts` numbers UUIDv7s by first appearance (`<id1>`, `<id2>`), turns epoch-ms numbers
into `<ts>` and tokens into `<secret>`. `diff` compares parsed JSON, so a key present on one side
only is reported. `differential.ts` runs one fixed scenario (health, me, a fake-agent run, the run
detail, the `runs` socket frames) against two servers:

    bun conformance/differential.ts ts zig
    HARNESS_DIFF_COOKIE='harness_session=...' bun conformance/differential.ts http://127.0.0.1:4100 ts

A side is `ts`, `zig` (booted and seeded here) or the URL of a running server that has a stub agent
`fake` and an admin session with a fresh step-up. It exits 1 and prints one line per difference.
