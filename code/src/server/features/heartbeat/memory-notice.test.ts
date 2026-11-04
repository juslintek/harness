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
