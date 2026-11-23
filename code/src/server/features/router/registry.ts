import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Engine } from "../../../shared/router";
import {
  estimateCostUsd as estimateModelCostUsd,
  type Price,
  priceOf as registryPriceOf,
} from "../../db/pricing";

export type { Price };

export interface RegistryRow {
  provider: string;
  modelId: string;
  name: string;
  inputUsdMtok: number;
  outputUsdMtok: number;
  cacheReadUsdMtok: number | null;
  contextWindow: number | null;
  toolCall: boolean;
  reasoning: boolean;
  fetchedAt: number;
}

const MODELS_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30_000;
const STALE_MS = 24 * 60 * 60 * 1000;

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  cost: z.object({ input: z.number(), output: z.number(), cache_read: z.number().optional() }),
  limit: z.object({ context: z.number().optional() }).optional(),
  tool_call: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});

const providersSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), z.unknown()) }),
);

async function fetchModelsDev(): Promise<unknown> {
  const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
  return res.json();
}

// The feed has thousands of models and some lack prices; one odd entry must not drop the rest.
function parseModels(raw: unknown): { provider: string; model: z.infer<typeof modelSchema> }[] {
  const providers = providersSchema.parse(raw);
  const out: { provider: string; model: z.infer<typeof modelSchema> }[] = [];
  for (const [provider, entry] of Object.entries(providers)) {
    for (const candidate of Object.values(entry.models)) {
      const model = modelSchema.safeParse(candidate);
      if (model.success) out.push({ provider, model: model.data });
    }
  }
  return out;
}

export async function refreshRegistry(
  db: Database,
  fetchJson: () => Promise<unknown> = fetchModelsDev,
): Promise<{ ok: boolean; models: number }> {
  try {
    const models = parseModels(await fetchJson());
    if (models.length === 0) throw new Error("no priced models in the feed");
    const now = Date.now();
    const insert = db.query(
      `INSERT OR REPLACE INTO model_registry (provider, model_id, name, input_usd_mtok, output_usd_mtok,
         cache_read_usd_mtok, context_window, tool_call, reasoning, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.query("DELETE FROM model_registry").run();
      for (const { provider, model: m } of models) {
        insert.run(
          provider,
          m.id,
          m.name,
          m.cost.input,
          m.cost.output,
          m.cost.cache_read ?? null,
          m.limit?.context ?? null,
          m.tool_call ? 1 : 0,
          m.reasoning ? 1 : 0,
          now,
        );
      }
    })();
    return { ok: true, models: models.length };
  } catch (err) {
    console.error("model registry refresh failed", err instanceof Error ? err.message : err);
    return { ok: false, models: 0 };
  }
}

export function registryStale(db: Database, now: number): boolean {
  const row = db.query("SELECT MAX(fetched_at) AS at FROM model_registry").get() as {
    at: number | null;
  };
  return row.at === null || now - row.at > STALE_MS;
}

export function listRegistry(db: Database, provider?: string): RegistryRow[] {
  const rows = db
    .query(
      `SELECT * FROM model_registry WHERE (?1 IS NULL OR provider = ?1) ORDER BY provider, model_id`,
    )
    .all(provider ?? null) as Record<string, string | number | null>[];
  return rows.map((r) => ({
    provider: r.provider as string,
    modelId: r.model_id as string,
    name: r.name as string,
    inputUsdMtok: r.input_usd_mtok as number,
    outputUsdMtok: r.output_usd_mtok as number,
    cacheReadUsdMtok: r.cache_read_usd_mtok as number | null,
    contextWindow: r.context_window as number | null,
    toolCall: r.tool_call === 1,
    reasoning: r.reasoning === 1,
    fetchedAt: r.fetched_at as number,
  }));
}

export function priceOf(db: Database, engine: Engine): Price | null {
  return registryPriceOf(db, engine);
}

export function estimateCostUsd(
  db: Database,
  runtime: string,
  model: string | null,
  tokens: { input: number; output: number; cacheRead: number },
): number | null {
  return estimateModelCostUsd(db, runtime, model, tokens);
}
