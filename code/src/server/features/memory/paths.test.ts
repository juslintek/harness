import { expect, test } from "bun:test";
import {
  canRead,
  canWrite,
  diskToLocated,
  type Located,
  resolveVirtual,
  toDisk,
  toVirtual,
  type Viewer,
} from "./paths";

const agent: Viewer = {
  orgId: "o1",
  memberId: "m1",
  projectIds: ["p1"],
  canWriteGlobal: false,
  actor: "bot",
};
const human: Viewer = { ...agent, memberId: null, canWriteGlobal: true, actor: "human:u1" };
const slugs: Record<string, string> = { alpha: "p1", beta: "p2" };
const bySlug = (s: string): string | null => slugs[s] ?? null;

test("path tricks are rejected", () => {
  const bad = [
    "/memories/agent/../../orgs/o2/x.md",
    "/memories/agent/a.md/../b",
    "/memories/agent/../x.md",
    "/memories/agent/a/../b.md",
    "/memories/org//x.md",
    "/memories/org/./x.md",
    "/memories/org/x.md/",
    "/memories/org/.git/config",
    "/memories/org/.git/x.md",
    "/memories/org/.hidden.md",
    "/memories/org/x.txt",
    "/memories/org/X.md",
    "/memories/org/a\\b.md",
    "/memories/org/a\0b.md",
    "/memories/org/a.md\0",
    "/etc/passwd",
    "/Users/x/.harness/memory/global/a.md",
    "memories/org/a.md",
    "/memories/other/a.md",
    `/memories/org/${"a".repeat(198)}.md`,
  ];
  for (const p of bad) expect(resolveVirtual(p, agent, bySlug)).toBeNull();
  expect(resolveVirtual("/memories/org/ok/a.md", agent, bySlug)).not.toBeNull();
});

test("directories", () => {
  for (const p of ["/memories", "/memories/global", "/memories/org", "/memories/project"])
    expect(resolveVirtual(p, agent, bySlug)).toBe("dir");
  expect(resolveVirtual("/memories/project/alpha", agent, bySlug)).toBe("dir");
  expect(resolveVirtual("/memories/project/beta", agent, bySlug)).toBeNull();
  expect(resolveVirtual("/memories/agent", human, bySlug)).toBeNull();
});

test("project outside viewer.projectIds is not resolvable", () => {
  expect(resolveVirtual("/memories/project/beta/a.md", agent, bySlug)).toBeNull();
  expect(resolveVirtual("/memories/project/nope/a.md", agent, bySlug)).toBeNull();
  const ok = resolveVirtual("/memories/project/alpha/a.md", agent, bySlug) as Located;
  expect(ok.disk).toBe("orgs/o1/projects/p1/a.md");
});

test("agent scope maps to own member; humans have none", () => {
  const own = resolveVirtual("/memories/agent/a.md", agent, bySlug) as Located;
  expect(own.disk).toBe("orgs/o1/agents/m1/a.md");
  expect(resolveVirtual("/memories/agent/a.md", human, bySlug)).toBeNull();
});

test("agents cannot read another member's notes, humans can", () => {
  const other = diskToLocated("orgs/o1/agents/m2/a.md") as Located;
  expect(canRead(agent, other)).toBe(false);
  expect(canWrite(agent, other)).toBe(false);
  expect(canRead(human, other)).toBe(true);
  expect(canWrite(human, other)).toBe(true);
  const foreign = diskToLocated("orgs/o2/agents/m1/a.md") as Located;
  expect(canRead(human, foreign)).toBe(false);
  expect(canRead(agent, diskToLocated("orgs/o2/org/a.md") as Located)).toBe(false);
  expect(canRead(agent, diskToLocated("orgs/o1/projects/p2/a.md") as Located)).toBe(false);
});

test("global is readable by all, writable only with canWriteGlobal", () => {
  const g = diskToLocated("global/a.md") as Located;
  expect(canRead(agent, g)).toBe(true);
  expect(canWrite(agent, g)).toBe(false);
  expect(canWrite(human, g)).toBe(true);
});

test("disk and virtual paths round trip for each scope", () => {
  const disks = [
    "global/a/b.md",
    "orgs/o1/org/a.md",
    "orgs/o1/projects/p1/a.md",
    "orgs/o1/agents/m1/a.md",
  ];
  for (const d of disks) {
    const loc = diskToLocated(d) as Located;
    expect(toDisk(loc)).toBe(d);
    expect(loc.disk).toBe(d);
    const v = toVirtual(loc, () => "alpha");
    if (loc.scope !== "agent") expect(resolveVirtual(v, agent, bySlug)).toEqual(loc);
  }
  const own = diskToLocated("orgs/o1/agents/m1/a.md") as Located;
  expect(
    resolveVirtual(
      toVirtual(own, () => "x"),
      agent,
      bySlug,
    ),
  ).toEqual(own);
});

test("diskToLocated rejects foreign shapes", () => {
  for (const d of [
    ".git/config",
    "orgs/o1/org/a.txt",
    "orgs/o1/other/a.md",
    "orgs/o1/org/../../x.md",
    "orgs/o1/projects/a.md",
    "orgs/o1/org/.git/a.md",
    "orgs/../org/a.md",
    "x/a.md",
  ])
    expect(diskToLocated(d)).toBeNull();
});
