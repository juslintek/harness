import type { Layer, PolicyKey } from "../../../shared/policies";

export type ScopeLayer = Exclude<Layer, "harness">;

export type Field = { kind: "choice"; options: string[] } | { kind: "number" } | { kind: "list" };

export const fields: Record<PolicyKey, Field> = {
  autonomy: { kind: "choice", options: ["full", "supervised", "strict"] },
  "hiring.decision": { kind: "choice", options: ["auto", "manager", "human"] },
  "hiring.autoMinScore": { kind: "number" },
  "router.allowedRuntimes": { kind: "list" },
  "router.failover": { kind: "choice", options: ["true", "false"] },
  "heartbeat.maxRunsPerHour": { kind: "number" },
};

export function show(value: unknown): string {
  if (value === null || value === undefined) return "no restriction";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

// The text a form control holds for a value; a null list is an empty box.
export const toText = (value: unknown): string =>
  value === null || value === undefined ? "" : show(value);

export type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

export function parseValue(key: PolicyKey, text: string): Parsed {
  const field = fields[key];
  if (field.kind === "number") {
    // Number("") is 0, which would silently be a valid score.
    return text.trim() === "" || Number.isNaN(Number(text))
      ? { ok: false, message: "Enter a number." }
      : { ok: true, value: Number(text) };
  }
  if (field.kind === "list") {
    const names = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { ok: true, value: names.length === 0 ? null : names };
  }
  return { ok: true, value: key === "router.failover" ? text === "true" : text };
}

export const handleOf = (id: string, members: { id: string; handle: string }[]): string =>
  members.find((m) => m.id === id)?.handle ?? id;
