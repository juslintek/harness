# Harness.Core

Shared C# client for the harness backend, for the Windows and Linux desktop apps. No UI framework,
BCL only. It ports `desktop/macos/Sources/HarnessKit`.

- `BackendProcess` starts and stops `harness serve` and reports its port, log and unexpected exit.
- `ApiClient` talks to the HTTP API; the session cookie stays in memory.

Check against the real server (needs `zig/zig-out/bin/harness`, or set `HARNESS_BIN`):

    dotnet run --project desktop/dotnet/Harness.Core.Check

Not verified: the Windows stop path (`Process.Kill` on the whole tree), because the backend does not
build for Windows yet. Only macOS has been run.
