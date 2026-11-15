import type { LoginProcess } from "./api";

const STOP_WAIT_MS = 5000;
const running = new Map<string, { command: string[]; proc: LoginProcess }>();

export function runningLogin(id: string): string[] | undefined {
  return running.get(id)?.command;
}

export function trackLogin(id: string, command: string[], proc: LoginProcess): void {
  running.set(id, { command, proc });
}

export function forgetLogin(id: string): void {
  running.delete(id);
}

// Removal must not leave a login behind that writes credentials into a deleted home.
export async function stopLogin(id: string): Promise<void> {
  const entry = running.get(id);
  if (!entry) return;
  entry.proc.kill();
  const exited = entry.proc.exited.then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([exited, Bun.sleep(STOP_WAIT_MS)]);
}
