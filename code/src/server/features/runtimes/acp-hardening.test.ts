import { expect, test } from "bun:test";
import { getSpec } from "../agents/api";
import { drive, gone } from "./acp-kit";

test("codex input is stored without the cached part, cache writes from either key", async () => {
  const h = await drive(
    [
      {
        usage: {
          inputTokens: 36463,
          outputTokens: 38,
          cachedReadTokens: 36224,
          cachedWriteTokens: 5,
        },
      },
    ],
    { spec: getSpec("codex") },
  );
  expect(h.outcome.usage[0]).toMatchObject({
    inputTokens: 239,
    cacheReadTokens: 36224,
    cacheWriteTokens: 5,
  });
  const split = await drive(
    [
      {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          modelUsage: [
            {
              model: "gpt",
              token_count: { inputTokens: 10, cachedInputTokens: 30, cacheWriteInputTokens: 7 },
            },
          ],
        },
      },
    ],
    { spec: getSpec("codex") },
  );
  expect(split.outcome.usage[0]).toMatchObject({ inputTokens: 0, cacheWriteTokens: 7 });
});

test("claude input is already non-cached and stays as reported", async () => {
  const h = await drive([
    { usage: { inputTokens: 4, outputTokens: 78, cachedReadTokens: 9, cachedWriteTokens: 121442 } },
  ]);
  expect(h.outcome.usage[0]).toMatchObject({ inputTokens: 4, cacheReadTokens: 9 });
});

test("a decide that never answers is cut off, rejected and logged", async () => {
  const h = await drive([{ ask: { command: "ls" } }], { verdict: "hang", decideTimeoutMs: 100 });
  expect(h.outcome.text).toBe("permission selected reject");
  expect(h.events.find((e) => e.kind === "guard")?.body).toBe("decide timeout");
});

test("an emit that throws ends the run as error quickly and kills the child", async () => {
  const started = Date.now();
  const h = await drive([{ say: "x" }, { hang: true }], {
    throwOn: (e) => e.kind === "message",
  });
  expect(h.outcome.stopReason).toBe("error");
  expect(h.outcome.error).toContain("db busy");
  expect(Date.now() - started).toBeLessThan(4000);
  expect(gone(h.pid)).toBe(true);
});

test("a failing mode set aborts before session/prompt", async () => {
  const h = await drive([{ say: "never" }], { failConfig: true });
  expect(h.outcome.stopReason).toBe("error");
  expect(h.outcome.error).toContain("config refused");
  expect(h.requests.some((r) => r.method === "session/prompt")).toBe(false);
  expect(gone(h.pid)).toBe(true);
});

test("an agent without a permission mode runs but is flagged", async () => {
  const claude = getSpec("claude");
  if (!claude) throw new Error("spec missing");
  const h = await drive([], { spec: { ...claude, modeOption: null } });
  expect(h.outcome.stopReason).toBe("end_turn");
  expect(h.events.find((e) => e.kind === "guard")).toMatchObject({
    guardLayer: "L0",
    guardVerdict: "ask",
    guardRule: "no_permission_mode",
  });
  expect(h.requests.some((r) => r.method === "session/set_config_option")).toBe(false);
});
