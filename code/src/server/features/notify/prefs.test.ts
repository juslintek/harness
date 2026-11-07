import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { seedMember } from "../../test-support/bridge-kit";
import { effectivePrefs, setPref } from "./api";

function setup(): { db: Database; memberId: string } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return { db, memberId: seedMember(db, "ada").memberId };
}

const enabled = (db: Database, memberId: string): string[] =>
  effectivePrefs(db, memberId)
    .filter((p) => p.enabled)
    .map((p) => `${p.channel}:${p.kind}`)
    .sort();

test("with no rows only the documented defaults are on", () => {
  const { db, memberId } = setup();
  expect(effectivePrefs(db, memberId)).toHaveLength(25);
  expect(enabled(db, memberId)).toEqual([
    "email:approval_requested",
    "push:approval_requested",
    "push:dm",
    "push:mention",
  ]);
});

test("a row overrides the default in both directions and a second write replaces it", () => {
  const { db, memberId } = setup();
  setPref(db, memberId, "push", "mention", false);
  setPref(db, memberId, "slack", "run_blocked", true);
  setPref(db, memberId, "slack", "run_blocked", false);
  setPref(db, memberId, "slack", "run_blocked", true);
  expect(enabled(db, memberId)).toEqual([
    "email:approval_requested",
    "push:approval_requested",
    "push:dm",
    "slack:run_blocked",
  ]);
  expect(db.query("SELECT COUNT(*) AS n FROM notify_prefs").get()).toEqual({ n: 2 });
});

test("prefs of one member do not touch another", () => {
  const { db, memberId } = setup();
  const other = seedMember(db, "bob").memberId;
  setPref(db, memberId, "push", "dm", false);
  expect(enabled(db, other)).toContain("push:dm");
});
