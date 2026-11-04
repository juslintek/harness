import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hashText } from "./frontmatter";
import { getIndexedByDisk, removeIndexed, upsertIndexed } from "./index-repo";
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
  try {
    if (!lstatSync(root).isDirectory()) return [];
    const out: string[] = [];
    walk(root, "", out);
    return out;
  } catch {
    return [];
  }
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
    const text = loc === null ? null : readNoteFile(home, disk);
    if (loc === null || text === null) continue;
    // A dir of an org this instance does not know cannot be indexed (foreign key) and stays unseen.
    if (loc.orgId !== null && !orgs.has(loc.orgId)) continue;
    seen.add(disk);
    if (getIndexedByDisk(db, disk)?.hash === hashText(text)) continue;
    upsertIndexed(db, loc, text);
    indexed++;
  }
  let removed = 0;
  for (const { disk } of db.query<{ disk: string }, []>("SELECT disk FROM notes").all()) {
    if (!seen.has(disk) && removeIndexed(db, disk) !== null) removed++;
  }
  return { indexed, removed };
}
