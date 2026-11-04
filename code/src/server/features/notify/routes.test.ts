import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Hono } from "hono";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { withActor } from "../../test-support/app-kit";
import { seedMember } from "../../test-support/bridge-kit";
import type { AuthEnv } from "../auth/api";
import { addTarget, listTargets, notifyRoutes, removeTarget } from "./api";

const HOME = "/nonexistent-home";

function setup(): {
  db: Database;
  ada: ReturnType<typeof seedMember>;
  bob: ReturnType<typeof seedMember>;
  asAda: Hono<AuthEnv>;
  asBob: Hono<AuthEnv>;
} {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const ada = seedMember(db, "ada");
  const bob = seedMember(db, "bob");
  return {
    db,
    ada,
    bob,
    asAda: withActor(notifyRoutes(db, HOME), { userId: ada.userId, instanceAdmin: false }),
    asBob: withActor(notifyRoutes(db, HOME), { userId: bob.userId, instanceAdmin: false }),
  };
}

const send = (
  app: Hono<AuthEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

test("prefs list defaults and a put changes only the caller's row", async () => {
  const { asAda, asBob, db, ada } = setup();
  const before = (await (await send(asAda, "GET", "/prefs")).json()) as { enabled: boolean }[];
  expect(before).toHaveLength(25);
  const put = await send(asAda, "PUT", "/prefs", { channel: "push", kind: "dm", enabled: false });
  expect(put.status).toBe(200);
  const mine = (await (await send(asAda, "GET", "/prefs")).json()) as {
    channel: string;
    kind: string;
    enabled: boolean;
  }[];
  expect(mine.find((p) => p.channel === "push" && p.kind === "dm")?.enabled).toBe(false);
  const theirs = (await (await send(asBob, "GET", "/prefs")).json()) as typeof mine;
  expect(theirs.find((p) => p.channel === "push" && p.kind === "dm")?.enabled).toBe(true);
  expect(db.query("SELECT member_id FROM notify_prefs").all()).toEqual([
    { member_id: ada.memberId },
  ]);
});

test("a bad pref body is 400", async () => {
  const { asAda } = setup();
  expect(
    (await send(asAda, "PUT", "/prefs", { channel: "fax", kind: "dm", enabled: true })).status,
  ).toBe(400);
});

test("a target is added, listed without secret values and deleted", async () => {
  const { asAda } = setup();
  const created = await send(asAda, "POST", "/targets", {
    channel: "email",
    value: { address: "ada@example.test" },
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const list = await (await send(asAda, "GET", "/targets")).json();
  expect(list).toEqual([{ id, channel: "email", label: "ada@example.test" }]);
  expect((await send(asAda, "DELETE", `/targets/${id}`)).status).toBe(200);
  expect(await (await send(asAda, "GET", "/targets")).json()).toEqual([]);
});

test("a target missing a required value is 400", async () => {
  const { asAda } = setup();
  const res = await send(asAda, "POST", "/targets", {
    channel: "email",
    value: { to: "x@y.test" },
  });
  expect(res.status).toBe(400);
});

test("a member cannot delete or see another member's target", async () => {
  const { asAda, asBob, db, ada, bob } = setup();
  const id = addTarget(db, ada.memberId, "email", { address: "ada@example.test" });
  expect((await send(asBob, "DELETE", `/targets/${id}`)).status).toBe(404);
  expect(listTargets(db, ada.memberId)).toHaveLength(1);
  expect(removeTarget(db, bob.memberId, id)).toBe(false);
  expect(await (await send(asBob, "GET", "/targets")).json()).toEqual([]);
  expect((await send(asAda, "DELETE", `/targets/${id}`)).status).toBe(200);
});

test("?org picks the caller's member there and a stranger's org is 404", async () => {
  const { asAda, bob, ada, db } = setup();
  const created = await send(asAda, "POST", `/targets?org=${ada.slug}`, {
    channel: "telegram",
    value: { chatId: "42" },
  });
  expect(created.status).toBe(201);
  expect(db.query("SELECT member_id FROM notify_targets").all()).toEqual([
    { member_id: ada.memberId },
  ]);
  expect((await send(asAda, "GET", `/targets?org=${bob.slug}`)).status).toBe(404);
});

test("a user in no org gets 404", async () => {
  const { db } = setup();
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES ('u-lone', 'l@x.test', 'l', 0, 1)",
  ).run();
  const lone = withActor(notifyRoutes(db, HOME), { userId: "u-lone", instanceAdmin: false });
  expect((await send(lone, "GET", "/targets")).status).toBe(404);
});
