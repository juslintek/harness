import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Owner-only: the index holds org notes, and the run dir is the only place the agent can read it.
export async function memoryFileEnv(
  runDir: string,
  index: string | undefined,
): Promise<Record<string, string>> {
  if (index === undefined) return {};
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "MEMORY.md");
  await writeFile(path, index, { mode: 0o600 });
  return { HARNESS_MEMORY_FILE: path };
}
