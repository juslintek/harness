import type { QuotaInput } from "./quota";

export type PipeProc = ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;

export type CodexProbeResult =
  | { status: "ok"; snapshots: QuotaInput[] }
  | { status: "logged_out"; reason?: string }
  | { status: "probe_failed"; error: string };

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null;

const rpcError = (msg: Rec, fallback: string): string | null =>
  msg.error === undefined
    ? null
    : typeof asRec(msg.error)?.message === "string"
      ? (asRec(msg.error)?.message as string)
      : fallback;

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    const parts = (buf + decoder.decode(chunk, { stream: true })).split("\n");
    buf = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.trim();
      if (line) yield line;
    }
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) yield tail;
}

async function readResponse(lines: AsyncIterator<string>, id: number): Promise<Rec | string> {
  while (true) {
    const next = await lines.next();
    if (next.done) return "unexpected eof";
    let parsed: unknown;
    try {
      parsed = JSON.parse(next.value);
    } catch {
      return "malformed json";
    }
    const msg = asRec(parsed);
    if (!msg) return "malformed json-rpc message";
    if (msg.id === id && typeof msg.method !== "string") return msg;
  }
}

function sendMsg(proc: PipeProc, msg: unknown): void {
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
  proc.stdin.flush();
}

function parseAccountReply(msg: Rec): CodexProbeResult | null {
  const err = rpcError(msg, "account/read failed");
  if (err !== null) {
    return /auth|login|unauth/i.test(err)
      ? { status: "logged_out", reason: err }
      : { status: "probe_failed", error: err };
  }
  const res = asRec(msg.result);
  if (!res) return { status: "probe_failed", error: "invalid account/read result" };
  if (res.account == null) return { status: "logged_out" };
  return asRec(res.account)
    ? null
    : { status: "probe_failed", error: "invalid account/read result" };
}

function parseRateLimitsReply(msg: Rec, accountId: string, now: number): CodexProbeResult {
  const err = rpcError(msg, "rateLimits/read failed");
  if (err !== null) return { status: "probe_failed", error: err };
  const res = asRec(msg.result);
  const limits = asRec(res?.rateLimits) ?? asRec(asRec(res?.rateLimitsByLimitId)?.codex);
  if (!limits) return { status: "probe_failed", error: "malformed rateLimits reply" };
  const snapshots: QuotaInput[] = [];
  for (const window of ["primary", "secondary"] as const) {
    const win = asRec(limits[window]);
    const pct = win?.usedPercent;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const raw = win?.resetsAt;
    const resetsAt =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.round(raw < 1e12 ? raw * 1000 : raw)
        : null;
    snapshots.push({
      provider: "codex",
      accountId,
      window,
      usedPercent: pct,
      resetsAt,
      source: "codex_probe",
      ts: now,
    });
  }
  return snapshots.length > 0
    ? { status: "ok", snapshots }
    : { status: "probe_failed", error: "malformed rateLimits reply" };
}

export async function runCodexProbeProtocol(
  proc: PipeProc,
  accountId: string,
  nowFn: () => number,
): Promise<CodexProbeResult> {
  const lines = readLines(proc.stdout);
  sendMsg(proc, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "harness", version: "0" }, capabilities: null },
  });
  const initRes = await readResponse(lines, 1);
  if (typeof initRes === "string") return { status: "probe_failed", error: initRes };
  const initErr = rpcError(initRes, "initialize failed");
  if (initErr !== null) return { status: "probe_failed", error: initErr };

  sendMsg(proc, { jsonrpc: "2.0", method: "initialized" });
  sendMsg(proc, { jsonrpc: "2.0", id: 2, method: "account/read", params: { refreshToken: false } });
  const acctRes = await readResponse(lines, 2);
  if (typeof acctRes === "string") return { status: "probe_failed", error: acctRes };
  const acctErr = parseAccountReply(acctRes);
  if (acctErr) return acctErr;

  sendMsg(proc, { jsonrpc: "2.0", id: 3, method: "account/rateLimits/read" });
  const limitsRes = await readResponse(lines, 3);
  return typeof limitsRes === "string"
    ? { status: "probe_failed", error: limitsRes }
    : parseRateLimitsReply(limitsRes, accountId, nowFn());
}
