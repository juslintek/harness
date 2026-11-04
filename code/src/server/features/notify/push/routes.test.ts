import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../../db/db";
import { migrations } from "../../../db/migrations";
import { withActor } from "../../../test-support/app-kit";
import { newReceiver } from "../../../test-support/push-stub";
import { listTargets } from "../api";
import { seedMember } from "../fake-notifier";
import { notifyRoutes } from "../routes";
import { vapidPublicKey } from "./vapid";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const home = mkdtempSync(join(tmpdir(), "pushroutes-"));
  const ada = seedMember(db, "ada");
  const app = withActor(notifyRoutes(db, home), { userId: ada.userId, instanceAdmin: false });
  return { db, home, ada, app };
}

const post = (app: ReturnType<typeof setup>["app"], body: unknown): Promise<Response> =>
  Promise.resolve(
    app.request("/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("GET /push/key returns the stored public key", async () => {
  const { app, home } = setup();
  const res = await app.request("/push/key");
  expect(await res.json()).toEqual({ key: vapidPublicKey(home) });
});

test("subscribe stores a push target for the caller and a resubscribe reuses it", async () => {
  const { app, db, ada } = setup();
  const rx = newReceiver();
  const body = { endpoint: "http://127.0.0.1:9/p", keys: { p256dh: rx.p256dh, auth: rx.auth } };
  const first = await post(app, body);
  expect(first.status).toBe(201);
  expect((await (await post(app, body)).json()) as { id: string }).toEqual(
    await first.clone().json(),
  );
  const targets = listTargets(db, ada.memberId);
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({ channel: "push", label: "127.0.0.1:9" });
});

test("subscribe rejects a plain http endpoint, a long one and bad keys", async () => {
  const { app } = setup();
  const rx = newReceiver();
  const keys = { p256dh: rx.p256dh, auth: rx.auth };
  expect((await post(app, { endpoint: "http://example.test/p", keys })).status).toBe(400);
  expect((await post(app, { endpoint: `https://x.test/${"a".repeat(2100)}`, keys })).status).toBe(
    400,
  );
  expect(
    (await post(app, { endpoint: "https://x.test/p", keys: { p256dh: "AA", auth: rx.auth } }))
      .status,
  ).toBe(400);
  expect((await post(app, { endpoint: "https://x.test/p" })).status).toBe(400);
});
