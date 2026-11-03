import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { addHumanMember, createOrg, createProject, grantProject } from "../orgs/api";
import { ensureProjectChannel, listChannels, postMessage, wireChat } from "./api";

function world() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const make = (slug: string, userId: string, handle: string): string => {
    const org = createOrg(db, {
      name: slug,
      slug,
      ownerUserId: userId,
      ownerName: handle,
      ownerHandle: handle,
    });
    const row = db
      .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
      .get(org.id);
    return row?.id as string;
  };
  const owner = make("acme", "u1", "owner");
  const guest = make("other", "u2", "zed");
  const orgs = db.query<{ id: string }, [string]>("SELECT id FROM orgs WHERE slug = ?");
  const [acme, other] = [orgs.get("acme")?.id as string, orgs.get("other")?.id as string];
  const repo = mkdtempSync(join(tmpdir(), "mentions-repo-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  const project = createProject(db, { orgId: acme, key: "web", name: "Web", repo });
  ensureProjectChannel(db, project.id);
  grantProject(db, project.id, other, "write", owner);
  const channel = listChannels(db, owner).find((c) => c.kind === "project");
  return { db, acme, other, owner, guest, channelId: channel?.id as string };
}

test("a grantee-org member with access is mentioned in a project channel", () => {
  const w = world();
  const sent = postMessage(w.db, { channelId: w.channelId, authorId: w.owner, body: "hi @zed" });
  expect(sent.mentions).toEqual([w.guest]);
});

test("a handle shared by two members who can open the channel stores no mention", () => {
  const w = world();
  addHumanMember(w.db, w.acme, "u3", "zed", "Zed Two", "member");
  const sent = postMessage(w.db, { channelId: w.channelId, authorId: w.owner, body: "hi @zed" });
  expect(sent.mentions).toEqual([]);
});
