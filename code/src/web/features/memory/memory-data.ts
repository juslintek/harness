import { z } from "zod";
import {
  type LessonView,
  lessonViewSchema,
  type NoteScope,
  type NoteSummary,
  type NoteView,
  type NoteWriteFeedItem,
  noteSummarySchema,
  noteViewSchema,
  noteWriteFeedItemSchema,
} from "../../../shared/memory";
import type { OrgDetail, Role } from "../../../shared/orgs";

// Granted projects belong to another org; memory only accepts notes for the viewer's own org.
export const ownProjects = (detail: OrgDetail): OrgDetail["projects"] =>
  detail.projects.filter((p) => p.orgId === detail.org.id);

export type Tab = "notes" | "writes" | "review";
export const TABS: Tab[] = ["notes", "writes", "review"];

export interface Facets {
  scopes: Record<string, number>;
  types: Record<string, number>;
  tags: Record<string, number>;
  sources: Record<string, number>;
}

const counts = z.record(z.string(), z.number());
export const facetsSchema: z.ZodType<Facets> = z.object({
  scopes: counts,
  types: counts,
  tags: counts,
  sources: counts,
});
export const noteListSchema: z.ZodType<NoteSummary[]> = z.array(noteSummarySchema);
export const lessonListSchema: z.ZodType<LessonView[]> = z.array(lessonViewSchema);

export const writeListSchema: z.ZodType<NoteWriteFeedItem[]> = z.array(noteWriteFeedItemSchema);

export const writeResultSchema: z.ZodType<{ note: NoteView; redacted: boolean }> = z.object({
  note: noteViewSchema,
  redacted: z.boolean(),
});

// A draft that still equals the server text was never edited, so it must not replace the one the
// user wrote before an earlier conflict.
export const keptAfterReload = (
  kept: string | null,
  draft: string,
  serverBody: string,
): string | null => (draft === serverBody ? kept : draft);

// Escape closes the editor, so an edited draft needs a yes first; an untouched one just closes.
export const mayDiscard = (dirty: boolean, ask: (q: string) => boolean): boolean =>
  !dirty || ask("Discard your unsaved changes?");

export const memoryBase = (slug: string): string => `/api/orgs/${slug}/memory`;

export const tabOf = (part: string | undefined): Tab => TABS.find((t) => t === part) ?? "notes";

export const notesHash = (slug: string, id?: string): string =>
  `#/o/${slug}/memory/notes${id ? `/${id}` : ""}`;

// Stored paths start with the org id, which means nothing to a reader.
export const shownPath = (path: string): string => path.replace(/^orgs\/[^/]+\//, "");

// The server rejects an unwritable scope; this only keeps the form from offering one. Agents never
// write global, and only an instance admin does from the UI.
export function writableScopes(
  role: Role,
  instanceAdmin: boolean,
  hasProjects: boolean,
): NoteScope[] {
  if (role === "viewer") return [];
  return [
    "org",
    ...(hasProjects ? (["project"] as const) : []),
    ...(instanceAdmin ? (["global"] as const) : []),
  ];
}

export type BodyPart = { text: string } | { link: string; label: string };

// Links are cut out of plain text so a body never reaches the DOM as markup.
export function splitLinks(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
    const target = (m[1] ?? "").split("#")[0]?.trim() ?? "";
    if (target === "") continue;
    parts.push({ text: body.slice(last, m.index) });
    parts.push({ link: target, label: m[2]?.trim() || (m[1] ?? "").trim() });
    last = m.index + m[0].length;
  }
  parts.push({ text: body.slice(last) });
  return parts;
}

const slugOf = (path: string): string => (path.split("/").pop() ?? "").replace(/\.md$/, "");

export function pickLinkTarget(hits: NoteSummary[], target: string): NoteSummary | null {
  const t = target.toLowerCase();
  return (
    hits.find((h) => h.title.toLowerCase() === t || slugOf(h.path).toLowerCase() === t) ?? null
  );
}
