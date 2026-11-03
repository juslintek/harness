import { afterEach, beforeEach, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { triageTask } from "./api";
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

beforeEach(resetLayaCircuit);

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
});

test("fallback triage: a crash in a SQL migration is a small database bugfix", async () => {
  const down = await startStub(() => new Response("no", { status: 500 }));
  process.env.OLLAYA_URL = down.url;
  expect(await triageTask("Fix crash in SQL migration")).toEqual({
    source: "fallback",
    difficulty: "medium",
    taskType: "bugfix",
    specialty: "database",
    size: "s",
    p: {},
  });
});

test("fallback size follows the text length", async () => {
  const down = await startStub(() => new Response("no", { status: 500 }));
  process.env.OLLAYA_URL = down.url;
  expect((await triageTask("x".repeat(300))).size).toBe("m");
  resetLayaCircuit();
  expect((await triageTask("x".repeat(900))).size).toBe("l");
});

test("confident laya answers are used and their probabilities kept", async () => {
  await stub({
    difficulty: { choice: "hard", probabilities: { hard: 0.8 } },
    taskType: { choice: "research", probabilities: { research: 0.7 } },
    specialty: { choice: "security", probabilities: { security: 0.9 } },
    size: { choice: "xl", probabilities: { xl: 0.6 } },
  });
  expect(await triageTask("Look into token handling")).toEqual({
    source: "laya",
    difficulty: "hard",
    taskType: "research",
    specialty: "security",
    size: "xl",
    p: { difficulty: 0.8, taskType: 0.7, specialty: 0.9, size: 0.6 },
  });
});

test("a laya answer below 0.5 for specialty falls back to the keyword specialty", async () => {
  await stub({
    difficulty: { choice: "easy", probabilities: { easy: 0.9 } },
    taskType: { choice: "feature", probabilities: { feature: 0.9 } },
    specialty: { choice: "frontend", probabilities: { frontend: 0.4, database: 0.35 } },
    size: { choice: "xs", probabilities: { xs: 0.9 } },
  });
  const res = await triageTask("Add an index on events");
  expect(res).toMatchObject({ source: "laya", difficulty: "easy", specialty: "database" });
  expect(res.p.specialty).toBeUndefined();
});

test("a sure unknown specialty stays null instead of using keywords", async () => {
  await stub({
    difficulty: { choice: "easy", probabilities: { easy: 0.9 } },
    taskType: { choice: "feature", probabilities: { feature: 0.9 } },
    specialty: { choice: "unknown", probabilities: { unknown: 0.8 } },
    size: { choice: "s", probabilities: { s: 0.9 } },
  });
  expect((await triageTask("Add an index on events")).specialty).toBeNull();
});
