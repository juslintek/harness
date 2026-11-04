import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { redact } from "../logs/api";
import { hashText, parseNote, serializeNote } from "./frontmatter";
import { queueCommit, setOutsideSyncer } from "./git-log";
import { logWrite } from "./index-log";
import { getIndexedByDisk, type IndexedNote, removeIndexed, upsertIndexed } from "./index-repo";
import { diskToLocated, type Located } from "./paths";
import { emitOutside } from "./store-kit";
import { FileChanged, isMissingPath, readNoteFile, vaultDir, writeNoteFileAtomic } from "./vault";

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
  queueCommit(home, `outside ${loc.disk}`, db);
  emitOutside(loc.orgId, noteId);
}

// Rewrites the file only if it still holds the text we just read; otherwise a newer edit is on
// disk and its own event will be handled, so null tells the caller to stop.
function rewriteIfUnchanged(home: string, disk: string, read: string, next: string): string | null {
  if (readNoteFile(home, disk) !== read) return null;
  try {
    writeNoteFileAtomic(home, disk, next, hashText(read));
  } catch (e) {
    if (e instanceof FileChanged) return null;
    throw e;
  }
  return next;
}

// A secret typed into the vault by hand must not stay on disk or reach git history, so the file
// is replaced by its redacted form before anything indexes or commits it.
function scrubbed(home: string, disk: string, text: string): string | null {
  const clean = redact(text);
  return clean === text ? text : rewriteIfUnchanged(home, disk, text, clean);
}

// Two files claiming one id: the indexed row keeps it and the newcomer's frontmatter gets the
// fresh id, so it survives the next reindex.
function settleId(db: Database, home: string, loc: Located, text: string): IndexedNote {
  const note = upsertIndexed(db, loc, text);
  const { meta, body } = parseNote(text);
  if (meta.id === undefined || meta.id === note.id) return note;
  const fixed = serializeNote({ ...meta, id: note.id }, body);
  const next = rewriteIfUnchanged(home, loc.disk, text, fixed);
  return next === null ? note : upsertIndexed(db, loc, next);
}

// The one place an on-disk change that did not come through the store enters the index: the
// watcher, reconcile and reads all call it, so whichever runs first leaves the audit row and the
// commit and the others see an equal hash and do nothing.
export function syncOutside(db: Database, home: string, disk: string): IndexedNote | null {
  const loc = diskToLocated(disk);
  if (loc === null) return null;
  // A dir of an org this instance does not know cannot be indexed (foreign key).
  if (loc.orgId !== null && db.query("SELECT 1 FROM orgs WHERE id = ?").get(loc.orgId) === null)
    return null;
  const prior = getIndexedByDisk(db, disk);
  if (isMissingPath(join(vaultDir(home), disk))) {
    if (prior === null) return null;
    removeIndexed(db, disk);
    logOutside(db, home, loc, prior.id, priorText(db, disk, prior.hash), null, prior.hash);
    return null;
  }
  // Symlinks, directories and unreadable files come back null and are never indexed.
  const read = readNoteFile(home, disk);
  if (read === null) return null;
  if (prior?.hash === hashText(read)) return prior;
  const text = scrubbed(home, disk, read);
  if (text === null) return prior;
  const note = settleId(db, home, loc, text);
  const after = readNoteFile(home, disk) ?? text;
  logOutside(db, home, loc, note.id, priorText(db, disk, prior?.hash), after, prior?.hash);
  return note;
}

setOutsideSyncer(syncOutside);
