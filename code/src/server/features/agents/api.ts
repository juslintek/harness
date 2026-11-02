import type { Database } from "bun:sqlite";
import { bunRunner, type DiscoveredAgent, discoverAgents, type Runner } from "./discover";
import { getKey, type Provider } from "./keys";
import { type AgentSpec, agentSpecs } from "./specs";

export type { Provider } from "./keys";
export type { AgentSpec } from "./specs";

export function getApiKey(provider: Provider): Promise<string | null> {
  return getKey(provider);
}

export interface AgentView {
  id: string;
  name: string;
  lane: AgentSpec["lane"];
  installed: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  error: string | null;
  canLogin: boolean;
  enabled: boolean;
  models: Array<{ id: string; name: string }>;
}

const CACHE_MS = 60_000;
let cache: { at: number; agents: DiscoveredAgent[] } | null = null;

async function discovered(run?: Runner): Promise<DiscoveredAgent[]> {
  if (run) return discoverAgents(run);
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), agents: await discoverAgents() };
  }
  return cache.agents;
}

export function getSpec(id: string): AgentSpec | null {
  return agentSpecs.find((spec) => spec.id === id) ?? null;
}

export async function listAgents(db: Database, run?: Runner): Promise<AgentView[]> {
  const found = await discovered(run);
  const links = new Map(
    db
      .query<{ agent_id: string; enabled: number }, []>("SELECT agent_id, enabled FROM agent_links")
      .all()
      .map((row) => [row.agent_id, row.enabled === 1]),
  );
  const models = db
    .query<{ agent_id: string; model_id: string; name: string }, []>(
      "SELECT agent_id, model_id, name FROM agent_models ORDER BY name",
    )
    .all();
  return agentSpecs.map((spec) => {
    const info = found.find((agent) => agent.id === spec.id);
    return {
      id: spec.id,
      name: spec.name,
      lane: spec.lane,
      installed: info?.installed ?? false,
      path: info?.path ?? null,
      version: info?.version ?? null,
      loggedIn: info?.loggedIn ?? null,
      error: info?.error ?? null,
      canLogin: spec.loginArgs !== null,
      enabled: links.get(spec.id) ?? false,
      models: models
        .filter((model) => model.agent_id === spec.id)
        .map((model) => ({ id: model.model_id, name: model.name })),
    };
  });
}

export function setLinked(db: Database, id: string, enabled: boolean): void {
  db.run(
    `INSERT INTO agent_links (agent_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [id, enabled ? 1 : 0, Date.now()],
  );
}

export interface LoginProcess {
  kill: () => void;
  exited: Promise<unknown>;
}
type LoginSpawn = (argv: string[]) => LoginProcess;

export class LoginError extends Error {}

const LOGIN_TIMEOUT_MS = 600_000;
const logins = new Map<string, string[]>();

function spawnLogin(argv: string[]): LoginProcess {
  return Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

export function startLogin(
  id: string,
  spawn: LoginSpawn = spawnLogin,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): { command: string[] } {
  const command = getSpec(id)?.loginArgs;
  if (!command) throw new LoginError(`no login command for ${id}`);
  const running = logins.get(id);
  if (running) return { command: running };
  let proc: LoginProcess;
  try {
    proc = spawn(command);
  } catch {
    throw new LoginError(`${command[0]} could not be started, is it installed?`);
  }
  logins.set(id, command);
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const done = (): void => {
    clearTimeout(timer);
    logins.delete(id);
    cache = null;
  };
  proc.exited.then(done, done);
  return { command };
}

export function saveModels(
  db: Database,
  id: string,
  models: Array<{ id: string; name: string }>,
): void {
  const now = Date.now();
  db.transaction(() => {
    db.run("DELETE FROM agent_models WHERE agent_id = ?", [id]);
    for (const model of models) {
      db.run(
        "INSERT INTO agent_models (agent_id, model_id, name, fetched_at) VALUES (?, ?, ?, ?)",
        [id, model.id, model.name, now],
      );
    }
  })();
}

export async function ollayaStatus(): Promise<{ up: boolean; version: string | null }> {
  const base = process.env.OLLAYA_URL ?? "http://127.0.0.1:11435";
  try {
    const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return { up: false, version: null };
    const body = (await res.json()) as { version?: unknown };
    return { up: true, version: typeof body.version === "string" ? body.version : null };
  } catch {
    return { up: false, version: null };
  }
}

export type ModelList = Array<{ id: string; name: string }>;

export class ModelsError extends Error {
  readonly status: 404 | 409 | 502;
  constructor(status: 404 | 409 | 502, message: string) {
    super(message);
    this.name = "ModelsError";
    this.status = status;
  }
}

const AGY_MODELS_TIMEOUT_MS = 5000;

// `agy models` prints one model per line, id and display name separated by a tab.
function parseAgyModels(stdout: string): ModelList {
  const models: ModelList = [];
  for (const line of stdout.split("\n")) {
    const [id = "", name = ""] = line.split("\t").map((part) => part.trim());
    if (/^\S+$/.test(id)) models.push({ id, name: name || id });
  }
  return models;
}

type ModelSource = { listAcp: (spec: AgentSpec) => Promise<ModelList>; run?: Runner };

const refreshing = new Map<string, Promise<ModelList>>();

// A probe starts a sandboxed agent, so concurrent requests for one agent share a single probe.
export function refreshModels(db: Database, id: string, how: ModelSource): Promise<ModelList> {
  const running = refreshing.get(id);
  if (running) return running;
  const probe = probeModels(db, id, how).finally(() => refreshing.delete(id));
  refreshing.set(id, probe);
  return probe;
}

// The agent is the source of model ids; nothing is hard-coded and a failed probe keeps the old list.
async function probeModels(db: Database, id: string, how: ModelSource): Promise<ModelList> {
  const spec = getSpec(id);
  if (!spec) throw new ModelsError(404, "unknown agent");
  let models: ModelList;
  try {
    if (spec.lane === "agy") {
      const out = await (how.run ?? bunRunner)(["agy", "models"], AGY_MODELS_TIMEOUT_MS);
      if (out.code !== 0)
        throw new Error(out.stderr.trim() || `agy models exited with ${out.code}`);
      models = parseAgyModels(out.stdout);
    } else if (spec.lane === "acp") {
      models = await how.listAcp(spec);
    } else {
      throw new ModelsError(409, `${spec.name} has no model list to refresh`);
    }
  } catch (err) {
    if (err instanceof ModelsError) throw err;
    throw new ModelsError(502, err instanceof Error ? err.message : String(err));
  }
  if (models.length === 0) throw new ModelsError(502, "the agent returned no models");
  saveModels(db, id, models);
  return models;
}
