# harness ui

SolidJS front end. `bun run build` writes static files to `dist/`.

## dev setup

Run the two commands in separate terminals, then open http://localhost:5173.

```
bun run dev:server   # TS server on :4100, with HARNESS_ORIGIN=http://localhost:5173
bun run dev          # Vite on :5173, proxies /api, /ws and /mcp to the server
```

The server must run with that origin: passkeys and its Origin checks compare against the address
the browser uses, and the proxy forwards the browser's Host header for `/api` and `/ws`.

## checks

`bun run check` (lint, typecheck, build) and `bun run e2e` (Playwright against the TS server).
