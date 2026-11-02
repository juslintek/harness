import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import type { L1Result } from "./l1";
import { escalateL2 } from "./l2";
import { resetLayaCircuit } from "./laya";

let hits = { n: 0 };

interface Noul {
  destructive?: number;
  exfiltration?: number;
  out_of_scope?: number;
}

function answers(noul: Noul, risk: Record<string, unknown>): Record<string, unknown> {
  return {
    destructive: { type: "noul", noul: noul.destructive ?? 0.1 },
    exfiltration: { type: "noul", noul: noul.exfiltration ?? 0.1 },
    out_of_scope: { type: "noul", noul: noul.out_of_scope ?? 0.1 },
    risk: { type: "score", ...risk },
  };
}

async function serve(handler: () => Response | Promise<Response>): Promise<void> {
  const started = await startStub(handler);
  hits = started.calls;
  process.env.OLLAYA_URL = started.url;
}

async function stub(
  noul: Noul,
  risk: Record<string, unknown> = { probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 } },
  extra: { state_truncated?: boolean; sleepMs?: number } = {},
): Promise<void> {
  await await serve(async () => {
    if (extra.sleepMs) await Bun.sleep(extra.sleepMs);
    return Response.json({
      model: "laya:en",
      state_truncated: extra.state_truncated ?? false,
      answers: answers(noul, risk),
    });
  });
}

const allow: L1Result = { verdict: "allow", rule: null, reason: "ok", category: "shell" };
const input = (category: L1Result["category"], command = "bun test src/webhook.test.ts") => ({
  request: "Add retry logic",
  command,
  category,
});

beforeEach(() => {
  hits = { n: 0 };
  resetLayaCircuit();
});

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
});

describe("escalateL2 policy", () => {
  test("exfiltration 0.95 denies", async () => {
    await stub({ exfiltration: 0.95 });
    const res = await escalateL2(input("shell"), allow);
    expect(res.verdict).toBe("deny");
    expect(res.source).toBe("laya");
    expect(res.probs?.exfiltration).toBe(0.95);
  });

  test("destructive 0.9 with out_of_scope 0.5 denies", async () => {
    await stub({ destructive: 0.9, out_of_scope: 0.5 });
    expect((await escalateL2(input("delete"), allow)).verdict).toBe("deny");
  });

  test("destructive 0.9 alone only asks", async () => {
    await stub({ destructive: 0.9 });
    expect((await escalateL2(input("delete"), allow)).verdict).toBe("ask");
  });

  test("destructive 0.6 asks", async () => {
    await stub({ destructive: 0.6 });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("ask");
  });

  test("risk expected level 1.6 from probabilities asks", async () => {
    await stub({}, { probabilities: { "0": 0, "1": 0.4, "2": 0.6 } });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("ask");
  });

  test("a score field wins over probabilities", async () => {
    await stub({}, { score: 1.7, probabilities: { "0": 1, "1": 0, "2": 0 } });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("ask");
    await stub({}, { score: 0.2, probabilities: { "0": 0, "1": 0, "2": 1 } });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("allow");
  });

  test("exact boundaries: exfiltration 0.9 denies, any noul 0.5 asks", async () => {
    await stub({ exfiltration: 0.9 });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("deny");
    await stub({ exfiltration: 0.5 });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("ask");
    await stub({ out_of_scope: 0.5 });
    expect((await escalateL2(input("shell"), allow)).verdict).toBe("ask");
  });

  test("all low allows with source laya", async () => {
    await stub({});
    const res = await escalateL2(input("shell"), allow);
    expect(res).toMatchObject({ verdict: "allow", source: "laya" });
    expect(res.probs).not.toBeNull();
  });
});

describe("escalateL2 failure path", () => {
  test("timeout: shell asks, read allows, source fallback", async () => {
    await stub({}, undefined, { sleepMs: 2000 });
    const shell = await escalateL2(input("shell"), allow);
    expect(shell).toMatchObject({ verdict: "ask", source: "fallback", probs: null });
    resetLayaCircuit();
    const read = await escalateL2(input("read"), { ...allow, category: "read" });
    expect(read).toMatchObject({ verdict: "allow", source: "fallback" });
  });

  test("server down asks for network", async () => {
    process.env.OLLAYA_URL = "http://127.0.0.1:1";
    const res = await escalateL2(input("network"), { ...allow, category: "network" });
    expect(res).toMatchObject({ verdict: "ask", source: "fallback" });
  });

  test("state_truncated falls back", async () => {
    await stub({}, undefined, { state_truncated: true });
    expect(await escalateL2(input("git_push"), allow)).toMatchObject({
      verdict: "ask",
      source: "fallback",
    });
    expect(await escalateL2(input("edit"), allow)).toMatchObject({
      verdict: "allow",
      source: "fallback",
    });
  });

  test("a response without the asked answers falls back", async () => {
    await serve(() => Response.json({ model: "laya:en", answers: {} }));
    expect(await escalateL2(input("secret"), allow)).toMatchObject({
      verdict: "ask",
      source: "fallback",
    });
  });

  test("3 failures open the circuit, the 4th call does not fetch", async () => {
    await serve(() => new Response("boom", { status: 500 }));
    for (let i = 0; i < 3; i++) await escalateL2(input("shell"), allow);
    expect(hits.n).toBe(3);
    const res = await escalateL2(input("shell"), allow);
    expect(hits.n).toBe(3);
    expect(res).toMatchObject({ verdict: "ask", source: "fallback" });
  });
});

describe("escalateL2 malformed and short input", () => {
  test("a non-numeric probability key without score falls back", async () => {
    await stub({}, { probabilities: { low: 0.5, high: 0.5 } });
    expect(await escalateL2(input("shell"), allow)).toMatchObject({
      verdict: "ask",
      source: "fallback",
      probs: null,
    });
  });

  test("a whitespace-only command skips Laya", async () => {
    await stub({});
    const res = await escalateL2(input("shell", `${" ".repeat(20)}`), allow);
    expect(hits.n).toBe(0);
    expect(res).toMatchObject({ verdict: "ask", source: "fallback" });
  });

  test("a command under 15 chars skips Laya", async () => {
    await stub({ exfiltration: 0.99 });
    const res = await escalateL2(input("shell", "ls -la"), allow);
    expect(hits.n).toBe(0);
    expect(res).toMatchObject({ verdict: "ask", source: "fallback" });
    expect((await escalateL2(input("read", "cat a.ts"), allow)).verdict).toBe("allow");
  });
});

describe("escalateL2 with a non-allow L1", () => {
  test("ask is returned unchanged without a call", async () => {
    await stub({ exfiltration: 0.99 });
    const l1: L1Result = { verdict: "ask", rule: "r1", reason: "needs a human", category: "shell" };
    const res = await escalateL2(input("shell"), l1);
    expect(hits.n).toBe(0);
    expect(res).toMatchObject({ verdict: "ask", reason: "needs a human", probs: null });
  });

  test("deny is returned as deny without a call", async () => {
    await stub({});
    const l1: L1Result = { verdict: "deny", rule: "r2", reason: "forbidden", category: "delete" };
    expect((await escalateL2(input("delete"), l1)).verdict).toBe("deny");
    expect(hits.n).toBe(0);
  });
});
