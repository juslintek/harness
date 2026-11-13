import { expect, test } from "bun:test";
import { applyBatch, applyChange, type Change } from "./apply";
import { addTask, freshDb, hlcAt, seedProject, taskChange, taskDel } from "./test-kit";

function setup() {
  const db = freshDb();
  seedProject(db, { shared: true });
  return db;
}
const title = (db: ReturnType<typeof freshDb>, id = "t1"): string | undefined =>
  db.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?").get(id)?.title;

test("a later hlc wins, an older one loses", () => {
  const db = setup();
  expect(applyChange(db, taskChange("t1", hlcAt(200), "second"))).toBe("applied");
  expect(applyChange(db, taskChange("t1", hlcAt(100), "first"))).toBe("stale");
  expect(title(db)).toBe("second");
  expect(applyChange(db, taskChange("t1", hlcAt(300), "third"))).toBe("applied");
  expect(title(db)).toBe("third");
  db.close();
});

test("a local row without hlc loses to any change", () => {
  const db = setup();
  addTask(db, "t1", "local");
  expect(applyChange(db, taskChange("t1", hlcAt(1), "remote"))).toBe("applied");
  expect(title(db)).toBe("remote");
  db.close();
});

test("equal hlc is decided by the smaller origin instance", () => {
  const db = setup();
  applyChange(db, taskChange("t1", hlcAt(100), "from-b", "inst-b"));
  expect(applyChange(db, taskChange("t1", hlcAt(100), "from-c", "inst-c"))).toBe("stale");
  expect(applyChange(db, taskChange("t1", hlcAt(100), "from-a", "inst-a"))).toBe("applied");
  expect(title(db)).toBe("from-a");
  db.close();
});

test("a delete beats an older put and blocks it", () => {
  const db = setup();
  applyChange(db, taskChange("t1", hlcAt(100), "v1"));
  expect(applyChange(db, taskDel("t1", hlcAt(200)))).toBe("applied");
  expect(title(db)).toBeUndefined();
  expect(applyChange(db, taskChange("t1", hlcAt(150), "late"))).toBe("stale");
  expect(title(db)).toBeUndefined();
  db.close();
});

test("a delete older than the row is stale, and a newer put revives", () => {
  const db = setup();
  applyChange(db, taskChange("t1", hlcAt(200), "v2"));
  expect(applyChange(db, taskDel("t1", hlcAt(100)))).toBe("stale");
  expect(title(db)).toBe("v2");
  applyChange(db, taskDel("t1", hlcAt(300)));
  expect(applyChange(db, taskChange("t1", hlcAt(400), "back"))).toBe("applied");
  expect(title(db)).toBe("back");
  expect(db.query("SELECT 1 FROM fed_tombstones").get()).toBeNull();
  db.close();
});

test("a batch with a missing parent rejects that row only", () => {
  const db = setup();
  const orphan = taskChange("t2", hlcAt(100), "orphan");
  orphan.data = JSON.stringify({ ...JSON.parse(orphan.data as string), project_id: "nope" });
  const result = applyBatch(db, [orphan, taskChange("t1", hlcAt(100), "ok")]);
  expect(result).toEqual({ applied: 1, stale: 0, rejected: 1 });
  expect(title(db, "t1")).toBe("ok");
  expect(title(db, "t2")).toBeUndefined();
  db.close();
});

test("parents arrive first inside a batch whatever the input order", () => {
  const db = setup();
  const comment = {
    project_id: "p1",
    table_name: "comments",
    row_id: "c1",
    op: "put" as const,
    hlc: hlcAt(100),
    origin_instance: "inst-b",
    data: JSON.stringify({ id: "c1", task_id: "t1", author_id: null, body: "hi", created_at: 1 }),
  };
  expect(applyBatch(db, [comment, taskChange("t1", hlcAt(100), "t")])).toEqual({
    applied: 2,
    stale: 0,
    rejected: 0,
  });
  db.close();
});

test("applying creates no fed_dirty rows and leaves the flag off", () => {
  const db = setup();
  db.run("DELETE FROM fed_dirty");
  applyChange(db, taskChange("t1", hlcAt(100), "v1"));
  applyChange(db, taskChange("t1", hlcAt(200), "v2"));
  applyChange(db, taskDel("t1", hlcAt(300)));
  expect(db.query("SELECT 1 FROM fed_dirty").get()).toBeNull();
  expect(
    db.query<{ value: string }, []>("SELECT value FROM fed_state WHERE key = 'applying'").get()
      ?.value,
  ).toBe("0");
  addTask(db, "t9");
  expect(db.query("SELECT 1 FROM fed_dirty").get()).not.toBeNull();
  db.close();
});

test("peers cannot overwrite what this instance owns, nor smuggle other tables or columns", () => {
  const db = setup();
  const project = {
    project_id: "p1",
    table_name: "projects",
    row_id: "p1",
    op: "put" as const,
    hlc: hlcAt(999),
    origin_instance: "inst-b",
    data: JSON.stringify({
      id: "p1",
      org_id: "o1",
      key: "X",
      name: "hijack",
      home_instance: "inst-b",
      created_at: 1,
    }),
  };
  expect(applyChange(db, project)).toBe("rejected");
  expect(applyChange(db, { ...project, table_name: "agents", row_id: "p1" })).toBe("rejected");
  const bad = taskChange("t1", hlcAt(100), "x");
  bad.data = JSON.stringify({ ...JSON.parse(bad.data as string), status: "bogus" });
  expect(applyChange(db, bad)).toBe("rejected");
  expect(db.query<{ name: string }, []>("SELECT name FROM projects").get()?.name).toBe("Eng");
  db.close();
});

test("a member stub gets no real identity", () => {
  const db = setup();
  const stub = {
    project_id: "p1",
    table_name: "members",
    row_id: "m9",
    op: "put" as const,
    hlc: hlcAt(100),
    origin_instance: "inst-b",
    data: JSON.stringify({
      id: "m9",
      org_id: "o2",
      kind: "agent",
      handle: "bot",
      display_name: "Bot",
      role: "member",
      model: "x",
    }),
  };
  expect(applyChange(db, stub)).toBe("applied");
  const row = db
    .query<{ agent_id: string; model: string | null }, []>(
      "SELECT agent_id, model FROM members WHERE id = 'm9'",
    )
    .get();
  expect(row).toEqual({ agent_id: "remote:m9", model: null });
  db.close();
});

const numberOf = (db: ReturnType<typeof freshDb>, id: string): number | undefined =>
  db.query<{ number: number }, [string]>("SELECT number FROM tasks WHERE id = ?").get(id)?.number;

test("a task number taken by another task is replaced instead of dropping the task", () => {
  const db = setup();
  addTask(db, "local", "mine");
  expect(numberOf(db, "local")).toBe(1);
  expect(applyChange(db, taskChange("t1", hlcAt(100), "theirs"))).toBe("applied");
  const renumbered = numberOf(db, "t1");
  expect(renumbered).not.toBe(1);
  expect(applyChange(db, taskChange("t1", hlcAt(200), "theirs again"))).toBe("applied");
  expect(numberOf(db, "t1")).toBe(renumbered);
  expect(numberOf(db, "local")).toBe(1);
  db.close();
});

test("an org slug taken by a local org is replaced instead of dropping the org", () => {
  const db = setup();
  const org = (hlc: string): Change => ({
    project_id: "p1",
    table_name: "orgs",
    row_id: "o-home",
    op: "put",
    hlc,
    origin_instance: "inst-b",
    data: JSON.stringify({ id: "o-home", slug: "acme", name: "Acme", home_instance: "inst-b" }),
  });
  const slugOf = (id: string): string | undefined =>
    db.query<{ slug: string }, [string]>("SELECT slug FROM orgs WHERE id = ?").get(id)?.slug;
  expect(applyChange(db, org(hlcAt(100)))).toBe("applied");
  const slug = slugOf("o-home");
  expect(slug).not.toBe("acme");
  expect(slugOf("o1")).toBe("acme");
  expect(applyChange(db, org(hlcAt(200)))).toBe("applied");
  expect(slugOf("o-home")).toBe(slug);
  db.close();
});
