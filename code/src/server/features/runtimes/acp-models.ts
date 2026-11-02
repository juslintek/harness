import type { AgentSpec } from "../agents/api";
import { Connection, rec, terminate, within } from "./acp-rpc";

const PROBE_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 5000;

type Model = { id: string; name: string };

// ACP select options carry the id in `value`; `name` is optional.
function parseModels(created: unknown): Model[] {
  const options = rec(created).configOptions;
  if (!Array.isArray(options)) return [];
  const model = options.map(rec).find((o) => o.id === "model" || o.configId === "model");
  if (!model || !Array.isArray(model.options)) return [];
  const models: Model[] = [];
  for (const item of model.options.map(rec)) {
    if (typeof item.value !== "string" || item.value === "") continue;
    models.push({ id: item.value, name: typeof item.name === "string" ? item.name : item.value });
  }
  return models;
}

// initialize + session/new only, no prompt, so asking for the list never spends tokens.
export async function listAcpModels(
  spec: AgentSpec,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<Model[]> {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const conn: Connection = new Connection(proc, (msg) => {
    if (msg.id !== undefined) conn.refuse(msg.id, String(msg.method));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no model list after ${PROBE_TIMEOUT_MS} ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
  const ask = async (): Promise<Model[]> => {
    await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "harness", version: "0" },
    });
    const params: Record<string, unknown> = { cwd, mcpServers: [] };
    if (spec.claudeMeta) {
      params._meta = { claudeCode: { options: { settingSources: [], settings: {}, env } } };
    }
    return parseModels(await conn.request("session/new", params));
  };
  try {
    return await Promise.race([ask(), expired]);
  } finally {
    clearTimeout(timer);
    await terminate(proc);
    await within(conn.closed, CLOSE_GRACE_MS);
  }
}
