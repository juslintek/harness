import { killGroup } from "./acp-rpc";

export interface Live {
  abort: AbortController;
  killReason: string | null;
  denied: boolean;
  // Set when the run itself reported a full quota window, so a later error counts as a rate limit.
  quotaFull?: boolean;
  agent: string;
  pid: number | null;
}

// Aborts every live run, then escalates to SIGKILL on the agent groups once the grace is over.
// `finish` ends whatever is still registered after that, so nothing outlives the harness.
export async function stopAll(
  live: Map<string, Live>,
  waits: Map<string, Promise<unknown>>,
  finish: (id: string, run: Live) => void,
  graceMs: number,
): Promise<void> {
  const ids = [...live.keys()];
  for (const run of live.values()) {
    run.killReason ??= "harness_shutdown";
    run.abort.abort();
    if (run.pid !== null) killGroup(run.pid, "SIGTERM");
  }
  const ended = Promise.allSettled(ids.map((id) => waits.get(id)));
  await Promise.race([ended, Bun.sleep(graceMs)]);
  for (const run of live.values()) if (run.pid !== null) killGroup(run.pid, "SIGKILL");
  await Promise.race([ended, Bun.sleep(1000)]);
  for (const [id, run] of [...live]) finish(id, run);
}
