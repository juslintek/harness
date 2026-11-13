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

Data lives in `~/Library/Application Support/Harness`. In the app, the sign-in
code is printed in the Backend log, since the backend has no mail transport. The
Backend Log window (Cmd-Shift-L, or "Show Backend Log" on the sign-in form) shows it while signed out.

Not done: runs, board, chat and approvals (the backend answers 501), passkey
and OIDC sign-in, an `.app` bundle with the binary in `Contents/Resources`,
code signing, and cleanup of a backend left behind when the app is SIGKILLed.
