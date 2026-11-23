import type { Database } from "bun:sqlite";
import type { Difficulty, Engine, RouteCandidateDecision, TaskType } from "../../../shared/router";
import { type AgentView, listAgents } from "../agents/api";
import { contextForMember, effective } from "../policies/api";
import { ensureProfile } from "../profiles/api";
import { probeQuota } from "../usage/api";
import {
  type AccountCandidate,
  accountContext,
  eligibleAccounts,
  evaluateAccounts,
  pickBestAccount,
  poolExhaustedRetryAt,
} from "./accounts";
import { recordRouteDecision } from "./decisions";
import { priceOf } from "./registry";
import { scoreEngine, tierOf } from "./score";
import { learnedStats, type StatRow } from "./stats";
import { triageOf } from "./triage";

export interface RouteChoice {
  engine: Engine;
  score: number;
  reasons: string[];
}

export interface RouteOutcome {
  choices: RouteChoice[];
  poolExhausted: { retryAt: number } | null;
  decisionId: string | null;
}

export interface RouteInput {
  memberId: string;
  taskId?: string | null | undefined;
  exclude?: Engine[] | undefined;
  // Keeps only the runtimes the caller can use for this run, e.g. those able to call MCP tools.
  runtimeFilter?: ((runtime: string) => boolean) | undefined;
  // Read-only preview endpoints pass false so polling never floods route_decisions.
  record?: boolean | undefined;
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

function buildChoice(
  db: Database,
  e: Engine,
  best: AccountCandidate,
  ctx: {
    primary: Engine;
    triage: ReturnType<typeof triageOf>;
    stats: StatRow[];
  },
): { choice: RouteChoice; lastUsedAt: number } {
  const engine: Engine = best.explicit
    ? { runtime: e.runtime, model: e.model, accountId: best.id }
    : { runtime: e.runtime, model: e.model };
  const price = priceOf(db, engine);
  const headroom = best.headroom;
  const stat = statOf(ctx.stats, engine, ctx.triage?.taskType ?? null);
  const isPrimary = sameEngine(e, ctx.primary);
  const score = scoreEngine({
    engine,
    primary: isPrimary,
    triage: ctx.triage,
    price,
    headroom,
    stat,
  });
  const reasons = [
    ...(isPrimary ? ["profile primary"] : []),
    `tier ${tierOf(price)}${price ? "" : " (no price)"} for ${ctx.triage?.difficulty ?? "unknown"} difficulty`,
    headroom === null ? "no quota data" : `${Math.round(headroom * 100)}% quota left`,
    stat ? `${stat.completed}/${stat.runs} completed recently` : "no history",
  ];
  return { choice: { engine, score, reasons }, lastUsedAt: best.lastUsedAt };
}

function evaluateEngines(
  db: Database,
  engines: Engine[],
  quota: Awaited<ReturnType<typeof probeQuota>>,
  acctCtx: ReturnType<typeof accountContext>,
  accountPolicy: ReturnType<typeof effective<"router.accountPolicy">>["value"],
  scoreCtx: { primary: Engine; triage: ReturnType<typeof triageOf>; stats: StatRow[] },
): { choices: RouteChoice[]; logged: RouteCandidateDecision[] } {
  const logged: RouteCandidateDecision[] = [];
  const ranked: Array<{ choice: RouteChoice; lastUsedAt: number }> = [];
  for (const e of engines) {
    const { eligible, rejected } = evaluateAccounts(db, e, quota, acctCtx);
    for (const r of rejected) {
      logged.push({
        account: r.id,
        runtime: e.runtime,
        model: e.model,
        score: null,
        rejectedBy: r.rejectedBy,
      });
    }
    const best = pickBestAccount(eligible, accountPolicy);
    if (!best) continue;
    const built = buildChoice(db, e, best, scoreCtx);
    ranked.push(built);
    for (const c of eligible) {
      logged.push({
        account: c.id,
        runtime: e.runtime,
        model: e.model,
        score: c.id === best.id ? built.choice.score : buildChoice(db, e, c, scoreCtx).choice.score,
        rejectedBy: null,
      });
    }
  }
  const choices = ranked
    .sort((a, b) => b.choice.score - a.choice.score || a.lastUsedAt - b.lastUsedAt)
    .map((r) => r.choice);
  return { choices, logged };
}

// A window reset in the past already reads as null usage, so 100% here means exhausted now.
export async function routeOutcome(
  db: Database,
  input: RouteInput,
  deps: RouteDeps = {},
): Promise<RouteOutcome> {
  const profile = ensureProfile(db, input.memberId);
  const ctx = contextForMember(db, input.memberId, input.taskId ?? undefined);
  const allowed = effective(db, ctx, "router.allowedRuntimes").value;
  const accountPolicy = effective(db, ctx, "router.accountPolicy").value;
  const agents = await (deps.agents ?? (() => listAgents(db)))();
  const usable = agents.filter((a) => a.enabled && a.loggedIn !== false);
  const quota = await probeQuota(db);
  const now = Date.now();
  const scoreCtx = {
    primary: { runtime: profile.runtime, model: profile.model },
    triage: input.taskId ? triageOf(db, input.taskId) : null,
    stats: learnedStats(db, now - LEARN_WINDOW_MS),
  };
  const engines = candidateEngines(profile, usable)
    .filter((e) => usable.some((a) => a.id === e.runtime))
    .filter((e) => allowed === null || allowed.includes(e.runtime))
    .filter((e) => input.runtimeFilter?.(e.runtime) ?? true);

  const { choices, logged } = evaluateEngines(
    db,
    engines,
    quota,
    accountContext(db, input.exclude, now),
    accountPolicy,
    scoreCtx,
  );
  const chosenAccount = choices[0]
    ? (choices[0].engine.accountId ?? `default:${choices[0].engine.runtime}`)
    : null;
  const decisionId =
    input.record === false
      ? null
      : recordRouteDecision(db, {
          ts: now,
          policy: accountPolicy,
          chosenAccount,
          candidates: logged,
        });

  if (choices.length > 0) return { choices, poolExhausted: null, decisionId };
  const retryAt = poolExhaustedRetryAt(db, engines, quota, now);
  return { choices, poolExhausted: retryAt === null ? null : { retryAt }, decisionId };
}

export async function route(
  db: Database,
  input: RouteInput,
  deps: RouteDeps = {},
): Promise<RouteChoice[]> {
  return (await routeOutcome(db, input, deps)).choices;
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
  const accountPolicy = effective(db, { orgId: input.orgId }, "router.accountPolicy").value;
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
        accountPolicy,
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
