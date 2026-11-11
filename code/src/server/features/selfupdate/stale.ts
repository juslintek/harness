import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { pidAlive } from "./proc";
import { failSwap, swappingIds } from "./requests";
import { swapPidFile } from "./swap";

function swapRunning(home: string, id: string): boolean {
  try {
    return pidAlive(Number(readFileSync(swapPidFile(home, id), "utf8")));
  } catch {
    return false;
  }
}

// Runs at boot, when this server is the live one. A `swapping` row whose swap process is gone
// will never be written again, and would otherwise block every later request.
export function failStaleSwaps(db: Database, home: string): void {
  for (const id of swappingIds(db)) if (!swapRunning(home, id)) failSwap(db, id);
}
