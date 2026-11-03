import { afterEach, beforeEach, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { type Specialty, triageWake } from "./api";
import { resetLayaCircuit } from "./client";

const TEXT = "Please add an index on the events table";

async function stub(
  choice: string,
  probabilities: Record<string, number>,
  chitchat = 0.05,
): Promise<{ n: number }> {
  const started = await startStub(() =>
    Response.json({
      model: "laya:en",
      answers: {
        specialty: { type: "choice", choice, probabilities },
        chitchat: { type: "noul", noul: chitchat },
      },
    }),
  );
  process.env.OLLAYA_URL = started.url;
  return started.calls;
}

beforeEach(resetLayaCircuit);

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
});

test("a confident label becomes the specialty", async () => {
  await stub("database", { database: 0.97, backend: 0.02 });
  expect(await triageWake(TEXT)).toEqual({
    source: "laya",
    chitchat: 0.05,
    specialty: "database",
    p: 0.97,
  });
});

test("a split label stays below the threshold", async () => {
  await stub("backend", { backend: 0.43, devops: 0.37 });
  const res = await triageWake(TEXT);
  expect(res.specialty).toBeNull();
  expect(res.p).toBe(0.43);
});

test("chit-chat clears the specialty even when frontend is confident", async () => {
  await stub("frontend", { frontend: 0.9 }, 0.93);
  expect(await triageWake(TEXT)).toMatchObject({ chitchat: 0.93, specialty: null });
});

test("unknown never becomes a specialty", async () => {
  await stub("unknown", { unknown: 0.61 });
  const specialty: Specialty | null = (await triageWake(TEXT)).specialty;
  expect(specialty).toBeNull();
});

test("a down server falls back with nulls", async () => {
  process.env.OLLAYA_URL = "http://127.0.0.1:1";
  expect(await triageWake(TEXT)).toEqual({
    source: "fallback",
    chitchat: null,
    specialty: null,
    p: null,
  });
});

test("short text is skipped without a request", async () => {
  const calls = await stub("database", { database: 0.97 });
  expect(await triageWake("ok thx")).toMatchObject({ source: "skipped", specialty: null });
  expect(calls.n).toBe(0);
});
