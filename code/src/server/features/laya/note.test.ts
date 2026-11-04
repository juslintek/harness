import { afterEach, beforeEach, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { classifyNote } from "./api";
import { resetLayaCircuit } from "./client";

type Choice = { choice: string; probabilities: Record<string, number> };

async function stub(answers: Record<string, Choice>): Promise<void> {
  const started = await startStub(() =>
    Response.json({
      model: "laya:en",
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, v]) => [k, { type: "choice", ...v }]),
      ),
    }),
  );
  process.env.OLLAYA_URL = started.url;
}

async function layaDown(): Promise<void> {
  const down = await startStub(() => new Response("no", { status: 500 }));
  process.env.OLLAYA_URL = down.url;
}

beforeEach(resetLayaCircuit);

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
});

test("confident laya answers are used and confidence is the type probability", async () => {
  await stub({
    type: { choice: "howto", probabilities: { howto: 0.8 } },
    scope: { choice: "project", probabilities: { project: 0.7 } },
  });
  expect(await classifyNote("anything", ["org", "project"])).toEqual({
    type: "howto",
    scope: "project",
    confidence: 0.8,
    source: "laya",
  });
});

test("low probability falls back per field", async () => {
  await stub({
    type: { choice: "reference", probabilities: { reference: 0.4 } },
    scope: { choice: "project", probabilities: { project: 0.4 } },
  });
  expect(await classifyNote("We decided to use sqlite", ["agent", "project"])).toEqual({
    type: "decision",
    scope: "project",
    confidence: 0.5,
    source: "laya",
  });
});

test("a scope outside allowed falls back to the first allowed", async () => {
  await stub({
    type: { choice: "fact", probabilities: { fact: 0.9 } },
    scope: { choice: "org", probabilities: { org: 0.9 } },
  });
  const res = await classifyNote("x", ["project", "agent"]);
  expect(res.scope).toBe("project");
  expect(res.confidence).toBe(0.9);
});

test("laya down uses the keyword fallback", async () => {
  await layaDown();
  expect(await classifyNote("Always run bun test before pushing", ["project"])).toEqual({
    type: "howto",
    scope: "project",
    confidence: 0.5,
    source: "fallback",
  });
  expect((await classifyNote("We decided to use sqlite", ["org"])).type).toBe("decision");
  expect((await classifyNote("See the docs", ["org"])).type).toBe("reference");
});

test("fallback type is the hint, else fact", async () => {
  await layaDown();
  const text = "Lesson: the API rejects empty bodies";
  expect((await classifyNote(text, ["org"], "lesson")).type).toBe("lesson");
  expect((await classifyNote(text, ["org"])).type).toBe("fact");
});
