import { mkdirSync, rmSync } from "node:fs";
import { childEnv, stopProcess, waitHealth } from "./proc";
import { copyToScratch } from "./snapshot";

const LISTENING = /listening on http:\/\/127\.0\.0\.1:(\d+)/;

export async function readPort(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`new binary exited before listening: ${seen.slice(-500)}`);
    seen += chunk.value;
    const match = LISTENING.exec(seen);
    if (match?.[1]) return Number(match[1]);
  }
}

// Blue/green check: the new binary migrates a copy of the live data on its own port, so a bad
// migration or a crash on boot shows up before the live process is touched.
export async function verifyOnScratch(opts: {
  binary: string;
  snapshot: string;
  scratchHome: string;
  version: string;
  timeoutMs: number;
}): Promise<void> {
  rmSync(opts.scratchHome, { recursive: true, force: true });
  mkdirSync(opts.scratchHome, { recursive: true });
  copyToScratch(opts.snapshot, opts.scratchHome);
  const proc = Bun.spawn([opts.binary], {
    cwd: opts.scratchHome,
    env: childEnv({ HARNESS_HOME: opts.scratchHome, HARNESS_PORT: "0" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const port = await Promise.race([
      readPort(proc),
      Bun.sleep(opts.timeoutMs).then(() => {
        throw new Error(`new binary did not start listening within ${opts.timeoutMs} ms`);
      }),
    ]);
    await waitHealth(port, opts.version, opts.timeoutMs, proc.exited);
  } finally {
    await stopProcess(proc);
    rmSync(opts.scratchHome, { recursive: true, force: true });
  }
}
