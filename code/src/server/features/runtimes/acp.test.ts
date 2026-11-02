import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSpec } from "../agents/api";
import { dir, drive, gone, messages } from "./acp-kit";

test("say and usage end the turn with one usage record", async () => {
  const h = await drive(
    [
      { say: "hel" },
      { say: "lo" },
      { usage: { inputTokens: 4, outputTokens: 7, cachedReadTokens: 2, costUsd: 0.5 } },
    ],
    { model: "m-1" },
  );
  expect(h.outcome.stopReason).toBe("end_turn");
  expect(h.outcome.text).toBe("hello");
  expect(h.outcome.sessionId).toBe("fake-session");
  expect(h.outcome.usage).toEqual([
    {
      model: "m-1",
      inputTokens: 4,
      outputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: 0.5,
      source: "acp",
    },
  ]);
  expect(messages(h)).toEqual(["hello"]);
  expect(gone(h.pid)).toBe(true);
});

test("model_usage replaces the total, one record per model", async () => {
  const tc = (input: number): Record<string, number> => ({
    inputTokens: input,
    cachedInputTokens: 1,
    cachedWriteTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 4,
  });
  const h = await drive([
    {
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.2,
        modelUsage: [
          { model: "sonnet", token_count: tc(10) },
          { model: "haiku", token_count: tc(20) },
        ],
      },
    },
  ]);
  expect(h.outcome.usage.map((u) => [u.model, u.inputTokens, u.reportedCostUsd])).toEqual([
    ["sonnet", 10, 0.2],
    ["haiku", 20, null],
  ]);
  expect(h.outcome.usage[0]).toMatchObject({
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    outputTokens: 3,
    reasoningTokens: 4,
  });
});

test("a turn without usage yields no records and null cost is never 0", async () => {
  const h = await drive([{ say: "x" }]);
  expect(h.outcome.usage).toEqual([]);
});

test("deny picks the reject option and the command is never run", async () => {
  const h = await drive([{ ask: { command: "rm -rf ~", kind: "execute" } }], {
    verdict: "deny",
  });
  expect(h.asks).toEqual([{ kind: "execute", command: "rm -rf ~", paths: [], title: "rm -rf ~" }]);
  expect(h.outcome.text).toBe("permission selected reject");
  expect(h.events.some((e) => e.kind === "permission" && e.command === "rm -rf ~")).toBe(true);
});

test("allow picks allow_once even when allow_always is offered", async () => {
  const h = await drive([{ ask: { command: "ls", options: "codex" } }], { verdict: "allow" });
  expect(h.outcome.text).toBe("permission selected allow_once");
});

test("codex deny selects the cancel option by kind", async () => {
  const h = await drive([{ ask: { command: "ls", options: "codex" } }], { verdict: "deny" });
  expect(h.outcome.text).toBe("permission selected cancel");
});

test("allow_always alone is answered with reject and logged as an error", async () => {
  const h = await drive([{ ask: { command: "ls", options: "always-only" } }], {
    verdict: "allow",
  });
  expect(h.outcome.text).toBe("permission selected cancel");
  expect(h.events.find((e) => e.kind === "error")?.body).toContain("allow_always only");
});

test("a failing decide is a deny", async () => {
  const h = await drive([{ ask: { command: "ls" } }], { verdict: "throw" });
  expect(h.outcome.text).toBe("permission selected reject");
});

test("crash ends with the stderr tail", async () => {
  const h = await drive([{ crash: true }]);
  expect(h.outcome.stopReason).toBe("error");
  expect(h.outcome.error).toContain("fake agent crashing");
  expect(gone(h.pid)).toBe(true);
});

test("hang times out and the process is gone", async () => {
  const h = await drive([{ hang: true }], { idleTimeoutMs: 200 });
  expect(h.outcome.stopReason).toBe("timeout");
  expect(gone(h.pid)).toBe(true);
});

test("abort cancels the turn", async () => {
  const h = await drive([{ say: "working" }, { hang: true }], {
    abortWhen: (e) => e.kind === "message",
  });
  expect(h.outcome.stopReason).toBe("cancelled");
  expect(gone(h.pid)).toBe(true);
});

test("session setup: claude meta, mode, model and mcp", async () => {
  const h = await drive([], {
    model: "opus",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  });
  const byMethod = (m: string): Array<Record<string, unknown>> =>
    h.requests.filter((r) => r.method === m).map((r) => r.params);
  const [init] = byMethod("initialize");
  expect(init?.clientCapabilities).toEqual({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  const [created] = byMethod("session/new");
  expect(created).toMatchObject({
    cwd: dir,
    mcpServers: [
      {
        type: "http",
        name: "harness",
        url: "http://127.0.0.1:1/mcp",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ],
    _meta: {
      claudeCode: {
        options: { settingSources: [], settings: { hooks: {} }, env: { PATH: process.env.PATH } },
      },
    },
  });
  expect(byMethod("session/set_config_option")).toEqual([
    { sessionId: "fake-session", configId: "mode", value: "default" },
    { sessionId: "fake-session", configId: "model", value: "opus" },
  ]);
});

test("non-claude spec sends no claude meta", async () => {
  const h = await drive([], { spec: getSpec("codex") });
  const created = h.requests.find((r) => r.method === "session/new");
  expect(created?.params).not.toHaveProperty("_meta");
  expect(h.requests.find((r) => r.method === "session/set_config_option")?.params).toMatchObject({
    configId: "mode",
    value: "workspace-write",
  });
});

test("claude rate-limit windows reach onQuota as percent and epoch ms", async () => {
  const h = await drive([
    {
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        rateLimit: { fiveHour: 0.08, sevenDay: 0.5, resetsAt: 1793605200 },
      },
    },
  ]);
  expect(h.quotas).toEqual([
    { provider: "claude", window: "five_hour", usedPercent: 8, resetsAt: 1793605200000 },
    { provider: "claude", window: "seven_day", usedPercent: 50, resetsAt: 1793605200000 },
  ]);
});

test("direct file steps run unwrapped against temp paths", async () => {
  const target = join(dir, "written.txt");
  const h = await drive([
    { readFile: join(dir, "missing", "nope") },
    { writeFile: target },
    { readFile: target },
  ]);
  expect(messages(h)).toEqual(["readFile error ENOENTwriteFile okreadFile ok"]);
  expect(existsSync(target)).toBe(true);
});
