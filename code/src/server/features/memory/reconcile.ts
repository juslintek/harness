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

// Files are the source of truth: the index follows whatever is on disk, including outside edits.
export function reconcile(db: Database, home: string): { indexed: number; removed: number } {
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
    if (text === null) continue;
    if (getIndexedByDisk(db, disk)?.hash === hashText(text)) continue;
    syncOutside(db, home, disk);
    indexed++;
  }
  let removed = 0;
  for (const { disk } of db.query<{ disk: string }, []>("SELECT disk FROM notes").all()) {
    if (seen.has(disk)) continue;
    // The shared path leaves the outside delete audit row; a row it cannot map is dropped as before.
    syncOutside(db, home, disk);
    if (getIndexedByDisk(db, disk) === null || removeIndexed(db, disk) !== null) removed++;
  }
  return { indexed, removed };
}
