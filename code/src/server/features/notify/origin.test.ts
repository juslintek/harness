import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { seedMember } from "../../test-support/bridge-kit";
import { addTarget } from "./api";
import { createDispatcher } from "./dispatcher";
import { fakeNotifier } from "./fake-notifier";

test("notification links use the current tunnel origin on each delivery", async () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const { memberId } = seedMember(db, "ada");
  addTarget(db, memberId, "push", { endpoint: "https://push.test/1", p256dh: "k", auth: "a" });
  const push = fakeNotifier("push");
  let origin = "http://localhost:4100";
  const dispatcher = createDispatcher(db, {
    home: "/unused",
    origin: () => origin,
    adapters: { push },
  });
  try {
    for (const hostname of ["first.trycloudflare.com", "second.trycloudflare.com"]) {
      origin = `https://${hostname}`;
      dispatcher.notify([memberId], {
        kind: "mention",
        orgId: "o1",
        title: "ping",
        body: "hello",
        path: "/#/x",
        tag: hostname,
      });
      await dispatcher.idle();
    }
    expect(push.calls.map((call) => call.base)).toEqual([
      "https://first.trycloudflare.com",
      "https://second.trycloudflare.com",
    ]);
  } finally {
    await dispatcher.stop();
    db.close();
  }
});
