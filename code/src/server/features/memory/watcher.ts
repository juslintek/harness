import type { Database } from "bun:sqlite";
import { lstatSync, watch } from "node:fs";
import { join, sep } from "node:path";
import { hashText } from "./frontmatter";
import { queueCommit } from "./git-log";
import { logWrite } from "./index-log";
import { getIndexedByDisk, removeIndexed, upsertIndexed } from "./index-repo";
import { diskToLocated, type Located } from "./paths";
import { emitOutside } from "./store-kit";
import { readNoteFile, vaultDir } from "./vault";

const DEBOUNCE_MS = 200;

function isMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

// What the file held before an outside edit, when one of our own writes produced it.
function priorText(db: Database, disk: string, hash: string | undefined): string | null {
  if (hash === undefined) return null;
  const r = db
    .query<{ after_text: string | null }, [string, string]>(
      "SELECT after_text FROM note_writes WHERE disk = ? AND after_hash = ? ORDER BY at DESC, id DESC LIMIT 1",
    )
    .get(disk, hash);
  return r?.after_text ?? null;
}

function logOutside(
  db: Database,
  home: string,
  loc: Located,
  noteId: string,
  before: string | null,
  after: string | null,
  beforeHash: string | undefined,
): void {
  logWrite(db, {
    noteId,
    disk: loc.disk,
    orgId: loc.orgId,
    op: "outside",
    actor: "outside",
    memberId: null,
    runId: null,
    beforeText: before,
    afterText: after,
    beforeHash: beforeHash ?? null,
    afterHash: after === null ? null : hashText(after),
  });
  queueCommit(home, `outside ${loc.disk}`);
  emitOutside(loc.orgId, noteId);
}

function sync(db: Database, home: string, disk: string): void {
  const loc = diskToLocated(disk);
  if (loc === null) return;
  // A dir of an org this instance does not know cannot be indexed (foreign key).
  if (loc.orgId !== null && db.query("SELECT 1 FROM orgs WHERE id = ?").get(loc.orgId) === null)
    return;
  const prior = getIndexedByDisk(db, disk);
  if (isMissing(join(vaultDir(home), disk))) {
    if (prior === null) return;
    removeIndexed(db, disk);
    logOutside(db, home, loc, prior.id, priorText(db, disk, prior.hash), null, prior.hash);
    return;
  }
  // Symlinks, directories and unreadable files come back null and are never indexed.
  const text = readNoteFile(home, disk);
  if (text === null || prior?.hash === hashText(text)) return;
  const note = upsertIndexed(db, loc, text);
  logOutside(db, home, loc, note.id, priorText(db, disk, prior?.hash), text, prior?.hash);
}

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
          sync(db, home, rel);
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
