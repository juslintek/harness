import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { insertRun } from "./runs-repo";

const orgOf = (db: ReturnType<typeof openDb>, id: string) =>
  db.query<{ org_id: string | null }, [string]>("SELECT org_id FROM runs WHERE id = ?").get(id)
    ?.org_id;

test("insertRun stores the org of the member that starts the run", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  insertRun(db, {
    id: "r1",
    taskId: null,
    member: { memberId: "m", orgId: "A", scopes: [] },
    agentId: "claude",
    model: null,
    repo: "/r",
    prompt: "p",
  });
  expect(orgOf(db, "r1")).toBe("A");
});

test("the migration backfills the member's org, then the project's org only for removed members", () => {
  const db = openDb(":memory:");
  migrate(db, migrations.slice(0, 27));
  for (const o of ["A", "B"]) {
    db.run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, 1)", [o, o, o]);
  }
  db.run("INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('P', 'B', 'P', 'P', 1)");
  db.run(
    `INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at)
     VALUES ('mA', 'A', 'agent', 'claude', 'a', 'a', 'member', 1)`,
  );
  const run = (id: string, member: string | null, project: string | null) =>
    db.run(
      `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id, project_id)
       VALUES (?, 'claude', '/r', 'p', 'completed', 1, ?, ?)`,
      [id, member, project],
    );
  run("live", "mA", "P");
  run("gone", "mX", "P");
  run("unknown", "mX", null);
  migrate(db, migrations);
  expect([orgOf(db, "live"), orgOf(db, "gone"), orgOf(db, "unknown")]).toEqual(["A", "B", null]);
});
