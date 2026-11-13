import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import { createProject } from "../orgs/api";
import type { Change } from "./apply";
import {
  addPeerMember,
  bootNode,
  ids,
  type Node,
  pairNodes,
  permutations,
  plantedKit,
  type Seed,
  seedProject,
  shareTo,
  taskRow,
} from "./sync-kit";

// A page in which b sends one row id twice. applyBatch keeps only one of the twins, so neither may
// stand in as evidence for the rows that lean on it. a is the home, b may write the project G and
// has a stub org (and the member BEE in it) here.
let a: Node;
let b: Node;
let seed: Seed;
let granted: string;
let granted2: string;
let grantedTask: string;
let stubOrg: string;

const BEE = "m-bee";

const { put, run, stored } = plantedKit(
  () => a,
  () => b,
);
// Older than anything stored, so applyBatch reports it stale when its twin got there first.
const old = (change: Change): Change => ({
  ...change,
  hlc: `0000000000001-0000-${b.instanceId}`,
});

const copy = (id: string, org: string = stubOrg, home: string = b.instanceId): Change =>
  put("projects", id, id, {
    id,
    org_id: org,
    key: id,
    name: id,
    home_instance: home,
    created_at: 1,
  });
const org = (id: string, project: string): Change =>
  put("orgs", id, project, { id, slug: id, name: id, home_instance: b.instanceId });
const task = (id: string, project: string, orgId: string = stubOrg, title = "forged"): Change =>
  put("tasks", id, project, { ...taskRow(id, project, orgId), created_by: BEE, title });
const member = (id: string, project: string, orgId: string): Change =>
  put("members", id, project, {
    id,
    org_id: orgId,
    kind: "human",
    handle: id,
    display_name: id,
    role: "member",
  });
const comment = (id: string, project: string, taskId: string, author: string): Change =>
  put("comments", id, project, {
    id,
    task_id: taskId,
    author_id: author,
    body: "forged",
    created_at: 1,
  });

// Each order gets its own ids, so nothing stored by one run decides the next.
function inEveryOrder(
  build: (n: number) => Change[],
  check: (n: number, order: Change[], out: ReturnType<typeof run>) => void,
): void {
  permutations(build(0).map((_, i) => i)).forEach((positions, n) => {
    const page = build(n);
    const order = positions.map((i) => page[i] as Change);
    check(n, order, run(...order));
  });
}

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  granted = createProject(a.db, { orgId: seed.orgId, key: "GRT", name: "Granted" }).id;
  await shareTo(a, { ...seed, projectId: granted }, b, "write");
  granted2 = createProject(a.db, { orgId: seed.orgId, key: "GR2", name: "Granted too" }).id;
  await shareTo(a, { ...seed, projectId: granted2 }, b, "write");
  stubOrg =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
      .get(b.instanceId)?.id ?? "";
  addPeerMember(a, b, BEE);
  grantedTask = createTask(a.db, { projectId: granted, title: "granted", createdBy: BEE }).id;
});

afterAll(() => {
  a.stop();
  b.stop();
});

test("a task sent in G and in a copy project cannot carry a home comment into G, in any order", () => {
  // The comment is labelled with the copy project, where nobody checks its author.
  inEveryOrder(
    (n) => [
      copy(`q${n}`),
      task(`t${n}`, granted, seed.orgId),
      task(`t${n}`, `q${n}`),
      comment(`c${n}`, `q${n}`, `t${n}`, seed.memberId),
    ],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order.filter((c) => c.table_name !== "comments")));
      expect(stored("comments", `c${n}`)).toBe(0);
    },
  );
});

test("the same holds when the copy project was stored by an earlier page", () => {
  expect(run(copy("q-early"))).toEqual({
    allowed: ["projects:q-early"],
    result: { applied: 1, stale: 0, rejected: 0 },
  });
  inEveryOrder(
    (n) => [
      task(`te${n}`, granted, seed.orgId),
      task(`te${n}`, "q-early"),
      comment(`ce${n}`, "q-early", `te${n}`, seed.memberId),
    ],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order.filter((c) => c.table_name !== "comments")));
      expect(stored("comments", `ce${n}`)).toBe(0);
    },
  );
});

test("a member sent with two orgs does not vouch for a comment as the peer's own", () => {
  expect(run(copy("q-m"), org("o-dup", "q-m")).result.rejected).toBe(0);
  inEveryOrder(
    (n) => [
      member(`m${n}`, "q-m", "o-dup"),
      old(member(`m${n}`, granted, stubOrg)),
      comment(`cm${n}`, granted, grantedTask, `m${n}`),
    ],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order.filter((c) => c.table_name !== "comments")));
      expect(stored("comments", `cm${n}`)).toBe(0);
    },
  );
});

test("a project sent with two orgs does not tell which org its tasks must name", () => {
  expect(run(copy("q-o"), org("o-a", "q-o"), org("o-b", "q-o")).result.rejected).toBe(0);
  inEveryOrder(
    (n) => [copy(`p${n}`, "o-a"), old(copy(`p${n}`, "o-b")), task(`tp${n}`, `p${n}`, "o-b")],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order.filter((c) => c.table_name === "projects")));
      expect(stored("tasks", `tp${n}`)).toBe(0);
    },
  );
});

test("a task sent twice with the same project still carries its comment, in any order", () => {
  inEveryOrder(
    (n) => [
      copy(`qi${n}`),
      task(`ti${n}`, `qi${n}`),
      task(`ti${n}`, `qi${n}`, stubOrg, "again"),
      comment(`ci${n}`, `qi${n}`, `ti${n}`, BEE),
    ],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order));
      expect(stored("comments", `ci${n}`)).toBe(1);
    },
  );
});

test("a project twin that names another home does not cost the valid copy its children", () => {
  // Only the twin naming the peer can pass, so the other adds nothing to the evidence.
  inEveryOrder(
    (n) => [copy(`qh${n}`), copy(`qh${n}`, stubOrg, "elsewhere"), task(`th${n}`, `qh${n}`)],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order.filter((c) => !c.data?.includes("elsewhere"))));
      const home = a.db
        .query<{ home: string }, [string]>(
          "SELECT p.home_instance AS home FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
        )
        .get(`th${n}`)?.home;
      expect(home).toBe(b.instanceId);
    },
  );
});

test("a task sent in two granted projects of one org cannot carry a comment by either label", () => {
  // Both twins name the same org, so only the project tells them apart.
  inEveryOrder(
    (n) => [
      task(`tw${n}`, granted, seed.orgId),
      task(`tw${n}`, granted2, seed.orgId),
      comment(`cw${n}`, granted2, `tw${n}`, BEE),
    ],
    (n, order, out) => {
      expect(out.allowed).toEqual(ids(order.filter((c) => c.table_name !== "comments")));
      expect(stored("comments", `cw${n}`)).toBe(0);
    },
  );
});
