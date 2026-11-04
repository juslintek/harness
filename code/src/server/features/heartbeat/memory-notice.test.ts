import { expect, test } from "bun:test";
import { agentViewer, createNote, projectSlugs, resolveNotePath } from "../memory/api";
import { addAgentMember, createOrg, createProject } from "../orgs/api";
import { setup } from "./kit";
import { memoryNotice } from "./memory-notice";

async function put(
  k: ReturnType<typeof setup>,
  handle: string,
  vpath: string,
  body: string,
): Promise<void> {
  const member = k.db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM members WHERE org_id = ? AND handle = ?",
    )
    .get(k.orgId, handle) as { id: string };
  const viewer = agentViewer(k.db, member.id);
  const loc = resolveNotePath(vpath, viewer, projectSlugs(k.db, k.orgId));
  if (loc === null || loc === "dir") throw new Error("bad path");
  await createNote(k.db, k.home, { viewer, runId: null }, loc, body);
}

test("with MCP the notice names matching notes by path and title, never the body", async () => {
  const k = setup();
  const bob = k.agent("bob");
  await put(
    k,
    "bob",
    "/memories/project/web/deploy.md",
    "# Deploy checklist\nbody-text-xyz migrate first",
  );
  const text = memoryNotice(k.db, bob, "please deploy the staging app", true);
  expect(text).toContain("the `memory` tool");
  expect(text).toContain("Notes that may apply:");
  expect(text).toContain("/memories/project/web/deploy.md");
  expect(text).toContain("Deploy checklist");
  expect(text).not.toContain("body-text-xyz");
});

test("with MCP and no match the tool line is still there, without hints", () => {
  const k = setup();
  const text = memoryNotice(k.db, k.agent("bob"), "deploy", true);
  expect(text).toContain("the `memory` tool");
  expect(text).not.toContain("Notes that may apply");
});

test("without MCP the notice points at the file, and is empty when there are no notes", async () => {
  const k = setup();
  const bob = k.agent("bob");
  expect(memoryNotice(k.db, bob, "deploy", false)).toBe("");
  await put(k, "bob", "/memories/org/rules.md", "# Rules\nbe kind");
  expect(memoryNotice(k.db, bob, "deploy", false)).toContain("$HARNESS_MEMORY_FILE");
});

test("without MCP the file line is left out when no MEMORY.md was written", async () => {
  const k = setup();
  const bob = k.agent("bob");
  await put(k, "bob", "/memories/org/rules.md", "# Rules\nbe kind");
  expect(memoryNotice(k.db, bob, "deploy", false, null, false)).toBe("");
});

test("a note of another org is not listed", async () => {
  const k = setup();
  const bob = k.agent("bob");
  const other = createOrg(k.db, {
    name: "Other",
    slug: "other",
    ownerUserId: "u2",
    ownerName: "O",
    ownerHandle: "owner2",
  });
  createProject(k.db, { orgId: other.id, key: "web", name: "Web" });
  const eve = addAgentMember(k.db, other.id, {
    agentId: "fake",
    handle: "eve",
    displayName: "eve",
    specialties: [],
  });
  const viewer = agentViewer(k.db, eve.id);
  const loc = resolveNotePath("/memories/org/deploy.md", viewer, projectSlugs(k.db, other.id));
  if (loc === null || loc === "dir") throw new Error("bad path");
  await createNote(k.db, k.home, { viewer, runId: null }, loc, "# Deploy other org\nsecret");
  expect(memoryNotice(k.db, bob, "deploy", true)).not.toContain("other org");
  expect(memoryNotice(k.db, bob, "deploy", false)).toBe("");
});

// Written through the memory api as the given member, whose org decides where the slug resolves.
async function lesson(
  k: ReturnType<typeof setup>,
  memberId: string,
  orgId: string,
  name: string,
  title: string,
): Promise<void> {
  const viewer = agentViewer(k.db, memberId);
  const loc = resolveNotePath(
    `/memories/project/web/${name}.md`,
    viewer,
    projectSlugs(k.db, orgId),
  );
  if (loc === null || loc === "dir") throw new Error("bad path");
  await createNote(k.db, k.home, { viewer, runId: null }, loc, `# ${title}\nbody-text-xyz`, {
    type: "lesson",
  });
  await Bun.sleep(3);
}

test("project lessons are listed with a first-step sentence even when they share no word with the task", async () => {
  const k = setup();
  const bob = k.agent("bob");
  await lesson(k, bob.id, k.orgId, "owner-line", "Owner header line");
  const text = memoryNotice(k.db, bob, "Add a clamp helper", true, k.projectId);
  expect(text).toContain("Your first step, before `task_checkout`, is to read each one");
  expect(text).toContain("- /memories/project/web/owner-line.md — Owner header line");
  expect(text).not.toContain("body-text-xyz");
  expect(text).not.toContain("Notes that may apply");
  expect(memoryNotice(k.db, bob, "Add a clamp helper", true)).not.toContain("Lessons for");
});

test("at most 5 lessons, newest first, and a lesson is not repeated among the hints", async () => {
  const k = setup();
  const bob = k.agent("bob");
  for (let i = 1; i <= 7; i++) await lesson(k, bob.id, k.orgId, `l${i}`, `Rule number ${i}`);
  const text = memoryNotice(k.db, bob, "Add a clamp helper", true, k.projectId);
  const paths = [...text.matchAll(/^- \/memories\/project\/web\/l\d/gm)].map((m) => m[0]);
  expect(paths).toEqual(["l7", "l6", "l5", "l4", "l3"].map((n) => `- /memories/project/web/${n}`));
  expect(text).not.toContain("Notes that may apply");
});

test("a lesson of another org's project with the same slug is not listed", async () => {
  const k = setup();
  const other = createOrg(k.db, {
    name: "Other",
    slug: "other",
    ownerUserId: "u2",
    ownerName: "O",
    ownerHandle: "owner2",
  });
  const theirs = createProject(k.db, { orgId: other.id, key: "web", name: "Web" });
  const eve = addAgentMember(k.db, other.id, {
    agentId: "fake",
    handle: "eve",
    displayName: "eve",
    specialties: [],
  });
  await lesson(k, eve.id, other.id, "x", "Their rule");
  const bob = k.agent("bob");
  expect(memoryNotice(k.db, bob, "Their rule", true, k.projectId)).not.toContain("Their rule");
  expect(memoryNotice(k.db, bob, "x", true, theirs.id)).not.toContain("Their rule");
});

test("an org lesson is listed for a task in any project of the org, another org's is not", async () => {
  const k = setup();
  const bob = k.agent("bob");
  const viewer = agentViewer(k.db, bob.id);
  const put = async (orgId: string, v: typeof viewer, title: string): Promise<void> => {
    const loc = resolveNotePath("/memories/org/owner.md", v, projectSlugs(k.db, orgId));
    if (loc === null || loc === "dir") throw new Error("bad path");
    await createNote(k.db, k.home, { viewer: v, runId: null }, loc, `# ${title}\nbody`, {
      type: "lesson",
    });
  };
  await put(k.orgId, viewer, "Org owner line");
  const second = createProject(k.db, { orgId: k.orgId, key: "api", name: "Api" });
  const text = memoryNotice(k.db, bob, "unrelated", true, second.id);
  expect(text).toContain("Lessons for this project and org.");
  expect(text).toContain("- /memories/org/owner.md — Org owner line");
  const other = createOrg(k.db, {
    name: "Other",
    slug: "other",
    ownerUserId: "u2",
    ownerName: "O",
    ownerHandle: "owner2",
  });
  const eve = addAgentMember(k.db, other.id, {
    agentId: "fake",
    handle: "eve",
    displayName: "eve",
    specialties: [],
  });
  await put(other.id, agentViewer(k.db, eve.id), "Their org line");
  expect(memoryNotice(k.db, bob, "Their org line", true, k.projectId)).not.toContain("Their org");
});

test("hints drop project notes of other projects but keep the current project's and the org's", async () => {
  const k = setup();
  const bob = k.agent("bob");
  const api = createProject(k.db, { orgId: k.orgId, key: "api", name: "Api" });
  await put(k, "bob", "/memories/project/web/clamp.md", "# Clamp web\nclamp helper");
  await put(k, "bob", "/memories/project/api/clamp.md", "# Clamp api\nclamp helper");
  await put(k, "bob", "/memories/org/clamp.md", "# Clamp org\nclamp helper");
  const text = memoryNotice(k.db, bob, "clamp helper", true, k.projectId);
  expect(text).toContain("/memories/project/web/clamp.md");
  expect(text).toContain("/memories/org/clamp.md");
  expect(text).not.toContain(`/memories/project/${api.key}/clamp.md`);
});
