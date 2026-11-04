import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { seedMember } from "../../test-support/bridge-kit";
import { createProject } from "../orgs/api";
import { runOrgId } from "./recipients";

test("a run's org comes from the stamped org, then the project, then the member", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const a = seedMember(db, "alice");
  const b = seedMember(db, "bob");
  const project = createProject(db, { orgId: b.orgId, key: "web", name: "Web" });
  const insert = (id: string, org: string | null, member: string | null, proj: string | null) =>
    db.run(
      "INSERT INTO runs (id, org_id, member_id, project_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, ?, ?, 'a', '/r', 'p', 'running', 1)",
      [id, org, member, proj],
    );
  insert("stamped", a.orgId, a.memberId, project.id);
  insert("project", null, a.memberId, project.id);
  insert("member", null, a.memberId, null);
  insert("orphan", null, null, null);
  expect(runOrgId(db, "stamped")).toBe(a.orgId);
  expect(runOrgId(db, "project")).toBe(b.orgId);
  expect(runOrgId(db, "member")).toBe(a.orgId);
  expect(runOrgId(db, "orphan")).toBeNull();
  expect(runOrgId(db, "missing")).toBeNull();
});
