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
// The project restriction is part of the query because the FETCH cap would otherwise fill with
// other projects' notes and push the run's own out before the filter in buildMemoryIndex.
function ranked(
  db: Database,
  viewer: Viewer,
  taskText: string,
  onlyProject: string | undefined,
): NoteSummary[] {
  const hits =
    taskText.trim() === ""
      ? []
      : searchNotes(db, viewer, { text: taskText, anyWord: true, limit: FETCH, onlyProject });
  const seen = new Set(hits.map((n) => n.id));
  return [
    ...hits,
    ...searchNotes(db, viewer, { limit: FETCH, onlyProject }).filter((n) => !seen.has(n.id)),
  ];
}

// Lessons are fetched by their own query: the capped candidates above are the newest notes, and an
// old accepted lesson would otherwise fall out once enough newer notes exist.
function lessonsOf(db: Database, viewer: Viewer, projectId: string | null): NoteSummary[] {
  const base = { type: "lesson", limit: FETCH } as const;
  return [
    ...searchNotes(db, viewer, { ...base, scope: "org" }),
    ...(projectId === null
      ? []
      : searchNotes(db, viewer, { ...base, scope: "project", projectId })),
  ];
}

// The index holds the redacted body, so a secret that reached a file by hand never reaches a prompt.
function bodyOf(db: Database, noteId: string): string {
  const row = db
    .query<{ body: string }, [string]>(
      "SELECT f.body FROM notes_fts f JOIN notes n ON n.seq = f.rowid WHERE n.id = ?",
    )
    .get(noteId);
  return row?.body ?? "";
}

// For agents whose CLI cannot call the memory tool: the notes they may read, as one Markdown file.
export function buildMemoryIndex(
  db: Database,
  viewer: Viewer,
  projectId: string | null,
  taskText: string,
): string {
  const slugs = projectSlugs(db, viewer.orgId);
  const wanted = projectId;
  const candidates = [
    ...ranked(db, viewer, taskText, projectId ?? undefined),
    ...lessonsOf(db, viewer, wanted),
  ];
  const notes = [...new Map(candidates.map((n) => [n.id, n])).values()].filter(
    (n) => n.scope !== "project" || projectId === null || n.projectId === wanted,
  );
  const parts: string[] = [];
  let size = 0;
  // Lessons are cross-cutting rules, so they lead even when the task text matches nothing in them.
  const isLesson = (n: NoteSummary): boolean =>
    n.type === "lesson" &&
    (n.scope === "org" || (wanted !== null && n.scope === "project" && n.projectId === wanted));
  const lessons = notes.filter(isLesson).sort((a, b) => b.updated.localeCompare(a.updated));
  const groups: Array<[NoteSummary[], string]> = [
    [lessons, "# Project and org lessons"],
    ...SCOPES.map(([scope, heading]): [NoteSummary[], string] => [
      notes.filter((x) => x.scope === scope && !isLesson(x)),
      heading,
    ]),
  ];
  for (const [group, heading] of groups) {
    let open = false;
    for (const n of group) {
      const entry = `## ${n.title}\n${virtualPathOf(n, slugs)}\n\n${bodyOf(db, n.id).trim()}\n\n`;
      const cost = Buffer.byteLength(entry) + (open ? 0 : Buffer.byteLength(heading) + 2);
      if (size + cost > MAX_BYTES) continue;
      if (!open) parts.push(`${heading}\n\n`);
      open = true;
      parts.push(entry);
      size += cost;
      logRead(db, n.id, null, viewer.memberId, "index");
    }
  }
  return parts.join("");
}
