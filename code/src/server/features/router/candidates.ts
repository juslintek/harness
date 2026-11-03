import type { Database } from "bun:sqlite";
import { type Engine, QUOTA_PROVIDER } from "../../../shared/router";
import { type AgentView, listAgents } from "../agents/api";
import { contextForMember, effective } from "../policies/api";
import { ensureProfile } from "../profiles/api";
import { probeQuota, type QuotaView } from "../usage/api";
import { priceOf } from "./registry";
import { scoreEngine, tierOf } from "./score";
import { learnedStats, type StatRow } from "./stats";
import { triageOf } from "./triage";

export interface RouteChoice {
  engine: Engine;
  score: number;
  reasons: string[];
}

export interface RouteInput {
  memberId: string;
  taskId?: string | null | undefined;
  exclude?: Engine[] | undefined;
}

// Tests inject a fixed agent list; real discovery spawns every installed CLI.
export interface RouteDeps {
  agents?: () => Promise<AgentView[]>;
}

const LEARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const sameEngine = (a: Engine, b: Engine): boolean =>
  a.runtime === b.runtime && a.model === b.model;

function windowsOf(quota: QuotaView[], runtime: string): number[] {
  const provider = QUOTA_PROVIDER[runtime];
  return quota.flatMap((q) =>
    q.provider === provider && q.usedPercent !== null ? [q.usedPercent] : [],
  );
}

function statOf(stats: StatRow[], engine: Engine, taskType: string | null): StatRow | null {
  return (
    stats.find(
      (s) => s.runtime === engine.runtime && s.model === engine.model && s.taskType === taskType,
    ) ?? null
  );
}

function candidateEngines(
  profile: { runtime: string; model: string | null; fallbacks: Engine[] },
  usable: AgentView[],
): Engine[] {
  const primary: Engine = { runtime: profile.runtime, model: profile.model };
  const others =
    profile.fallbacks.length > 0
      ? profile.fallbacks
      : usable.filter((a) => a.id !== profile.runtime).map((a) => ({ runtime: a.id, model: null }));
  return [primary, ...others];
}

// A window reset in the past already reads as null usage, so 100% here means exhausted now.
export async function route(
  db: Database,
  input: RouteInput,
  deps: RouteDeps = {},
): Promise<RouteChoice[]> {
  const profile = ensureProfile(db, input.memberId);
  const ctx = contextForMember(db, input.memberId, input.taskId ?? undefined);
  const allowed = effective(db, ctx, "router.allowedRuntimes").value;
  const agents = await (deps.agents ?? (() => listAgents(db)))();
  const usable = agents.filter((a) => a.enabled && a.loggedIn !== false);
  const quota = await probeQuota(db);
  const triage = input.taskId ? triageOf(db, input.taskId) : null;
  const stats = learnedStats(db, Date.now() - LEARN_WINDOW_MS);
  const primary = { runtime: profile.runtime, model: profile.model };

  return candidateEngines(profile, usable)
    .filter((e) => usable.some((a) => a.id === e.runtime))
    .filter((e) => allowed === null || allowed.includes(e.runtime))
    .filter((e) => !windowsOf(quota, e.runtime).some((used) => used >= 100))
    .filter((e) => !(input.exclude ?? []).some((x) => sameEngine(x, e)))
    .map((engine) => {
      const used = windowsOf(quota, engine.runtime);
      const price = priceOf(db, engine);
      const headroom = used.length === 0 ? null : 1 - Math.max(...used) / 100;
      const stat = statOf(stats, engine, triage?.taskType ?? null);
      const isPrimary = sameEngine(engine, primary);
      const score = scoreEngine({ engine, primary: isPrimary, triage, price, headroom, stat });
      const reasons = [
        ...(isPrimary ? ["profile primary"] : []),
        `tier ${tierOf(price)}${price ? "" : " (no price)"} for ${triage?.difficulty ?? "unknown"} difficulty`,
        headroom === null ? "no quota data" : `${Math.round(headroom * 100)}% quota left`,
        stat ? `${stat.completed}/${stat.runs} completed recently` : "no history",
      ];
      return { engine, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}
