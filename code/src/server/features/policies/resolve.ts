import type { Database } from "bun:sqlite";
import type { z } from "zod";
import {
  type Layer,
  layers,
  type PolicyKey,
  type PolicyValue,
  policyKeyNames,
  policyKeys,
} from "../../../shared/policies";
import { contextForTarget, getPolicyRow, type PolicyContext, upsertPolicy } from "./repo";

export interface Effective<T> {
  key: PolicyKey;
  value: T;
  layer: Layer | "default";
  targetId: string | null;
  setBy: string | null;
  chain: { layer: Layer; targetId: string; value: unknown }[];
}

interface KeyDef {
  schema: z.ZodType;
  default: unknown;
  tightenOnly?: readonly unknown[];
}
const defOf = (key: PolicyKey): KeyDef => policyKeys[key];

function targetFor(ctx: PolicyContext, layer: Layer): string | undefined {
  if (layer === "harness") return "";
  if (layer === "org") return ctx.orgId;
  if (layer === "team") return ctx.teamId;
  return layer === "agent" ? ctx.memberId : ctx.taskId;
}

// Resolves over the layers before `stop` only, so setPolicy can ask what the parents would give.
function resolve(
  db: Database,
  ctx: PolicyContext,
  key: PolicyKey,
  stop: number,
): Effective<unknown> {
  const def = defOf(key);
  const rows = layers.slice(0, stop).flatMap((layer) => {
    const targetId = targetFor(ctx, layer);
    const row = targetId === undefined ? null : getPolicyRow(db, layer, targetId, key);
    return row ? [row] : [];
  });
  const chain = rows.map(({ layer, targetId, value }) => ({ layer, targetId, value }));
  const order = def.tightenOnly;
  // For a tighten-only key the strictest row wins, so a looser stale row below a parent never does.
  const winner = rows.reduce<(typeof rows)[number] | null>((best, row) => {
    if (!best || !order) return row;
    return order.indexOf(row.value) > order.indexOf(best.value) ? row : best;
  }, null);
  if (!winner)
    return { key, value: def.default, layer: "default", targetId: null, setBy: null, chain };
  const { value, layer, targetId, setBy } = winner;
  return { key, value, layer, targetId, setBy, chain };
}

export function effective<K extends PolicyKey>(
  db: Database,
  ctx: PolicyContext,
  key: K,
): Effective<PolicyValue<K>> {
  return resolve(db, ctx, key, layers.length) as Effective<PolicyValue<K>>;
}

export function explain(db: Database, ctx: PolicyContext): Effective<unknown>[] {
  return policyKeyNames.map((key) => resolve(db, ctx, key, layers.length));
}

export type SetResult = { ok: true } | { ok: false; reason: string };

export function setPolicy(
  db: Database,
  input: { layer: Layer; targetId: string; key: PolicyKey; value: unknown; setBy: string },
): SetResult {
  const def = policyKeys[input.key] as KeyDef | undefined;
  if (!def) return { ok: false, reason: "unknown key" };
  const parsed = def.schema.safeParse(input.value);
  if (!parsed.success) return { ok: false, reason: "invalid value" };
  if (input.layer !== "harness") {
    const ctx = contextForTarget(db, input.layer, input.targetId);
    if (!ctx) return { ok: false, reason: "unknown target" };
    const parent = resolve(db, ctx, input.key, layers.indexOf(input.layer));
    const order = def.tightenOnly;
    if (order && order.indexOf(parsed.data) < order.indexOf(parent.value)) {
      return { ok: false, reason: `looser than ${parent.layer}` };
    }
  }
  const targetId = input.layer === "harness" ? "" : input.targetId;
  const { layer, key, setBy } = input;
  upsertPolicy(db, { layer, targetId, key, value: parsed.data, setBy });
  return { ok: true };
}
