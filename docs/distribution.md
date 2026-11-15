# Distribution, federation and self-update

This guide covers running Harness on more than one machine: building the binary, deploying it, pairing two instances, sharing a project between them, updating an instance from its own repo, and OIDC login. Deploy, self-update and peer management need an instance admin. Sharing a project with a peer needs only an admin of the org that owns it. The risky actions need a passkey touch in the last 5 minutes (step-up).

Paths below are API paths on the instance. The UI has pages for deploy, federation and self-update that call the same routes.

## Build the binary

```sh
cd code
bun run build                          # host target, writes dist/
bun scripts/build.ts --target linux-x64 --out /some/dir
```

Targets: `darwin-arm64`, `linux-x64`, `linux-arm64`, or `host`. `--out` defaults to `dist`. The output is `harness-<target>` and next to it `harness-<target>.sha256` in `sha256sum` format. The version baked in is the `version` from `code/package.json`, and the git commit of the checkout is baked in too (self-update needs it). The binary is one file with the UI, migrations and PWA files inside.

Configuration is the same as for `bun run dev`: `HARNESS_HOME`, `HARNESS_PORT`, `HARNESS_HOST`, `HARNESS_ORIGIN`, `HARNESS_TRUST_PROXY` (see `docs/README.md`).

## Discover deploy targets

`GET /api/deploy/targets` (instance admin) lists places you could deploy to. It only reads:

- `~/.ssh/config`: literal `Host` names (no wildcards or negations), plus `HostName`, `User`, `Port`, `IdentityFile`. `Include` files are followed one level, only when they sit inside the config's directory. The key file itself is never opened; its path is shown as a note.
- `tailscale status --json`: peers that have a DNS name, with OS and online state.
- `docker context ls --format json`: contexts that are not a local unix socket.

Nothing is written and nothing connects to a host during discovery. A Docker target is listed but a deploy request for it is refused (`docker_not_supported`).

## Approved deploy

A deploy never starts without a human yes.

1. An instance admin creates a request: `POST /api/deploy/requests` with `targetId`, `binary` (a file name) and optionally `port` (default 4100). The binary must be inside `<HARNESS_HOME>/dist` or `./dist` of the server's working directory, after symlinks are resolved. Its sha256 is stored with the request.
2. The response carries the exact steps (`steps`): the file to copy and its mode, the unit file text for Linux (systemd user unit) and macOS (launchd agent), the invite file, the start commands, the health URL and what pairing will do. The same functions that build this text run the deploy.
3. An admin approves or denies: `POST /api/deploy/requests/:id/decide`. This needs step-up. A request can be decided once.
4. `POST /api/deploy/requests/:id/run` starts an approved request. A request that is not approved, or already started, gets 409.

What the executor does, over `ssh` and `scp` with `BatchMode=yes` and `StrictHostKeyChecking=yes`:

- Checks the sha256 again. If the file changed after approval, it stops.
- Copies only the binary (to `~/.harness/bin/harness`, mode 0755), the unit file, and for a loopback target a one-time pairing code file (mode 0600). No credentials, keys, agent logins or database are copied.
- The new instance starts with a fresh home (`~/.harness/home`). It binds `127.0.0.1` only.
- Starts it with `systemctl --user enable --now` (Linux) or `launchctl load -w` (macOS), then polls `/api/health` until the instance id answers, up to 60 seconds.

A server that stops mid-deploy marks the running request failed on the next start.

Limits, stated plainly:

- Only a loopback target (`localhost`, `127.0.0.1`, `::1`) is paired automatically. A remote target is installed and started on its loopback only, and no pairing code is written. It needs its own HTTPS origin (a tunnel or reverse proxy) before it can be paired, then you pair it from Federation.
- The new instance has no agent logins. Log in to `claude` and `codex` on it yourself.
- Unit files only accept plain path characters. Anything else in a path or home makes the deploy fail.

## Pairing and invites

Two instances trust each other only after pairing.

1. On instance B an admin creates an invite: `POST /api/federation/invites` (step-up). It is a random 32-byte token, valid 15 minutes, usable once. Only its hash is stored.
2. On instance A an admin pairs: `POST /api/federation/peers/pair` with B's `url` and the token (step-up). A sends its instance id, name, URL, public key and a proof to `B/federation/pair`. The proof is an Ed25519 signature, made with A's private key, over `JSON.stringify(["harness-pair/v2", direction, token, signer, other, url])` (the request proof has direction `request`, A's id as signer, an empty `other` and A's URL), so only the holder of the key can pair under that id and the URL cannot be swapped on the way. B checks the proof, burns the token in the same transaction that stores A, and answers with its own key, its URL and its own proof over the same array with direction `answer`, B's id as signer, A's id as `other` and B's URL. A refuses the answer if the proof fails or if the URL in the signed answer is on another origin than the one A dialed.
3. Both sides now hold the other's Ed25519 public key. Compare the fingerprints from `GET /api/federation/identity` and `GET /api/federation/peers` if you want to check by eye.

The peer URL must be `https`, with no credentials. Plain `http` is accepted only for a loopback host. Wrong, used and expired tokens all get the same refusal. A deploy leaves its code in `<home>/pair-invite`; the new instance turns it into a normal invite at boot and deletes the file.

The private key is stored as `federation.key` in `secrets.json`. It never goes into the database, logs or any payload.

A known instance id can never be paired again with a different key or URL, and pairing never lifts a revocation: a revoked peer that pairs again, even with the same key and URL, is refused and its invite is not used up. A revoked instance id stays revoked; there is no way to re-pair it. An active public key belongs to one peer only; migration 037 enforces that with a unique index, and on upgrade it revokes the later duplicates among active peers (the earliest pairing keeps trust, nothing is deleted). The pair answer carries the receiving instance's own origin (`HARNESS_ORIGIN`), so set it to the address peers use to reach this instance. The answer must carry that URL and it must be on the origin the dialer used; there is no exception for answers without one. Ids and tokens in a pairing must be plain `[A-Za-z0-9_-]` strings, a URL must equal its own bare origin exactly (`new URL(url).origin`: no path, no trailing slash, no query, no credentials), and the proofs sign a JSON array of their fields, so no field can be moved across a boundary.

Revoke a peer with `DELETE /api/federation/peers/:id` (step-up).

### Signed requests

After pairing, every call between instances is signed. Headers:

- `X-Harness-Instance`: the sender's instance id
- `X-Harness-Timestamp`: milliseconds since epoch
- `X-Harness-Nonce`: 16 random bytes, base64url
- `X-Harness-Signature`: base64url Ed25519 signature over the text below, one field per line, joined with a real `\n` between fields (no trailing newline):

```
METHOD
PATH_WITH_QUERY
TIMESTAMP
NONCE
sha256hex(body)
SENDER_INSTANCE_ID
RECEIVER_INSTANCE_ID
```

The sender id is checked against the key it signed with, and the receiver id is its own id, so a request signed for one peer is refused by any other and a signature cannot be presented as another instance. This changes the wire format: an instance on the build before these fixes and one on this build can neither pair nor verify each other's signed calls, so upgrade all paired instances together.

The receiver refuses with one identical 401 when the instance is unknown or revoked, the timestamp is more than 5 minutes off, the signature fails, or the nonce was seen before. Nonces are kept 10 minutes and recorded only after the signature checks out. Bodies over 1 MiB are refused with 413. The requests go to the peer's public origin, under `/federation`.

## Share a project

Sharing works like a local grant, to an org that stands for the other instance.

- `POST /api/federation/shares` with `projectId`, `peerId`, `permission` (`read` or `write`). The caller must be an admin of the org that owns the project, and needs step-up. Only the home instance of a project can share it.
- `DELETE /api/federation/shares/:projectId/:peerId` stops the feed.
- `GET /api/federation/shares` lists shares you can administer.

On share, the peer gets a stub org and a grant, and the whole project is queued for its first pull. Each instance pulls from the other every 5 seconds (backing off to 60 seconds on failure). A write grant lets the peer's changes to tasks, task dependencies, comments, messages and notes come back; a read grant does not. The peer cannot change orgs, projects or grants. Ownership checks on a write peer are partial. Comments and messages need their stored and new author to be a member of the peer's stub org. A write peer may edit tasks that home users created, but a change that alters a stored task's creator, parent or project, or a stored message's thread root or channel, is refused as a whole; the holder and checkout time in a peer's task put are replaced by the stored values (leases go through the home). A new task must name the peer's own member as creator. When a row is applied, a task's parent must be stored in the same project and a reply's thread root must be a stored root in the same channel; a child whose parent is in another project, or whose root is in another channel or is itself a reply, is rejected. A parent and its first child can arrive in the same page, because the check reads what earlier rows of the page already stored. A stored task never changes project and a stored message never changes channel at apply either (such a put is rejected), because moving a row into a project the peer homes would let the peer delete it there and cascade over its children. A child that is sent before its parent in a page is rejected and is not sent again until it changes. A project or channel reference that is not a string is refused. Notes and task dependencies have no ownership check at all: a write peer can change any note or dependency of a granted project (this was already so before these fixes). A write peer cannot delete tasks or root messages, because deletes cascade into home users' comments, subtasks and local rows; it cancels a task by status instead. It can still delete its own comments and non-root messages.

Revoking a share only stops the feed. The peer keeps the copy it already pulled. This instance cannot delete rows in another instance's database.

### What replicates

The allowlist is one list in `code/src/server/features/federation/schema.ts`, and a test pins it. Only these tables, and only the listed columns:

- `orgs`: id, slug, name, home instance (a stub, nothing else)
- `members`: id, org, kind, handle, display name, role (a stub: no user id, agent id, model or specialties)
- `projects`, `grants`
- `tasks`, `task_deps`, `comments`
- `channels` of kind `project`, and their `messages`
- `notes` of scope `project`, with the note body text

### What never replicates

Everything else stays on the instance where it was made. In particular:

- credentials, passkeys, sessions, tokens, `secrets.json` and the instance key
- agent configuration, agent ids and models
- runs, run stacks and their logs, approvals
- policies and profiles
- notification targets and preferences, OAuth tables, OIDC providers
- every note or channel with a local scope (org, member, direct messages)

A change made on a copy is served only to that project's home, never to a third instance. There is no relay between grantees.

## Conflicts and leases

Every replicated row carries a hybrid logical clock stamp: `<13-digit ms>-<4-digit counter>-<instance id>`. The order is plain string order.

- Per row, the higher stamp wins (last writer wins). On an exact tie the lower instance id wins, so both sides pick the same row.
- A delete is a tombstone with a stamp and competes the same way as an update.
- A remote stamp more than 5 minutes ahead of the local clock is refused, so one wrong clock cannot win every conflict.
- A change that arrived from a peer is not sent back out as a local edit.

Two things are not left to last-writer-wins. Task checkout and note writes on a copy go through the home instance:

- Checkout calls the home's board checkout with a lease. The lease lasts 5 minutes, is renewed at half life, and the home caps any lease at 10 minutes. When it expires, the task goes back unless the home already moved it.
- A note write sends the base hash; the home answers 409 if the note changed since.
- If the home cannot be reached, checkout and note writes are refused with "home instance is unavailable". Nothing is changed locally, so there is never a second claim to sort out later.

## Self-update

An instance can rebuild itself from a git repo and swap to the new binary. Routes are under `/api/selfupdate`, instance admin only.

1. Request: `POST /api/selfupdate/requests` (step-up) with `repo` and `branch`. The branch is resolved to one commit and pinned. Only one update runs at a time.
2. Check: the diff between the commit this binary was built from and the pinned commit is classified (below). If the running commit is unknown, every change needs approval. If nothing needs approval, the pipeline continues. A fresh git worktree is made, then `bun install --frozen-lockfile` and `bun run check` run in `code/`. The build stops if the check left the worktree dirty. Both steps run the branch's own code as your user, outside the sandbox, so a requested branch is trusted code. A diff that touches none of the flagged paths below builds and runs without approval.
3. Build: `bun scripts/build.ts --target host`; the binary is copied to `<home>/bin/harness-<request id>`.
4. Scratch verify: the live database is copied with `VACUUM INTO`, the new binary starts on a second port (an OS-chosen one) with its own scratch home, and must report the expected version on `/api/health`. The scratch home is deleted after.
5. Swap: a last check that the commit is still the pinned one and that no flagged paths appeared without approval. A fresh snapshot of the database is taken, the `<home>/bin/current` symlink is flipped, and a helper process waits for the old process to exit, starts the new binary and waits for health with the new version.
6. Rollback: if the new binary does not become healthy, the helper restores the pre-swap snapshot (deleting the stale `-wal` and `-shm` files), flips the symlink back to the previous binary and starts it. Data written between the snapshot and the failure is lost. The restore is refused if the process named in `harness.lock` is still alive; the request is marked failed and the symlink is left alone. If the previous binary also fails to start, the request is marked failed.

Any failure before the swap leaves the running instance and its data untouched.

### Which diffs need a passkey approval

When the diff touches any of these, the request stops at `awaiting_approval`. An admin reads `GET /api/selfupdate/requests/:id/review` and approves with `POST .../approve` or refuses with `POST .../deny`, both with step-up. An approval covers the pinned commit only; if the branch moved, the approve call returns `branch_moved` and you need a new request.

- anything under `src/server/features/` in: `guard`, `auth`, `federation`, `oauth`, `selfupdate`
- `src/server/features/policies/`: `routes.ts`, `proposals.ts`, `resolve.ts`
- `src/server/features/runtimes/launch.ts`
- `scripts/guard-hook.ts`, `.dependency-cruiser.cjs`, `biome.json`, `lefthook.yml`
- `src/main.ts`, `src/server/config.ts`, `src/server/db/migrations.ts`, `src/server/features/runtimes/decide.ts`, `src/server/features/orgs/roles.ts`, `src/server/features/orgs/routes-kit.ts` (they call `checkAction` or map roles to access). A guarded source file also guards the files that could shadow it for an extensionless import. Checked on Bun 1.4.4 with `bun run` and `bun build`: a `.tsx`, `.jsx` or `.mts` sibling, or an extensionless file with the same stem, is loaded instead of the `.ts`. A `.cts`, `.js`, `.mjs`, `.cjs` or `.json` sibling is not, but it is flagged anyway in case that order changes
- `src/server/http.ts`, `src/server/origin-app.ts`, `src/server/features/mcp`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig*`, `scripts/build.ts`
- any path containing `sandbox` or `srt`
- any path with a character outside printable ASCII (so look-alike names such as `ſrc`, ligatures and decomposed accents), with a control character, or with a segment ending in a dot or a space, on either side of a rename: case-insensitive filesystems (APFS) fold such names onto real paths, so a branch could otherwise plant a file in a guarded directory that the path rules never see
- any path with a `node_modules` segment, and any `package.json`, `tsconfig*`, `jsconfig.json` or `bunfig.toml` at any depth, because a nested one redirects the imports of guarded modules
- any `.sql` file under `src/server/db` that is deleted or renamed, or whose text contains one of these as a substring (so `team_members` and `policy_rules` match): `approvals`, `sessions`, `passkey`, `grants`, `tokens`, `users`, `members`, `polic`, `peers`, `fed_invites`, `oidc_`, `oauth_`, `recovery_codes`, `email_codes`, `enrollments`, `challenges`, `notify_targets`, `instance`, `update_requests`, `deploy_requests`; an unreadable file is flagged too

Paths are compared in one normal form (lowercase, `./` and `..` resolved, a leading `code/` dropped), and renames count for both old and new path.

## OIDC login

An admin configures a provider with `POST /api/auth/oidc/providers` (`name`, `issuer`, `clientId`, optional `clientSecret`). It needs an instance admin and step-up. The client secret is stored as `oidc.<provider id>` in `secrets.json` and is never returned; the list only says whether one is set.

Login is the authorization code flow with PKCE, `state` and `nonce`. The ID token is checked against the provider's keys (RS256 or ES256), issuer, audience, expiry and nonce, and the email must be verified.

- The provider is trusted to vouch for the address. Only add providers whose issuer you control or trust.
- The first login pins the provider's issuer and the `sub` to the user. A later login with a different issuer or `sub` is refused, even with the same email. The pin is on the issuer, not on the provider entry, so deleting and re-adding a provider with the same issuer does not lock anyone out. One `(issuer, sub)` pins one user, and provider entries with the same issuer share their pins even if the client ids differ. Migration 038 carried the old pins over by issuer: pins whose provider entry was already deleted were dropped (those users pin again on their next login), and where two users shared one `(issuer, sub)` only one pin was kept, chosen arbitrarily. An instance admin can clear a pin with `DELETE /api/auth/oidc/users/:userId/identity` (step-up needed); `GET` on the same path shows it. The user then pins again on the next OIDC login.
- Existing users only. The email must match a user that already exists. No account is created; new users still come in through an invite.
- An OIDC login opens a session of the same kind as an email-code login. It proves the address, not a passkey, so it starts without step-up. Actions that need step-up still need a passkey touch.

## Mobile Apps (iOS & Android)

The native iOS and Android apps connect directly to your Harness instance over HTTPS (or `http://127.0.0.1` / loopback during local testing) using a per-device bearer token (`hmob_...`). Each device holds its own P-256 signing key in the platform keychain/keystore (Secure Enclave on iOS, Android Keystore on Android).

### Pairing from `#/account`

1. Sign in to the web UI on your Harness instance and open `#/account`.
2. Start a mobile pairing code (`POST /api/auth/mobile/pair/start`, requires step-up). The UI displays a QR code encoding `harness://pair?origin=<origin>&code=<code>` (valid for 5 minutes, single-use).
3. Scan the QR code in the mobile app (or paste the origin and pairing code). The app requests a challenge from `/api/auth/mobile/pair/options`, signs `harness-mobile-pair-v1|<origin>|<challengeId>|<nonce>` with its hardware P-256 key, and exchanges it at `/api/auth/mobile/pair/verify` for a long-lived `hmob_...` bearer token.

### Bootstrap enrollment codes

On a fresh instance with no users yet (or when an admin generates an enrollment code for a user), the app can redeem an enrollment code directly via `/api/auth/mobile/enroll/:code/options` and `/api/auth/mobile/enroll/:code/verify`. This registers the device's P-256 public key, issues a `hmob_...` token, and returns 10 recovery codes.

### Multi-instance switching over Tailscale or Cloudflare Tunnel

Each paired instance is stored in the app's instance registry keyed by its origin (`https://<host>`), with its bearer token and device key scoped to that instance. You can pair multiple Harness instances exposed via Tailscale Serve (`https://<node>.<tailnet>.ts.net`) or Cloudflare Tunnel (`https://<subdomain>.example.com`) and switch active instances from the workspace switcher without re-pairing.

### Hardware P-256 biometric step-up

Risky actions (such as halting runs, approving self-updates, or managing federation peers) require a fresh step-up within the last 5 minutes. When an endpoint returns `403 { "error": "step_up_required" }`, the app prompts for Face ID / Touch ID / Android BiometricPrompt to unlock the hardware P-256 key, requests `/api/auth/mobile/step-up/options`, signs `harness-mobile-stepup-v1|<origin>|<sessionId>|<challengeId>|<nonce>`, and submits to `/api/auth/mobile/step-up/verify`.

### Self-hosting `tools/push-relay/relay.ts` for APNs/FCM

Harness instances never hold Apple or Google push credentials directly. Instead, when a mobile device subscribes via `POST /api/notify/push/mobile`, the instance signs push envelopes with HMAC-SHA256 (`x-harness-push-signature: sha256=<hex>`) and forwards them to a stateless push relay.

To self-host the relay, run `tools/push-relay/relay.ts` (`createRelayHandler(config)`) behind HTTPS and configure:

- `secret`: shared HMAC secret matching the `relaySecret` registered by the device
- `apnsTopic` / `apnsEndpoint`: Apple Push Notification service topic (app bundle ID) and endpoint
- `fcmProjectId` / `fcmToken` / `fcmEndpoint`: Firebase Cloud Messaging v1 project ID and OAuth2 bearer token

The relay verifies the HMAC signature, translates the envelope into an APNs alert (`interruption-level: time-sensitive` or `active`) or high-priority FCM data message, and returns `410` when a device token is unregistered so Harness prunes stale targets automatically.

## Known gaps

- No relay between grantees. A project is shared from its home to each peer; two peers do not see each other's changes except through the home, and a change on a copy reaches only the home.
- The stub org that holds a remote copy gets the receiving instance's admins as members at the first pull, only while the org has no members. Any admin of that stub org can then add other users.
- Notes replicate their `disk` and `hash` fields. The receiving instance does not write the file to disk, and the hash is only used for the 409 check on the home.
- The compiled binary cannot launch agents: the sandbox runtime, guard hook and agent CLI paths are resolved from the source tree, so a deployed copy can hold and sync data but cannot run agents.
- A service install (systemd or launchd unit) runs `~/.harness/bin/harness`, but self-update flips `<home>/bin/current`. Updating an instance installed this way needs the unit pointed at `<home>/bin/current` by hand.
- Member and org deletes are not replicated.
- Deploy approvals do not expire, and old snapshots and built binaries are not cleaned up.
- Revoking a share does not delete the copy on the peer.
- A Tailscale Serve mapping is not restored after a restart. Set it again by hand.
- Deploy to a real remote host has not been tested. It is covered with a local transport and fake `ssh`, `tailscale` and `docker` binaries only.
- A remote deploy target is not paired automatically (see above).
