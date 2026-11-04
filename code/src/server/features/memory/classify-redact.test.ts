import { afterEach, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { resetLayaCircuit } from "../laya/api";
import { proposeLessons } from "./lessons";
import { close, type World, world } from "./lessons-test-kit";
import { BASE, boot, useHome } from "./routes-test-kit";

useHome();

const AKIA = "AKIAIOSFODNN7EXAMPLE";
const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

// A recording Laya: whatever the classifier sends is kept so a test can look for a secret in it.
async function recordingLaya(): Promise<string[]> {
  const bodies: string[] = [];
  const started = await startStub(async (req) => {
    bodies.push(await req.text());
    return Response.json({ model: "laya:en", answers: {} });
  });
  process.env.OLLAYA_URL = started.url;
  resetLayaCircuit();
  return bodies;
}

afterEach(stopStubs);

test("a UI create without a type never sends the secret to Laya", async () => {
  const k = await boot();
  const sent = await recordingLaya();
  const res = await k.call(k.alice, "POST", `${BASE}/notes`, {
    scope: "org",
    rel: "keys.md",
    body: `# Keys\nuse ${AKIA} and ${GHP} for the deploy`,
  });
  expect(res.status).toBe(201);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.join("")).not.toContain(AKIA);
  expect(sent.join("")).not.toContain(GHP);
});

test("a lesson proposal never sends the secret to Laya", async () => {
  const w: World = world();
  try {
    const sent = await recordingLaya();
    const dev = w.agent("dev");
    await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: w.doneTask(dev).id }, [
      `Deploy needs ${AKIA} and ${GHP} exported before running the script`,
    ]);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join("")).not.toContain(AKIA);
    expect(sent.join("")).not.toContain(GHP);
  } finally {
    await close(w);
  }
});
