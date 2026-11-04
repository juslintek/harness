import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { addAgentMember, createOrg } from "../orgs/api";
import { detectStack } from "./stack";
import { runTimes } from "./time";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const member = addAgentMember(db, org.id, {
    agentId: "a",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  });
  return { db, org, member };
}

function addRun(
  db: ReturnType<typeof setup>["db"],
  memberId: string,
  startedAt: number,
  endedAt: number | null,
): string {
  const id = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, started_at, ended_at, member_id)
     VALUES (?, 'a', '/r', 'p', 'completed', ?, ?, ?, ?)`,
  ).run(id, startedAt, startedAt, endedAt, memberId);
  return id;
}

function addApproval(
  db: ReturnType<typeof setup>["db"],
  runId: string,
  createdAt: number,
  decidedAt: number | null,
): void {
  db.query(
    `INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at, decided_at)
     VALUES (?, ?, 'x', 'ask', ?, ?, ?, ?)`,
  ).run(
    Bun.randomUUIDv7(),
    runId,
    decidedAt === null ? "pending" : "approved",
    createdAt,
    createdAt + 600_000,
    decidedAt,
  );
}

test("a run with one approval waiting 30 s and wall 90 s has waiting 30000 and active 60000", () => {
  const { db, org, member } = setup();
  const runId = addRun(db, member.id, 1_000_000, 1_090_000);
  addApproval(db, runId, 1_020_000, 1_050_000);
  const [row] = runTimes(db, { orgId: org.id, sinceMs: 0 });
  expect(row).toMatchObject({ runId, wallMs: 90_000, waitingMs: 30_000, activeMs: 60_000 });
});

test("a pending approval on a live run counts until now", () => {
  const { db, org, member } = setup();
  const runId = addRun(db, member.id, 1_000_000, null);
  addApproval(db, runId, 1_040_000, null);
  const [row] = runTimes(db, { orgId: org.id, sinceMs: 0 }, 1_100_000);
  expect(row).toMatchObject({ runId, wallMs: 100_000, waitingMs: 60_000, activeMs: 40_000 });
});

test("an approval left undecided on an ended run stops waiting at the run end", () => {
  const { db, org, member } = setup();
  const runId = addRun(db, member.id, 1_000_000, 1_090_000);
  addApproval(db, runId, 1_060_000, null);
  const rows = runTimes(db, { orgId: org.id, sinceMs: 0, memberId: member.id }, 9_000_000);
  expect(rows[0]).toMatchObject({ wallMs: 90_000, waitingMs: 30_000 });
});

test("detectStack on package.json with hono and preact gives node, hono, preact", () => {
  const manifest = JSON.stringify({ dependencies: { hono: "4", preact: "10", zod: "4" } });
  const files = ["src/a.ts", "package.json", "composer.json", "build.gradle.kts"];
  const stack = detectStack(files, (p) => (p === "package.json" ? manifest : null));
  expect(stack).toEqual(["node", "hono", "preact", "php", "jvm"]);
});
