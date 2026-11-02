import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import { addHumanMember, createOrg, createProject, grantProject } from "../orgs/api";
import { call, type Db, listen, tokenFor, world } from "./test-kit";

let db: Db;
let server: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db, migrations);
  server = await listen(db);
});
afterEach(() => {
  server.stop(true);
});

test("a number that only exists in a granted project resolves in the grantee org", async () => {
  const w = world(db);
  const owner = w.agent(w.a.id, "ax");
  const guest = w.agent(w.b.id, "bz");
  grantProject(db, w.project.id, w.b.id, "write", owner.id);
  const made = createTask(db, { projectId: w.project.id, title: "shared", createdBy: owner.id });
  const t = tokenFor(db, guest.id, w.b.id);
  const byNumber = await call(server, t, "task_get", { task: made.number });
  expect(JSON.parse(byNumber.text)).toMatchObject({ id: made.id, title: "shared" });
  expect((await call(server, t, "task_get", { task: made.id })).isError).toBe(false);
});

test("the token's own org wins a number clash", async () => {
  const w = world(db);
  const owner = w.agent(w.a.id, "ax");
  const guest = w.agent(w.b.id, "bz");
  grantProject(db, w.project.id, w.b.id, "write", owner.id);
  createTask(db, { projectId: w.project.id, title: "theirs", createdBy: owner.id });
  const mine = createTask(db, { projectId: w.projectB.id, title: "mine", createdBy: guest.id });
  const got = await call(server, tokenFor(db, guest.id, w.b.id), "task_get", {
    task: mine.number,
  });
  expect(JSON.parse(got.text).title).toBe("mine");
});

test("a number found in two granting orgs asks for the task id", async () => {
  const w = world(db);
  const guest = w.agent(w.b.id, "bz");
  const c = createOrg(db, {
    name: "c",
    slug: "cc",
    ownerUserId: "cc",
    ownerName: "c",
    ownerHandle: "cc",
  });
  const pc = createProject(db, { orgId: c.id, key: "c", name: "C" });
  const [ma, mc] = [w.agent(w.a.id, "ax"), w.agent(c.id, "cx")];
  grantProject(db, w.project.id, w.b.id, "read", ma.id);
  grantProject(db, pc.id, w.b.id, "read", mc.id);
  createTask(db, { projectId: w.project.id, title: "from a", createdBy: ma.id });
  const fromC = createTask(db, { projectId: pc.id, title: "from c", createdBy: mc.id });
  const t = tokenFor(db, guest.id, w.b.id);
  const ambiguous = await call(server, t, "task_get", { task: 1 });
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toContain("task id");
  expect(JSON.parse((await call(server, t, "task_get", { task: fromC.id })).text).title).toBe(
    "from c",
  );
});

test("an assignee needs write access to the project", async () => {
  const w = world(db);
  const x = w.agent(w.a.id, "ax");
  addHumanMember(db, w.a.id, "v", "vee", "Vee", "viewer");
  w.agent(w.a.id, "ay");
  const t = tokenFor(db, x.id, w.a.id);
  const make = (assignee: string) =>
    call(server, t, "task_create", { project: "web", title: "n", assignee });
  const viewer = await make("vee");
  expect(viewer.isError).toBe(true);
  expect(viewer.text).toContain("cannot work");
  expect((await make("ay")).isError).toBe(false);
});

test("an assignee handle is found in a grantee org, and an ambiguous one is refused", async () => {
  const w = world(db);
  const x = w.agent(w.a.id, "ax");
  w.agent(w.b.id, "gee");
  grantProject(db, w.project.id, w.b.id, "write", x.id);
  const t = tokenFor(db, x.id, w.a.id);
  const make = (assignee: string) =>
    call(server, t, "task_create", { project: "web", title: "n", assignee });
  expect((await make("gee")).isError).toBe(false);
  w.agent(w.a.id, "gee");
  const twice = await make("gee");
  expect(twice.isError).toBe(true);
  expect(twice.text).toContain("unique handle");
});
