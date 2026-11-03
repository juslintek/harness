import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createUser } from "../auth/api";
import { addAgentMember, createOrg, getMember, type MemberRow } from "../orgs/api";
import { attachProfile, createProfile } from "../profiles/api";
import { runMember } from "./run-input";

function agentWith(readOnly: boolean | null): { read: () => boolean | undefined } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const ownerUserId = createUser(db, { email: "u@x.io", name: "U", instanceAdmin: false });
  const org = createOrg(db, {
    name: "A",
    slug: "acme",
    ownerUserId,
    ownerName: "U",
    ownerHandle: "owner1",
  });
  const bot = addAgentMember(db, org.id, {
    agentId: "claude",
    handle: "bot",
    displayName: "Bot",
    specialties: [],
  });
  if (readOnly !== null) {
    const profile = createProfile(db, org.id, {
      runtime: "claude",
      model: null,
      persona: "",
      skills: [],
      scope: { readOnly },
      fallbacks: [],
    });
    attachProfile(db, bot.id, profile.id);
  }
  return { read: () => runMember(db, getMember(db, bot.id) as MemberRow, null).readOnly };
}

test("a run is read-only when the member's profile says so", () => {
  expect(agentWith(true).read()).toBe(true);
});

test("a member whose profile allows writes, or who has no profile, stays writable", () => {
  expect(agentWith(false).read()).toBeUndefined();
  expect(agentWith(null).read()).toBeUndefined();
});
