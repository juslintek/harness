import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { haltBody, type RunDetail, type RunView, startRunBody } from "../../../shared/runs";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { listRunEvents, readBody } from "../logs/api";
import { usageSummary } from "../usage/api";
import {
  getRun,
  HaltedError,
  isHalted,
  killRun,
  listRuns,
  type RunDeps,
  type RunRow,
  setHalted,
  startRun,
  UnknownAgent,
} from "./api";

const BODY_CAP = 8000;
const afterQuery = z.coerce.number().int().min(0).default(0);

type Tokens = { input: number; output: number };

function runView(row: RunRow, tokens: Tokens): RunView {
  return {
    id: row.id,
    memberId: row.memberId,
    agentId: row.agentId,
    model: row.model,
    repo: row.repo,
    branch: row.branch,
    prompt: row.prompt,
    state: row.state,
    reason: row.reason,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };
}

function tokensFor(db: Database, runId: string): Tokens {
  const hit = usageSummary(db, "run", 0).find((u) => u.key === runId);
  return { input: hit?.inputTokens ?? 0, output: hit?.outputTokens ?? 0 };
}

export function viewRun(db: Database, row: RunRow): RunView {
  return runView(row, tokensFor(db, row.id));
}

function detail(db: Database, row: RunRow, after: number): RunDetail {
  const events = listRunEvents(db, row.id, after).map((e) => ({
    rowid: e.rowid,
    ts: e.ts,
    kind: e.kind,
    toolName: e.toolName,
    command: e.command,
    exitCode: e.exitCode,
    guardLayer: e.guardLayer,
    guardVerdict: e.guardVerdict,
    guardRule: e.guardRule,
    body: readBody(db, e.rowid)?.slice(0, BODY_CAP) ?? null,
  }));
  return { run: viewRun(db, row), events };
}

export function runRoutes(db: Database, deps: RunDeps): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const totals = new Map(usageSummary(db, "run", 0).map((u) => [u.key, u]));
    return c.json(
      listRuns(db).map((row) =>
        runView(row, {
          input: totals.get(row.id)?.inputTokens ?? 0,
          output: totals.get(row.id)?.outputTokens ?? 0,
        }),
      ),
    );
  });
  app.post("/", async (c) => {
    const body = startRunBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { model, ...rest } = body.data;
    try {
      const id = await startRun(db, deps, { ...rest, ...(model === undefined ? {} : { model }) });
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof HaltedError) return c.json({ error: "harness is halted" }, 409);
      if (err instanceof UnknownAgent) return c.json({ error: "unknown agent" }, 404);
      throw err;
    }
  });
  app.get("/:id", (c) => {
    const after = afterQuery.safeParse(c.req.query("after"));
    if (!after.success) return c.json({ error: "invalid after" }, 400);
    const row = getRun(db, c.req.param("id"));
    if (!row) return c.json({ error: "unknown run" }, 404);
    return c.json(detail(db, row, after.data));
  });
  app.post("/:id/kill", (c) =>
    killRun(db, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "no live run" }, 404),
  );
  return app;
}

export function haltRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/", (c) => c.json({ halted: isHalted(db) }));
  app.post("/", requireStepUp, async (c) => {
    const body = haltBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    setHalted(db, body.data.halted);
    return c.json({ halted: body.data.halted });
  });
  return app;
}
