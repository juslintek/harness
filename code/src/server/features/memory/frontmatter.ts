import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { NoteScope, NoteType } from "../../../shared/memory";

export interface NoteMeta {
  id?: string;
  type?: NoteType;
  scope?: NoteScope;
  tags: string[];
  sourceAgent?: string;
  created?: string;
  updated?: string;
  confidence?: number;
  extra: Record<string, unknown>;
}

const TYPES: readonly string[] = ["lesson", "fact", "decision", "howto", "reference"];
const SCOPES: readonly string[] = ["global", "org", "project", "agent"];
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const KNOWN = new Set([
  "id",
  "type",
  "scope",
  "tags",
  "source_agent",
  "created",
  "updated",
  "confidence",
]);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fromRecord(raw: Record<string, unknown>): NoteMeta {
  const meta: NoteMeta = {
    tags: Array.isArray(raw["tags"]) ? raw["tags"].map(String) : [],
    extra: {},
  };
  const type = str(raw["type"]);
  const scope = str(raw["scope"]);
  if (str(raw["id"]) !== undefined) meta.id = str(raw["id"]) as string;
  if (type !== undefined && TYPES.includes(type)) meta.type = type as NoteType;
  if (scope !== undefined && SCOPES.includes(scope)) meta.scope = scope as NoteScope;
  if (str(raw["source_agent"]) !== undefined) meta.sourceAgent = str(raw["source_agent"]) as string;
  if (str(raw["created"]) !== undefined) meta.created = str(raw["created"]) as string;
  if (str(raw["updated"]) !== undefined) meta.updated = str(raw["updated"]) as string;
  if (typeof raw["confidence"] === "number") meta.confidence = raw["confidence"];
  for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k)) meta.extra[k] = v;
  return meta;
}

export function parseNote(text: string): { meta: NoteMeta; body: string } {
  const none = { meta: { tags: [], extra: {} } as NoteMeta, body: text };
  const m = FM.exec(text);
  if (!m) return none;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(m[1] ?? "");
  } catch {
    return none;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return none;
  return {
    meta: fromRecord(raw as Record<string, unknown>),
    body: text.slice(m[0].length).replace(/^\r?\n/, ""),
  };
}

export function serializeNote(meta: NoteMeta, body: string): string {
  const out: Record<string, unknown> = {};
  if (meta.id !== undefined) out["id"] = meta.id;
  if (meta.type !== undefined) out["type"] = meta.type;
  if (meta.scope !== undefined) out["scope"] = meta.scope;
  out["tags"] = meta.tags;
  if (meta.sourceAgent !== undefined) out["source_agent"] = meta.sourceAgent;
  if (meta.created !== undefined) out["created"] = meta.created;
  if (meta.updated !== undefined) out["updated"] = meta.updated;
  if (meta.confidence !== undefined) out["confidence"] = meta.confidence;
  Object.assign(out, meta.extra);
  const yaml = Bun.YAML.stringify(out, null, 2);
  return `---\n${yaml}\n---\n\n${body.replace(/\n+$/, "")}\n`;
}

export function noteTitle(body: string, rel: string): string {
  const h = /^# +(.+?)\s*$/m.exec(stripFences(body));
  return h?.[1] ?? basename(rel).replace(/\.md$/, "");
}

function stripFences(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "");
}

export function wikilinks(body: string): string[] {
  const found = new Set<string>();
  for (const m of stripFences(body).matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = (m[1] ?? "").split("#")[0]?.trim().toLowerCase();
    if (target) found.add(target);
  }
  return [...found];
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
