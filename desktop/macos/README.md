# Harness for macOS

Native SwiftUI shell around the Zig backend. It starts `harness serve` as a child
process on a random loopback port and signs in with the email code flow.
macOS 14+, Swift 6, no third-party dependencies.

Build the backend (about 2 minutes):

    cd zig && zig build -Doptimize=ReleaseSafe -Dembed-ui=false

Tests run against the real binary (`HARNESS_BIN`, else `zig/zig-out/bin/harness`;
a missing binary fails the tests):

    cd desktop/macos && swift test

Run the app:

    cd desktop/macos && HARNESS_BIN=$PWD/../../zig/zig-out/bin/harness swift run HarnessMac

Against the TypeScript server instead (needs bun and `bun install` in `code/`):

    cd desktop/macos && HARNESS_SERVER_DIR=$PWD/../../code swift run HarnessMac

`swift test` also boots that server on a home seeded by `Tests/support/seed.ts`; it fails, not
skips, when bun or `code/node_modules` is missing.

Data lives in `~/Library/Application Support/Harness`. In the app, the sign-in
code is printed in the Backend log, since the backend has no mail transport. The
Backend Log window (Cmd-Shift-L, or "Show Backend Log" on the sign-in form) shows it while signed out.

The sidebar has an organisation picker and a board per project (columns, inspector, move by
context menu or drag and drop, live refresh over WebSocket). The Zig backend answers 501 for
these and the app says so.

Chat (org channels, teams, projects, groups, DMs) has a channel list with unread badges, messages with
paging ("Load earlier"), a composer (Return sends, Shift-Return newline), threads in the inspector,
New Channel (creates a group) and live refresh. Same 501 handling as the board.

Not done: runs, approvals, chat @mentions, message editing, starting a DM, picking members for a new
group, DM names shown as the other person, passkey
and OIDC sign-in, an `.app` bundle with the binary in `Contents/Resources`,
code signing, and cleanup of a backend left behind when the app is SIGKILLed.
