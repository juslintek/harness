# Getting started

Requirements: [Bun](https://bun.sh) 1.4 or newer.

```sh
cd code
bun install
bun run dev      # serves the UI and /api/health on http://127.0.0.1:4100
bun run check    # lint, typecheck, test, knip, deps, dup, size
```

Environment variables:

- `HARNESS_HOME`: data directory (database, logs, worktrees). Default `~/.harness`.
- `HARNESS_PORT`: HTTP port. Default `4100`.
- `HARNESS_HOST`: bind address. Default `127.0.0.1`.
