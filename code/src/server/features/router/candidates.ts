import type { Database } from "bun:sqlite";
import type { Difficulty, Engine, TaskType } from "../../../shared/router";
import { type AgentView, listAgents } from "../agents/api";
import { contextForMember, effective } from "../policies/api";
import { ensureProfile } from "../profiles/api";
import { probeQuota } from "../usage/api";
import { accountContext, eligibleAccounts, pickBestAccount } from "./accounts";
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
  // Keeps only the runtimes the caller can use for this run, e.g. those able to call MCP tools.
  runtimeFilter?: ((runtime: string) => boolean) | undefined;
}

// Tests inject a fixed agent list; real discovery spawns every installed CLI.
export interface RouteDeps {
  agents?: () => Promise<AgentView[]>;
}

const LEARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const sameEngine = (a: Engine, b: Engine): boolean =>
  a.runtime === b.runtime && a.model === b.model;

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
  const now = Date.now();
  const acctCtx = accountContext(db, input.exclude, now);
  const triage = input.taskId ? triageOf(db, input.taskId) : null;
  const stats = learnedStats(db, now - LEARN_WINDOW_MS);
  const primary = { runtime: profile.runtime, model: profile.model };

  return candidateEngines(profile, usable)
    .filter((e) => usable.some((a) => a.id === e.runtime))
    .filter((e) => allowed === null || allowed.includes(e.runtime))
    .filter((e) => input.runtimeFilter?.(e.runtime) ?? true)
    .flatMap((e) => {
      const best = pickBestAccount(eligibleAccounts(db, e, quota, acctCtx));
      if (!best) return [];
      const engine: Engine = best.explicit
        ? { runtime: e.runtime, model: e.model, accountId: best.id }
        : { runtime: e.runtime, model: e.model };
      const price = priceOf(db, engine);
      const headroom = best.headroom;
      const stat = statOf(stats, engine, triage?.taskType ?? null);
      const isPrimary = sameEngine(e, primary);
      const score = scoreEngine({ engine, primary: isPrimary, triage, price, headroom, stat });
      const reasons = [
        ...(isPrimary ? ["profile primary"] : []),
        `tier ${tierOf(price)}${price ? "" : " (no price)"} for ${triage?.difficulty ?? "unknown"} difficulty`,
        headroom === null ? "no quota data" : `${Math.round(headroom * 100)}% quota left`,
        stat ? `${stat.completed}/${stat.runs} completed recently` : "no history",
      ];
      return [{ choice: { engine, score, reasons }, lastUsedAt: best.lastUsedAt }];
    })
    .sort((a, b) => b.choice.score - a.choice.score || a.lastUsedAt - b.lastUsedAt)
    .map((r) => r.choice);
}

// Linked, logged in and with at least one eligible account: what a new run could start on right now.
export async function readyRuntimes(db: Database, deps: RouteDeps = {}): Promise<Set<string>> {
  const agents = await (deps.agents ?? (() => listAgents(db)))();
  const quota = await probeQuota(db);
  const acctCtx = accountContext(db);
  return new Set(
    agents
      .filter((a) => a.enabled && a.loggedIn !== false)
      .filter(
        (a) => eligibleAccounts(db, { runtime: a.id, model: null }, quota, acctCtx).length > 0,
      )
      .map((a) => a.id),
  );
}

// For callers with no member to route for (hiring candidates): one engine per ready runtime, best first.
export async function rankEngines(
  db: Database,
  input: { orgId: string; difficulty: Difficulty; taskType: TaskType | null },
  deps: RouteDeps = {},
): Promise<Engine[]> {
  const agents = await (deps.agents ?? (() => listAgents(db)))();
  const allowed = effective(db, { orgId: input.orgId }, "router.allowedRuntimes").value;
  const quota = await probeQuota(db);
  const now = Date.now();
  const acctCtx = accountContext(db, undefined, now);
  const stats = learnedStats(db, now - LEARN_WINDOW_MS);
  return agents
    .filter((a) => a.enabled && a.loggedIn !== false)
    .filter((a) => allowed === null || allowed.includes(a.id))
    .flatMap((a) => {
      const best = pickBestAccount(
        eligibleAccounts(db, { runtime: a.id, model: null }, quota, acctCtx),
      );
      if (!best) return [];
      const engine: Engine = best.explicit
        ? { runtime: a.id, model: null, accountId: best.id }
        : { runtime: a.id, model: null };
      const score = scoreEngine({
        engine,
        primary: false,
        triage: { difficulty: input.difficulty },
        price: priceOf(db, engine),
        headroom: best.headroom,
        stat: statOf(stats, engine, input.taskType),
      });
      return [{ engine, score, lastUsedAt: best.lastUsedAt }];
    })
    .sort((a, b) => b.score - a.score || a.lastUsedAt - b.lastUsedAt)
    .map((r) => r.engine);
}
