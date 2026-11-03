import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createOrg } from "../orgs/api";
import { type ChatEvent, listMessages, onMessage, postSystemMessage, wireChat } from "./api";

test("a system message lands in the org channel with no author and reaches listeners", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(org.id);
  const seen: ChatEvent[] = [];
  const off = onMessage((e) => seen.push(e));
  const posted = postSystemMessage(db, org.id, "Budget org Acme at 80% of 10 USD");
  off();
  expect(posted.authorId).toBeNull();
  expect(posted.author).toBeNull();
  const channel = db
    .query<{ id: string }, [string]>("SELECT id FROM channels WHERE org_id = ? AND kind = 'org'")
    .get(org.id);
  expect(posted.channelId).toBe(channel?.id as string);
  expect(listMessages(db, posted.channelId, owner?.id as string, {}).map((m) => m.body)).toEqual([
    "Budget org Acme at 80% of 10 USD",
  ]);
  expect(seen).toHaveLength(1);
});
