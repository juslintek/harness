import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  addHumanMember,
  createOrg,
  createPosition,
  listPositions,
  managerPositionsOf,
  type PositionPatch,
  type PositionRow,
  reportsTransitivelyTo,
  updatePosition,
} from "./api";

function setup(): { db: ReturnType<typeof openDb>; orgId: string; memberId: string } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const o = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const m = addHumanMember(db, o.id, "u2", "bob", "Bob", "member");
  return { db, orgId: o.id, memberId: m.id };
}

test("position cycle a→b→a rejected; cross-org reports_to rejected", () => {
  const { db, orgId } = setup();
  const a = createPosition(db, { orgId, title: "a" });
  const b = createPosition(db, { orgId, title: "b", reportsTo: a.id });
  expect(() => updatePosition(db, a.id, { reportsTo: b.id })).toThrow();
  expect(() => updatePosition(db, a.id, { reportsTo: a.id })).toThrow();
  const other = createOrg(db, {
    name: "B",
    slug: "bb",
    ownerUserId: "u3",
    ownerName: "O",
    ownerHandle: "owner",
  });
  expect(() => createPosition(db, { orgId: other.id, title: "x", reportsTo: a.id })).toThrow();
});

test("reportsTransitivelyTo follows two levels and stops at the cap", () => {
  const { db, orgId, memberId } = setup();
  const top = createPosition(db, { orgId, title: "top", isManager: true });
  const mid = createPosition(db, { orgId, title: "mid", reportsTo: top.id });
  createPosition(db, { orgId, title: "ic", reportsTo: mid.id, memberId });
  expect(reportsTransitivelyTo(db, memberId, top.id)).toBe(true);
  expect(reportsTransitivelyTo(db, memberId, mid.id)).toBe(true);
  expect(managerPositionsOf(db, memberId)).toEqual([]);

  const root = createPosition(db, { orgId, title: "root" });
  let prev = root.id;
  for (let i = 0; i < 40; i++)
    prev = createPosition(db, { orgId, title: `l${i}`, reportsTo: prev }).id;
  const deep = addHumanMember(db, orgId, "u4", "deep", "Deep", "member");
  updatePosition(db, prev, { memberId: deep.id });
  expect(reportsTransitivelyTo(db, deep.id, root.id)).toBe(false);
});

test("managerPositionsOf returns only manager positions", () => {
  const { db, orgId, memberId } = setup();
  createPosition(db, { orgId, title: "ic", memberId });
  const lead = createPosition(db, { orgId, title: "lead", memberId, isManager: true });
  expect(managerPositionsOf(db, memberId).map((p) => p.id)).toEqual([lead.id]);
});

test("listPositions returns the org positions in creation order", () => {
  const { db, orgId } = setup();
  const a: PositionRow = createPosition(db, { orgId, title: "a" });
  const patch: PositionPatch = { title: "a2" };
  updatePosition(db, a.id, patch);
  expect(listPositions(db, orgId).map((p) => p.title)).toEqual(["a2"]);
});
