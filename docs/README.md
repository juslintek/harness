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
- `HARNESS_ORIGIN`: browser origin and passkey relying party. Default `http://localhost:<port>`.
- `HARNESS_TRUST_PROXY`: `true` when a reverse proxy in front sets `X-Forwarded-For`; the login rate limit then keys on its rightmost address. Default `false`, which ignores the header.

Further guides:

- [Multi-account management](accounts.md)
- [Distribution, federation and self-update](distribution.md)
