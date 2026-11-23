# Multi-account management

Harness can hold more than one subscription login per runtime, isolate each login's files inside the sandbox, balance runs across accounts using quota headroom, fail over to another account of the same runtime before switching engines, and park wakes cleanly when the entire pool is exhausted.

All account management routes are instance-admin only. Mutating calls (`POST`, `PATCH`, `DELETE`) require a passkey touch in the last 5 minutes (step-up).

## Supported runtimes and isolation gate

Adding isolated accounts is gated per runtime by `accountIsolation` in `code/src/server/features/agents/specs.ts`:

- `codex`: enabled (`accountIsolation: true`). Each account runs with its own `CODEX_HOME` directory under `<HARNESS_HOME>/accounts/<id>`.
- `claude` and all other runtimes: currently disabled (`accountIsolation: false`) until credential isolation without host keychain cross-read is verified. Calls to add extra accounts for runtimes without `accountIsolation` return `409`.

Every runtime always has its implicit host login represented as `default:<runtime>` (`home = null`). It can be disabled (`PATCH ... { enabled: false }`) so the router skips it, and it can never be deleted via `DELETE`.

## Managing accounts

HTTP routes (also exposed in the web UI at `#/agents`):

- `GET /api/agents/:id/accounts`: list accounts for runtime `:id`, including `state`, `identityHint`, `maxConcurrent`, `priority`, and `exhaustedUntil`.
- `POST /api/agents/:id/accounts` with `{ "label": "work" }` (step-up): creates a `pending` row with a UUIDv7 id and a `0700` directory at `<HARNESS_HOME>/accounts/<id>`. Labels must match `^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,63}$` and are unique per runtime.
- `POST /api/agents/:id/accounts/:acct/login` (step-up): launches the runtime's login CLI pointed at the account's isolated home and returns the login session/command details.
- `POST /api/agents/:id/accounts/:acct/test` (step-up): probes login status inside that account's home, updates `state` (`active`, `logged_out`, or `probe_failed`), and stores a redacted `identityHint` (safe short label only; long opaque tokens are discarded).
- `PATCH /api/agents/:id/accounts/:acct` with `{ "enabled": true | false }` (step-up): disables or re-enables an account.
- `DELETE /api/agents/:id/accounts/:acct` (step-up): refuses if the account has live runs unless `?drain=1` is passed (which moves the account to `removing` and keeps the directory until live runs finish). Otherwise it removes the `<HARNESS_HOME>/accounts/<id>` directory (never following symlinks outside `<HARNESS_HOME>/accounts/`) and keeps the row as `removed` for audit and usage history.

## Credential isolation and sandbox boundaries

Per-account sandboxing is enforced in `code/src/server/features/guard/sandbox-accounts.ts`, `code/src/server/features/guard/sandbox.ts`, `code/src/server/features/guard/rules-secret.ts`, and `code/src/server/features/guard/manager-limits.ts`, with launch wiring in `code/src/server/features/runtimes/launch-accounts.ts` and `code/src/server/features/runtimes/launch.ts`:

- Each isolated account gets its own `0700` directory under `<HARNESS_HOME>/accounts/<id>`.
- Every run places `<HARNESS_HOME>/accounts` in `filesystem.denyRead` (and denies `accounts/` in L1 rules and manager limits). For non-default account runs, host default credential files (such as `~/.claude/.credentials.json` and `~/.codex/auth.json`) also join `filesystem.denyRead`. Codex runs get an isolated per-run `CODEX_HOME` with `auth.json` copied under a per-account lock; non-Codex isolated account homes get nested `allowRead` and `allowWrite` for their own directory while settings, hooks, plugins, commands, and skills stay in `filesystem.denyWrite`.
- Account credentials and tokens are never written to `events`, `route_decisions`, log segments, or HTTP API responses; local `home` paths appear only in instance-admin account records (`GET /api/agents/:id/accounts`) and never in events, route decisions, or federation payloads.
- `agent_accounts`, `quota_snapshots`, and `route_decisions` are not in `TABLES` in `code/src/server/features/federation/schema.ts` and never replicate to paired peers.

## Quota probes and staleness

Quota snapshots live in `quota_snapshots`, keyed by `(provider, account_id, window)`:

- **Codex probe**: `code/src/server/features/usage/codex-probe.ts` runs `codex app-server` inside `srt` (`account/rateLimits/read`) on a background loop (`startCodexQuotaProbe` in `code/src/main.ts`), skipping accounts whose latest snapshot is fresher than 5 minutes.
- **Manual injection / inspection**: `POST /api/quota` records a snapshot (`provider`, optional `accountId`, `window`, `usedPercent`, optional `resetsAt`), and `GET /api/quota` returns the latest view per account and window.
- **TTL and exhaustion**: a reading older than its provider TTL (`10` minutes for `codex`, `60` minutes default) reads as unknown (`usedPercent: null`) unless the window was at 100% with `resets_at` still in the future (a full window stays blocked until reset). Snapshots older than 30 days are pruned daily.

## Routing policies and decision log

Account selection inside a runtime is governed by the layered policy `router.accountPolicy` (default `spread`, configurable per harness, org, team, agent, or task in `#/policies` or `POST /api/policies`):

- `spread` (default): prefers the highest remaining quota headroom (`1 - max(usedPercent)/100`), treating unknown quota as neutral (`0.5`), and tie-breaks by least recently used (`lastUsedAt`).
- `drain`: picks the lowest `priority` first (tie-breaking by `createdAt`, then `id`) so one subscription is consumed before spilling to the next.
- `expiring`: picks the account whose active quota window resets soonest in the future (falling back to `spread` when no reset timestamp is known).

Accounts are rejected before scoring if they fail any filter: pinned to another account, state not in `{active, unknown}`, `exhausted_until > now`, active runs `>= max_concurrent`, excluded by a prior failover attempt, or any quota window at `100%`.

Every routing pass (except read-only previews on `GET /api/router/route`) writes a bounded record to `route_decisions` (top 10 candidates, 8 KiB JSON cap, pruned after 30 days) and links `run_id` once the run starts. Admins inspect recent decisions with `GET /api/router/decisions?limit=20` or filter by `?runId=<id>`.

## Account-first failover, watchdog scoping, and pool exhaustion

- **Watchdog scoping**: `startWatchdog` in `code/src/server/features/router/failover.ts` matches `quota_snapshots` by `(provider, account_id)` and kills only live runs running on the exhausted account (`reason = "quota_exhausted"`). Concurrent runs on other accounts of the same runtime keep running.
- **Account-first failover**: `code/src/server/features/router/failover.ts` tracks failed attempts by `COALESCE(account_id, 'default:' || agent_id)` and prefers another eligible account of the same `(runtime, model)` in the same worktree before switching to a fallback runtime.
- **Reactive exhaustion backoff**: when an unprobed run fails with a rate-limit or quota error, `recordReactiveExhaustion` in `code/src/server/features/agents/accounts-repo.ts` sets `exhausted_until` using exponential backoff starting at 15 minutes (`15m`, `30m`, `60m`, `120m`, `240m`, capped at `300m` / 5 hours). The streak resets to `0` on the next completed run.
- **Pool-exhausted parking**: when every eligible account for the allowed runtimes is exhausted, `code/src/server/features/heartbeat/park.ts` parks the pending wakeup with `not_before` set to the earliest reset or backoff deadline (clamped to at least 60 seconds ahead) without failing the wake or moving the task to `blocked`. Harness sends one `pool_exhausted` notification to org admins per exhaustion episode and resumes parked wakes automatically once `not_before` passes, reusing the interrupted worktree with a handoff summary when an active run parked mid-task.

## Per-account usage attribution

- `GET /api/usage?by=account` (with optional `since=<ms>`): aggregates token counts and reported cost grouped by `COALESCE(account_id, 'default:' || agent)`.
- `GET /api/agents/:id/accounts/:acct/usage` (with optional `since=<ms>`): returns totals (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `reportedCostUsd`, `estimatedCostUsd`, `unpricedEvents`, `events`), daily buckets (`byDay`), and current quota `windows`. Subscription runs report `reportedCostUsd: null` and compute API-equivalent `estimatedCostUsd` from `model_registry` prices.

## Verification

Run the scripted Gate G1 suite (fake Codex CLI and in-process lane):

```sh
cd code && bun scripts/gate-accounts.ts
```

When two real isolated Codex accounts are logged in under `HARNESS_HOME`, an operator can run the live identity and `codex app-server` quota check:

```sh
cd code && bun scripts/gate-accounts.ts --live
```
