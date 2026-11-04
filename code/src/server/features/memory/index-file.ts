import type { Database } from "bun:sqlite";
import type { NoteScope, NoteSummary } from "../../../shared/memory";
import { logRead } from "./index-log";
import { searchNotes } from "./index-search";
import type { Viewer } from "./paths";
import { projectSlugs, virtualPathOf } from "./viewer";

const MAX_BYTES = 32 * 1024;
const FETCH = 100;
const SCOPES: Array<[NoteScope, string]> = [
  ["agent", "# Your notes"],
  ["project", "# Project notes"],
  ["org", "# Org notes"],
  ["global", "# Global notes"],
];

// Relevant notes (full-text match on the task) first, then the rest newest first.
function ranked(db: Database, viewer: Viewer, taskText: string): NoteSummary[] {
  const hits =
    taskText.trim() === ""
      ? []
      : searchNotes(db, viewer, { text: taskText, anyWord: true, limit: FETCH });
  const seen = new Set(hits.map((n) => n.id));
  return [...hits, ...searchNotes(db, viewer, { limit: FETCH }).filter((n) => !seen.has(n.id))];
}

// The index holds the redacted body, so a secret that reached a file by hand never reaches a prompt.
function bodyOf(db: Database, noteId: string): string {
  const row = db
    .query<{ body: string }, [string]>(
      "SELECT f.body FROM notes_fts f JOIN notes n ON n.rowid = f.rowid WHERE n.id = ?",
    )
    .get(noteId);
  return row?.body ?? "";
}

// For agents whose CLI cannot call the memory tool: the notes they may read, as one Markdown file.
export function buildMemoryIndex(
  db: Database,
  viewer: Viewer,
  projectSlug: string | null,
  taskText: string,
): string {
  const slugs = projectSlugs(db, viewer.orgId);
  const wanted = projectSlug === null ? null : slugs.idOf(projectSlug);
  const notes = ranked(db, viewer, taskText).filter(
    (n) => n.scope !== "project" || projectSlug === null || n.projectId === wanted,
  );
  const parts: string[] = [];
  let size = 0;
  for (const [scope, heading] of SCOPES) {
    let open = false;
    for (const n of notes.filter((x) => x.scope === scope)) {
      const entry = `## ${n.title}\n${virtualPathOf(n, slugs)}\n\n${bodyOf(db, n.id).trim()}\n\n`;
      const cost = Buffer.byteLength(entry) + (open ? 0 : Buffer.byteLength(heading) + 2);
      if (size + cost > MAX_BYTES) return parts.join("");
      if (!open) parts.push(`${heading}\n\n`);
      open = true;
      parts.push(entry);
      size += cost;
      logRead(db, n.id, null, viewer.memberId, "index");
    }
  }
  return parts.join("");
}
