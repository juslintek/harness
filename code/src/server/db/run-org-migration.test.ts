import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../features/logs/api";
import { searchOrgEvents } from "../features/logs/search-org";
import { migrate, openDb } from "./db";
import { migrations } from "./migrations";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-run-org-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a run whose member row is gone gets a NULL org and never reaches the project's owner org", () => {
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations.slice(0, 27));
  for (const org of ["A", "B"]) {
    db.run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, 1)", [org, org, org]);
  }
  db.run("INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('P', 'B', 'P', 'P', 1)");
  db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('hb', 'B', 'human', 'u2', 'hb', 'hb', 'owner', 1)`,
  );
  db.run(
    `INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at)
     VALUES ('mA', 'A', 'agent', 'claude', 'bot', 'bot', 'member', 1)`,
  );
  db.run(
    `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id, project_id)
     VALUES ('r', 'claude', '/r', 'p', 'completed', 1, 'mA', 'P')`,
  );
  db.run("DELETE FROM members WHERE id = 'mA'");
  migrate(db, migrations);
  expect(db.query("SELECT org_id FROM runs WHERE id = 'r'").get()).toEqual({ org_id: null });
  appendEvent(db, { kind: "message", body: "deploy alpha", ts: 10, runId: "r" });
  expect(searchOrgEvents(db, "B", { userId: "u2", text: "deploy" })).toEqual([]);
  db.close();
});
