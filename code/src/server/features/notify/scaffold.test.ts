import { expect, test } from "bun:test";
import {
  type NotifyKind,
  notificationSchema,
  type PrefView,
  prefSchema,
  type TargetView,
} from "../../../shared/notify";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";

test("migrations 29 through 31 apply on a fresh db and their tables exist", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const name of [
    "notify_targets",
    "notify_prefs",
    "notify_log",
    "notify_settings",
    "bridges",
    "bridge_users",
    "oauth_consent_challenges",
  ]) {
    expect(tables).toContain(name);
  }
  db.close();
});

test("shared schemas accept a valid notification and pref and reject an unknown kind", () => {
  const kind: NotifyKind = "mention";
  const view: TargetView = { id: "t1", channel: "webhook", label: "https://example.test/hook" };
  const pref: PrefView = { channel: "push", kind, enabled: true };
  expect(prefSchema.parse(pref)).toEqual(pref);
  expect(view.label).toContain("https://");
  const note = { kind, orgId: "o1", title: "t", body: "b", path: "/#/x", tag: "x" };
  expect(notificationSchema.parse(note)).toEqual(note);
  expect(() => notificationSchema.parse({ ...note, kind: "nope" })).toThrow();
});
