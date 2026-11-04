import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  addAgentMember,
  addHumanMember,
  createOrg,
  createProject,
  grantProject,
} from "../orgs/api";
import { agentViewer, humanViewer, projectSlugs, runProject } from "./viewer";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = (slug: string) =>
    createOrg(db, {
      name: slug,
      slug,
      ownerUserId: `u-${slug}`,
      ownerName: slug,
      ownerHandle: slug,
    });
  const a = org("acme");
  const b = org("beta");
  const own = createProject(db, { orgId: a.id, key: "web", name: "Web" });
  const other = createProject(db, { orgId: b.id, key: "web", name: "Web B" });
  const agent = addAgentMember(db, a.id, {
    agentId: "x",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  return { db, a, b, own, other, agent };
}

test("an agent viewer covers only its own org's projects, even when another org's is granted to it", () => {
  const { db, a, b, own, other, agent } = setup();
  grantProject(db, other.id, a.id, "write", agent.id);
  const v = agentViewer(db, agent.id);
  expect(v).toMatchObject({ orgId: a.id, memberId: agent.id, actor: "dev", canWriteGlobal: false });
  expect(v.projectIds).toEqual([own.id]);
  const slugs = projectSlugs(db, a.id);
  expect(slugs.idOf("web")).toBe(own.id);
  expect(slugs.slugOf(own.id)).toBe("web");
  expect(projectSlugs(db, b.id).idOf("web")).toBe(other.id);
});

test("agentViewer refuses a human member and a missing one", () => {
  const { db, a } = setup();
  const human = addHumanMember(db, a.id, "u2", "pat", "Pat", "member");
  expect(() => agentViewer(db, human.id)).toThrow();
  expect(() => agentViewer(db, "nope")).toThrow();
});

test("a human viewer has no member scope and writes global only as instance admin", () => {
  const { db, a, own } = setup();
  const plain = humanViewer(db, a.id, "u-acme", false);
  expect(plain).toMatchObject({
    orgId: a.id,
    memberId: null,
    canWriteGlobal: false,
    projectIds: [own.id],
  });
  expect(humanViewer(db, a.id, "u-acme", true).canWriteGlobal).toBe(true);
  expect(() => humanViewer(db, a.id, "stranger", false)).toThrow();
});

test("runProject is null for an unknown run", () => {
  expect(runProject(setup().db, "none")).toBeNull();
});
