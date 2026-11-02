import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { resetLayaCircuit } from "../laya/api";
import type { L1Result } from "./l1";
import { ASK_DESTRUCTIVE, DENY_EXFILTRATION, escalateL2 } from "./l2";

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
const input = (
  category: L1Result["category"],
  command = "bun test src/webhook.test.ts",
): [{ request: string; command: string }, L1Result] => [
  { request: "Add retry logic", command },
  { ...allow, category },
];

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
    const res = await escalateL2(...input("shell"));
    expect(res.verdict).toBe("deny");
    expect(res.source).toBe("laya");
    expect(res.probs?.exfiltration).toBe(0.95);
  });

  test("exact boundaries: exfiltration denies from 0.9, destructive asks from 0.95", async () => {
    await stub({ exfiltration: DENY_EXFILTRATION - 0.01 });
    expect((await escalateL2(...input("shell"))).verdict).toBe("allow");
    await stub({ exfiltration: DENY_EXFILTRATION });
    expect((await escalateL2(...input("shell"))).verdict).toBe("deny");
    await stub({ destructive: ASK_DESTRUCTIVE - 0.01 });
    expect((await escalateL2(...input("delete"))).verdict).toBe("allow");
    await stub({ destructive: ASK_DESTRUCTIVE });
    expect((await escalateL2(...input("delete"))).verdict).toBe("ask");
  });

  test("destructive 1.0 with out_of_scope 1.0 only asks", async () => {
    await stub({ destructive: 1, out_of_scope: 1 });
    expect((await escalateL2(...input("delete"))).verdict).toBe("ask");
  });

  test("out_of_scope and risk alone never escalate", async () => {
    await stub({ out_of_scope: 1 }, { score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } });
    expect((await escalateL2(...input("shell"))).verdict).toBe("allow");
  });

  test("live ordinary commands stay allowed (ls -la, sed -n, git add)", async () => {
    await stub(
      { destructive: 0.94, exfiltration: 0.88, out_of_scope: 0.84 },
      { score: 0.99, probabilities: { "0": 0, "1": 1 } },
    );
    expect((await escalateL2(...input("shell"))).verdict).toBe("allow");
  });

  test("a score field wins over probabilities in the logged risk", async () => {
    await stub({}, { score: 1.7, probabilities: { "0": 1, "1": 0, "2": 0 } });
    expect((await escalateL2(...input("shell"))).probs?.risk).toBe(1.7);
    await stub({}, { probabilities: { "0": 0, "1": 0.4, "2": 0.6 } });
    expect((await escalateL2(...input("shell"))).probs?.risk).toBeCloseTo(1.6);
  });

  test("all low allows with source laya", async () => {
    await stub({});
    const res = await escalateL2(...input("shell"));
    expect(res).toMatchObject({ verdict: "allow", source: "laya" });
    expect(res.probs).not.toBeNull();
  });
});

describe("escalateL2 failure path", () => {
  test("timeout: shell asks, read allows, source fallback", async () => {
    await stub({}, undefined, { sleepMs: 2000 });
    const shell = await escalateL2(...input("shell"));
    expect(shell).toMatchObject({ verdict: "ask", source: "fallback", probs: null });
    resetLayaCircuit();
    const read = await escalateL2(...input("read"));
    expect(read).toMatchObject({ verdict: "allow", source: "fallback" });
  });

  test("server down asks for network", async () => {
    process.env.OLLAYA_URL = "http://127.0.0.1:1";
    const res = await escalateL2(...input("network"));
    expect(res).toMatchObject({ verdict: "ask", source: "fallback" });
  });

  test("state_truncated falls back", async () => {
    await stub({}, undefined, { state_truncated: true });
    expect(await escalateL2(...input("git_push"))).toMatchObject({
      verdict: "ask",
      source: "fallback",
    });
    expect(await escalateL2(...input("edit"))).toMatchObject({
      verdict: "allow",
      source: "fallback",
    });
  });

  test("a response without the asked answers falls back", async () => {
    await serve(() => Response.json({ model: "laya:en", answers: {} }));
    expect(await escalateL2(...input("secret"))).toMatchObject({
      verdict: "ask",
      source: "fallback",
    });
  });

  test("3 failures open the circuit, the 4th call does not fetch", async () => {
    await serve(() => new Response("boom", { status: 500 }));
    for (let i = 0; i < 3; i++) await escalateL2(...input("shell"));
    expect(hits.n).toBe(3);
    const res = await escalateL2(...input("shell"));
    expect(hits.n).toBe(3);
    expect(res).toMatchObject({ verdict: "ask", source: "fallback" });
  });
});

describe("escalateL2 malformed and short input", () => {
  test("a non-numeric probability key without score falls back", async () => {
    await stub({}, { probabilities: { low: 0.5, high: 0.5 } });
    expect(await escalateL2(...input("shell"))).toMatchObject({
      verdict: "ask",
      source: "fallback",
      probs: null,
    });
  });

  test("a whitespace-only command skips Laya and keeps the L1 verdict", async () => {
    await stub({});
    const res = await escalateL2(...input("shell", `${" ".repeat(20)}`));
    expect(hits.n).toBe(0);
    expect(res).toMatchObject({ verdict: "allow", source: "l1" });
  });

  test("a command under 15 chars skips Laya", async () => {
    await stub({ exfiltration: 0.99 });
    for (const command of ["bun test", "make", "cat a.ts"]) {
      const res = await escalateL2(...input("shell", command));
      expect(res).toMatchObject({
        verdict: "allow",
        reason: "too short for laya",
        source: "l1",
      });
    }
    expect(hits.n).toBe(0);
    const ask: L1Result = {
      verdict: "ask",
      rule: "r1",
      reason: "needs a human",
      category: "shell",
    };
    expect((await escalateL2(input("shell", "git push")[0], ask)).verdict).toBe("ask");
  });
});

describe("escalateL2 with a non-allow L1", () => {
  test("ask is returned unchanged without a call", async () => {
    await stub({ exfiltration: 0.99 });
    const l1: L1Result = { verdict: "ask", rule: "r1", reason: "needs a human", category: "shell" };
    const res = await escalateL2(input("shell")[0], l1);
    expect(hits.n).toBe(0);
    expect(res).toMatchObject({
      verdict: "ask",
      reason: "needs a human",
      source: "l1",
      probs: null,
    });
  });

  test("deny is returned as deny without a call", async () => {
    await stub({});
    const l1: L1Result = { verdict: "deny", rule: "r2", reason: "forbidden", category: "delete" };
    expect((await escalateL2(input("delete")[0], l1)).verdict).toBe("deny");
    expect(hits.n).toBe(0);
  });
});
