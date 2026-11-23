// Claude PreToolUse hook entrypoint for source checkouts; compiled binaries run `harness guard-hook`.
import { runGuardHook } from "../src/server/features/guard/api";

process.exit(await runGuardHook());
