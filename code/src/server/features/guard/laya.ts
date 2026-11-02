import { z } from "zod";

export type LayaQuestion =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type LayaAnswer =
  | { type: "noul"; noul: number }
  | { type: "score"; score?: number | undefined; probabilities: Record<string, number> }
  | { type: "choice"; choice: string; probabilities: Record<string, number> };

const answerSchema: z.ZodType<LayaAnswer> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("score"),
    score: z.number().optional(),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
  }),
]);

const bodySchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  routing: z.object({ model: z.string() }).optional(),
  state_truncated: z.boolean().optional(),
});

export type LayaResult =
  | { ok: true; answers: Record<string, LayaAnswer>; model: string }
  | {
      ok: false;
      reason: "timeout" | "down" | "http" | "truncated" | "bad_body" | "circuit_open";
    };

const FAILURES_TO_OPEN = 3;
const OPEN_MS = 30_000;
const HEALTH_TIMEOUT_MS = 1500;

let failures = 0;
let openUntil = 0;

export function resetLayaCircuit(): void {
  failures = 0;
  openUntil = 0;
}

function baseUrl(): string {
  return process.env.OLLAYA_URL ?? "http://127.0.0.1:11435";
}

function noteFailure(): void {
  failures++;
  if (failures >= FAILURES_TO_OPEN) openUntil = Date.now() + OPEN_MS;
}

type Failure = Extract<LayaResult, { ok: false }>;

// A truncated answer means the server is healthy but the input was too long,
// so it must not push the circuit towards open.
function failure(reason: Failure["reason"]): Failure {
  if (reason !== "truncated") noteFailure();
  return { ok: false, reason };
}

export async function decide(
  state: unknown,
  questions: Record<string, LayaQuestion>,
  timeoutMs: number,
): Promise<LayaResult> {
  if (Date.now() < openUntil) return { ok: false, reason: "circuit_open" };
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "laya", state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
      // A pooled socket to a restarted Ollaya fails the call and counts towards the circuit.
      keepalive: false,
    });
    if (!res.ok) return failure("http");
    const parsed = bodySchema.safeParse(await res.json());
    if (!parsed.success) return failure("bad_body");
    if (parsed.data.state_truncated) return failure("truncated");
    failures = 0;
    return {
      ok: true,
      answers: parsed.data.answers,
      model: parsed.data.routing?.model ?? parsed.data.model,
    };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return failure(timedOut ? "timeout" : e instanceof SyntaxError ? "bad_body" : "down");
  }
}

const versionSchema = z.object({ version: z.string() });

export async function layaHealth(): Promise<{ up: boolean; version: string | null }> {
  try {
    const res = await fetch(`${baseUrl()}/api/version`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const parsed = versionSchema.safeParse(await res.json());
    return { up: res.ok, version: parsed.success ? parsed.data.version : null };
  } catch {
    return { up: false, version: null };
  }
}
