import type { Database } from "bun:sqlite";
import { type Engine, REGISTRY_PROVIDER } from "../../shared/router";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

// A dated model id such as "claude-sonnet-4-5-20250929" prices like its registry entry, so the
// longest registry id that starts the model name wins.
export function priceOf(db: Database, engine: Engine): Price | null {
  const provider = REGISTRY_PROVIDER[engine.runtime];
  if (!provider || !engine.model) return null;
  const row = db
    .query<{ input: number; output: number; cache_read: number | null }, [string, string]>(
      `SELECT input_usd_mtok AS input, output_usd_mtok AS output, cache_read_usd_mtok AS cache_read
       FROM model_registry
       WHERE provider = ? AND substr(?, 1, length(model_id)) = model_id
       ORDER BY length(model_id) DESC LIMIT 1`,
    )
    .get(provider, engine.model);
  // Without a published cache price, charging the plain input price over-counts rather than hiding spend.
  return row && { input: row.input, output: row.output, cacheRead: row.cache_read ?? row.input };
}

export function estimateCostUsd(
  db: Database,
  runtime: string,
  model: string | null,
  tokens: { input: number; output: number; cacheRead: number },
): number | null {
  const price = priceOf(db, { runtime, model });
  if (!price) return null;
  const perMillion =
    tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead;
  return perMillion / 1_000_000;
}
