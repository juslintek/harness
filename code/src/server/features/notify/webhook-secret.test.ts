import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { withActor } from "../../test-support/app-kit";
import { seedMember } from "../../test-support/bridge-kit";
import { secretNames, setSecret } from "../agents/api";
import { removeMember } from "../orgs/api";
import { addTarget, listTargets, notifyRoutes, startNotify } from "./api";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "harness-webhook-secret-"));
  const db = openDb(":memory:");
  migrate(db, migrations);
  const ada = seedMember(db, "ada");
  const id = addTarget(db, ada.memberId, "webhook", {
    url: "https://h.test/in",
    secretName: "webhook.w1",
  });
  setSecret("webhook.w1", "signing-secret-1234", home);
  return { home, db, ada, id };
}

test("deleting a webhook target over http removes its secret", async () => {
  const { home, db, ada, id } = setup();
  const app = withActor(notifyRoutes(db, home), { userId: ada.userId, instanceAdmin: false });
  expect((await app.request(`/targets/${id}`, { method: "DELETE" })).status).toBe(200);
  expect(listTargets(db, ada.memberId)).toEqual([]);
  expect(secretNames(home)).toEqual([]);
});

test("removing a member removes the secrets of the webhook targets that cascade away", async () => {
  const { home, db, ada } = setup();
  setSecret("smtp.password", "keep-me", home);
  const stop = startNotify(db, { home, origin: "https://h.test" });
  removeMember(db, ada.memberId);
  await stop();
  expect(secretNames(home)).toEqual(["smtp.password"]);
});
