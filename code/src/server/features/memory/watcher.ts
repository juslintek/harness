import type { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { sep } from "node:path";
import { syncOutside } from "./outside";
import { diskToLocated } from "./paths";
import { reconcile } from "./reconcile";
import { vaultDir } from "./vault";

const DEBOUNCE_MS = 200;
// A moved directory arrives as one event for the directory, not for the notes inside it.
const RECONCILE_DEBOUNCE_MS = 500;

function relevant(rel: string): boolean {
  return rel.endsWith(".md") && diskToLocated(rel) !== null;
}

// Atomic writes (*.tmp) and git's own files are churn that never changes a note.
function directoryLevel(rel: string): boolean {
  if (rel.endsWith(".md") || rel.endsWith(".tmp")) return false;
  return !rel.split("/").some((part) => part.startsWith("."));
}

export function watchVault(db: Database, home: string): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let sweep: ReturnType<typeof setTimeout> | undefined;
  const sweepLater = (): void => {
    clearTimeout(sweep);
    sweep = setTimeout(() => {
      try {
        reconcile(db, home);
      } catch (e) {
        console.error(`memory: watcher reconcile failed: ${(e as Error).message}`);
      }
    }, RECONCILE_DEBOUNCE_MS);
  };
  const watcher = watch(vaultDir(home), { recursive: true }, (_event, name) => {
    const rel = name === null ? null : name.split(sep).join("/");
    if (rel === null || directoryLevel(rel)) return sweepLater();
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
    clearTimeout(sweep);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
