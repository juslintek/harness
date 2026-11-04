import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { drainCommits, ensureVaultRepo } from "./git-log";
import { reconcile } from "./reconcile";
import { vaultDir } from "./vault";
import { watchVault } from "./watcher";

export function startMemory(db: Database, deps: { home: string }): () => Promise<void> {
  mkdirSync(vaultDir(deps.home), { recursive: true, mode: 0o700 });
  ensureVaultRepo(deps.home).catch((e: Error) => {
    console.error(`memory: git init failed: ${e.message}`);
  });
  reconcile(db, deps.home);
  const stopWatch = watchVault(db, deps.home);
  return async () => {
    stopWatch();
    await drainCommits();
  };
}
