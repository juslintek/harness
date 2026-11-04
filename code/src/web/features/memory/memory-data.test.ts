import { expect, test } from "bun:test";
import type { OrgDetail } from "../../../shared/orgs";
import { canRevert, keptAfterReload, mayDiscard, ownProjects } from "./memory-data";

test("a second reload without edits keeps the first draft", () => {
  const first = keptAfterReload(null, "my draft", "server v1");
  expect(first).toBe("my draft");
  expect(keptAfterReload(first, "server v1", "server v1")).toBe("my draft");
});

test("a draft edited after a reload replaces the kept one", () => {
  expect(keptAfterReload("old draft", "newer draft", "server v2")).toBe("newer draft");
});

test("escape asks before dropping an edited draft", () => {
  const asked: string[] = [];
  expect(mayDiscard(false, () => false)).toBe(true);
  expect(
    mayDiscard(true, (q) => {
      asked.push(q);
      return false;
    }),
  ).toBe(false);
  expect(mayDiscard(true, () => true)).toBe(true);
  expect(asked).toHaveLength(1);
});

test("rename and outside writes cannot be reverted", () => {
  expect(["create", "update", "delete"].every(canRevert)).toBe(true);
  expect(canRevert("rename") || canRevert("outside")).toBe(false);
});

test("the note form only offers projects owned by the current org", () => {
  const detail = {
    org: { id: "o1" },
    projects: [
      { id: "p1", orgId: "o1" },
      { id: "p2", orgId: "o2" },
    ],
  } as OrgDetail;
  expect(ownProjects(detail).map((p) => p.id)).toEqual(["p1"]);
});
