import { expect, test } from "bun:test";
import type { OrgDetail } from "../../../shared/orgs";
import { keptAfterReload, mayDiscard, ownProjects, tabOf, tabsFor } from "./memory-data";

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

test("a viewer only gets the notes tab and a direct writes link falls back to it", () => {
  expect(tabsFor("viewer")).toEqual(["notes"]);
  expect(tabsFor("member")).toEqual(["notes", "writes", "review"]);
  expect(tabOf("writes", tabsFor("viewer"))).toBe("notes");
  expect(tabOf("review", tabsFor("viewer"))).toBe("notes");
  expect(tabOf("writes", tabsFor("member"))).toBe("writes");
});
