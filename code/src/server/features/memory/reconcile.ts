import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { hashText } from "./frontmatter";
import { getIndexedByDisk, removeIndexed } from "./index-repo";
import { syncOutside } from "./outside";
import { diskToLocated } from "./paths";
import { readNoteFile, vaultDir } from "./vault";

function walk(root: string, rel: string, out: string[]): void {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.isSymbolicLink() || e.name === ".git") continue;
    const next = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, next, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(next);
  }
}

function vaultFiles(home: string): string[] {
  const root = vaultDir(home);
  let st: Stats;
  try {
    st = lstatSync(root);
  } catch (e) {
    // Only a missing root is an empty vault; any other error must not read as "all files gone".
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  // A moved-and-linked vault would otherwise read as empty and wipe the index while writes are refused.
  if (!st.isDirectory()) throw new Error(`memory vault is not a plain directory: ${root}`);
  const out: string[] = [];
  walk(root, "", out);
  return out;
}

// One bad file is logged and skipped, as the watcher does, so startup never fails on it.
function syncSafely(db: Database, home: string, disk: string): boolean {
  try {
    syncOutside(db, home, disk);
    return true;
  } catch (e) {
    console.error(`memory: reconcile failed for ${disk}: ${(e as Error).message}`);
    return false;
  }
}

function stillMissing(home: string, disk: string): boolean {
  try {
    lstatSync(join(vaultDir(home), disk));
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function dropMissing(db: Database, home: string, seen: Set<string>): number {
  let removed = 0;
  for (const { disk } of db.query<{ disk: string }, []>("SELECT disk FROM notes").all()) {
    if (seen.has(disk)) continue;
    // The shared path leaves the outside delete audit row; a row it cannot map is dropped as before.
    syncSafely(db, home, disk);
    // Recreated since the snapshot: syncOutside just indexed it, so the row must stay.
    if (!stillMissing(home, disk)) continue;
    if (getIndexedByDisk(db, disk) === null || removeIndexed(db, disk) !== null) removed++;
  }
  return removed;
}

// Files are the source of truth: the index follows whatever is on disk, including outside edits.
export function reconcile(
  db: Database,
  home: string,
  beforeDrop?: () => void,
): { indexed: number; removed: number } {
  const seen = new Set<string>();
  const orgs = new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM orgs")
      .all()
      .map((o) => o.id),
  );
  let indexed = 0;
  for (const disk of vaultFiles(home)) {
    const loc = diskToLocated(disk);
    // A dir of an org this instance does not know cannot be indexed (foreign key) and stays unseen.
    if (loc === null || (loc.orgId !== null && !orgs.has(loc.orgId))) continue;
    // Seen before reading: a file deleted mid-walk keeps its row until the next reconcile.
    seen.add(disk);
    const text = readNoteFile(home, disk);
    // Unreadable (mode 000, swapped for a FIFO): treated as gone, so the row and audit entry go too.
    if (text === null) {
      syncSafely(db, home, disk);
      continue;
    }
    if (getIndexedByDisk(db, disk)?.hash === hashText(text)) continue;
    if (syncSafely(db, home, disk)) indexed++;
  }
  beforeDrop?.();
  const removed = dropMissing(db, home, seen);
  return { indexed, removed };
}
