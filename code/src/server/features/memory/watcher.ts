import type { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { sep } from "node:path";
import { syncOutside } from "./outside";
import { diskToLocated } from "./paths";
import { vaultDir } from "./vault";

const DEBOUNCE_MS = 200;

function relevant(rel: string): boolean {
  return rel.endsWith(".md") && diskToLocated(rel) !== null;
}

export function watchVault(db: Database, home: string): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(vaultDir(home), { recursive: true }, (_event, name) => {
    if (name === null) return;
    const rel = name.split(sep).join("/");
    if (!relevant(rel)) return;
    clearTimeout(timers.get(rel));
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel);
        try {
          syncOutside(db, home, rel);
        } catch (e) {
          console.error(`memory: watcher failed for ${rel}: ${(e as Error).message}`);
        }
      }, DEBOUNCE_MS),
    );
  });
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
