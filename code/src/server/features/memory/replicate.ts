import type { Database } from "bun:sqlite";
import { redact } from "../logs/api";
import { hashText } from "./frontmatter";
import { queueCommit } from "./git-log";
import { removeIndexed, upsertIndexed } from "./index-repo";
import { diskToLocated } from "./paths";
import { readNoteFile, removeNoteFile, writeNoteFileAtomic } from "./vault";

export function readNoteText(home: string, disk: string): string | null {
  return readNoteFile(home, disk);
}

// Stores a project note that arrived from a paired instance: the file, notes_fts and links are
// written the way a local write does it. False when the path does not match the row it came with,
// so a peer cannot write anywhere else in the vault.
export function writeReplicatedNote(
  db: Database,
  home: string,
  note: { disk: string; org_id: string; project_id: string },
  text: string,
): boolean {
  const loc = diskToLocated(note.disk);
  if (loc === null || loc.scope !== "project") return false;
  if (loc.orgId !== note.org_id || loc.projectId !== note.project_id) return false;
  const clean = redact(text);
  const current = readNoteFile(home, note.disk);
  writeNoteFileAtomic(home, note.disk, clean, current === null ? null : hashText(current));
  upsertIndexed(db, loc, clean, home);
  queueCommit(home, `replicate ${note.disk}`, db);
  return true;
}

export function removeReplicatedNote(db: Database, home: string, disk: string): void {
  const current = readNoteFile(home, disk);
  if (current !== null) removeNoteFile(home, disk, hashText(current));
  removeIndexed(db, disk);
  queueCommit(home, `replicate remove ${disk}`, db);
}
