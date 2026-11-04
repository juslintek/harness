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

// Plain assignment of "__proto__" would change the prototype instead of adding a key.
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function fromRecord(raw: Record<string, unknown>): NoteMeta {
  const meta: NoteMeta = { tags: [], extra: {} };
  // Values that fail validation go to extra, so a rewrite after an outside edit keeps them.
  for (const [k, v] of Object.entries(raw)) {
    if (!acceptKnown(meta, k, v)) setOwn(meta.extra, k, v);
  }
  return meta;
}

type Setter = (meta: NoteMeta, v: unknown) => boolean;

function strSetter(set: (meta: NoteMeta, v: string) => void): Setter {
  return (meta, v) => {
    if (typeof v !== "string") return false;
    set(meta, v);
    return true;
  };
}

function enumSetter(allowed: readonly string[], set: (meta: NoteMeta, v: string) => void): Setter {
  return (meta, v) => {
    if (typeof v !== "string" || !allowed.includes(v)) return false;
    set(meta, v);
    return true;
  };
}

const SETTERS: Record<string, Setter> = {
  id: strSetter((m, v) => {
    m.id = v;
  }),
  source_agent: strSetter((m, v) => {
    m.sourceAgent = v;
  }),
  created: strSetter((m, v) => {
    m.created = v;
  }),
  updated: strSetter((m, v) => {
    m.updated = v;
  }),
  type: enumSetter(TYPES, (m, v) => {
    m.type = v as NoteType;
  }),
  scope: enumSetter(SCOPES, (m, v) => {
    m.scope = v as NoteScope;
  }),
  tags: (m, v) => {
    if (!Array.isArray(v) || !v.every((t) => typeof t === "string")) return false;
    m.tags = v;
    return true;
  },
  confidence: (m, v) => {
    // The API schemas require 0..1; one hand-edited file outside that range would make every list fail.
    if (typeof v !== "number" || !(v >= 0 && v <= 1)) return false;
    m.confidence = v;
    return true;
  },
};

function acceptKnown(meta: NoteMeta, key: string, v: unknown): boolean {
  return Object.hasOwn(SETTERS, key) && (SETTERS[key]?.(meta, v) ?? false);
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
  for (const [k, v] of Object.entries(meta.extra)) setOwn(out, k, v);
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
