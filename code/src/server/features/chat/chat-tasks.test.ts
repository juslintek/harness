import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import { addHumanMember, createOrg, createProject, grantProject } from "../orgs/api";
import { ensureProjectChannel, listChannels, listMessages, postMessage } from "./api";

function world() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = (slug: string, user: string) =>
    createOrg(db, { name: slug, slug, ownerUserId: user, ownerName: slug, ownerHandle: slug });
  const acme = org("acme", "u1");
  const guest = org("guest", "u2");
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(acme.id)?.id as string;
  const guestOwner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(guest.id)?.id as string;
  const shared = createProject(db, { orgId: acme.id, key: "web", name: "Web" });
  const hidden = createProject(db, { orgId: acme.id, key: "sec", name: "Sec" });
  ensureProjectChannel(db, shared.id);
  grantProject(db, shared.id, guest.id, "write", owner);
  const task = (projectId: string, title: string) =>
    createTask(db, { projectId, title, createdBy: owner });
  const sharedTask = task(shared.id, "visible");
  const hiddenTask = task(hidden.id, "secret");
  return { db, acme, owner, guestOwner, shared, sharedTask, hiddenTask };
}

test("a project channel links #n only to tasks of its own project", () => {
  const w = world();
  const channel = listChannels(w.db, w.owner).find((c) => c.projectId === w.shared.id);
  const m = postMessage(w.db, {
    channelId: channel?.id as string,
    authorId: w.guestOwner,
    body: `see #${w.sharedTask.number} and #${w.hiddenTask.number}`,
  });
  expect(m.taskIds).toEqual([w.sharedTask.id]);
});

test("an org channel link to an unshared project is hidden from a grantee reader", () => {
  const w = world();
  const general = listChannels(w.db, w.owner).find((c) => c.kind === "org");
  const m = postMessage(w.db, {
    channelId: general?.id as string,
    authorId: w.owner,
    body: `#${w.sharedTask.number} #${w.hiddenTask.number}`,
  });
  expect(m.taskIds.sort()).toEqual([w.sharedTask.id, w.hiddenTask.id].sort());
  const asGuest = listMessages(w.db, m.channelId, w.guestOwner, {}).at(-1);
  expect(asGuest?.taskIds).toEqual([w.sharedTask.id]);
  expect(asGuest?.tasks.map((t) => t.number)).toEqual([w.sharedTask.number]);
  expect(JSON.stringify(asGuest)).not.toContain(w.hiddenTask.id);
  const reader = addHumanMember(w.db, w.acme.id, "u9", "pat", "Pat", "member");
  expect(listMessages(w.db, m.channelId, reader.id, {}).at(-1)?.taskIds).toHaveLength(2);
});
