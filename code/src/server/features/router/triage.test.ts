import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { createTask } from "../board/api";
import { resetLayaCircuit } from "../laya/api";
import { createOrg, createProject } from "../orgs/api";
import { triageOf } from "./api";
import { startTriage } from "./triage";

beforeEach(resetLayaCircuit);

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
});

async function waitFor<T>(read: () => T | null): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = read();
    if (v !== null) return v;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

test("creating a task stores one task_triage row", async () => {
  const down = await startStub(() => new Response("no", { status: 500 }));
  process.env.OLLAYA_URL = down.url;
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const project = createProject(db, { orgId: org.id, key: "pr", name: "p" });
  const stop = startTriage(db);
  const task = createTask(db, {
    projectId: project.id,
    title: "Fix crash in SQL migration",
    createdBy: "x",
  });
  const view = await waitFor(() => triageOf(db, task.id));
  stop();
  expect(view).toMatchObject({
    taskId: task.id,
    source: "fallback",
    taskType: "bugfix",
    specialty: "database",
  });
  const rows = db.query("SELECT COUNT(*) AS n FROM task_triage").get() as { n: number };
  expect(rows.n).toBe(1);
  expect(triageOf(db, "missing")).toBeNull();
});
