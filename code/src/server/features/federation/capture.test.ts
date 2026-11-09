import { expect, test } from "bun:test";
import { flush, loadHlcState } from "./capture";
import { createHlcState } from "./hlc";
import { addTask, freshDb, seedProject } from "./test-kit";

const NOW = 5_000_000_000_000;
const dirtyCount = (db: ReturnType<typeof freshDb>): number =>
  (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fed_dirty").get() as { n: number }).n;

test("a task edit in a shared project is captured and stamped", () => {
  const db = freshDb();
  seedProject(db, { shared: true });
  addTask(db, "t1");
  db.run("UPDATE tasks SET title = 'edited' WHERE id = 't1'");
  const state = createHlcState("inst-a");
  flush(db, state, undefined, NOW);
  const changes = db
    .query<{ table_name: string; op: string; data: string; hlc: string }, []>(
      "SELECT * FROM fed_changes WHERE table_name = 'tasks'",
    )
    .all();
  expect(changes).toHaveLength(1);
  expect(JSON.parse(changes[0]?.data ?? "{}").title).toBe("edited");
  const row = db
    .query<{ hlc: string; origin_instance: string }, []>("SELECT hlc, origin_instance FROM tasks")
    .get();
  expect(row).toEqual({ hlc: changes[0]?.hlc as string, origin_instance: "inst-a" });
  expect(dirtyCount(db)).toBe(0);
  expect(
    db.query<{ value: string }, []>("SELECT value FROM fed_state WHERE key = 'applying'").get()
      ?.value,
  ).toBe("0");
  expect(loadHlcState(db, "inst-a").ms).toBe(NOW);
  db.close();
});

test("the same edit in an unshared project is ignored", () => {
  const db = freshDb();
  seedProject(db, { shared: false });
  addTask(db, "t1");
  db.run("UPDATE tasks SET title = 'edited' WHERE id = 't1'");
  expect(dirtyCount(db)).toBe(0);
  expect(flush(db, createHlcState("inst-a"), undefined, NOW)).toBe(0);
  db.close();
});

test("payload only has allowlisted columns and names the home instance", () => {
  const db = freshDb();
  seedProject(db, { shared: true });
  db.run(
    "INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at) VALUES ('m1', 'o1', 'human', 'secret-user', 'bob', 'Bob', 'member', 1)",
  );
  db.run("UPDATE projects SET name = 'Eng2' WHERE id = 'p1'");
  flush(db, createHlcState("inst-a"), undefined, NOW);
  const rows = db
    .query<{ table_name: string; data: string }, []>("SELECT table_name, data FROM fed_changes")
    .all();
  const member = rows.find((r) => r.table_name === "members");
  expect(Object.keys(JSON.parse(member?.data ?? "{}")).sort()).toEqual([
    "display_name",
    "handle",
    "id",
    "kind",
    "org_id",
    "role",
  ]);
  const project = rows.find((r) => r.table_name === "projects");
  expect(JSON.parse(project?.data ?? "{}").home_instance).toBe("inst-a");
  expect(rows.some((r) => r.data?.includes("secret-user"))).toBe(false);
  db.close();
});

test("a delete becomes a del change plus a tombstone", () => {
  const db = freshDb();
  seedProject(db, { shared: true });
  addTask(db, "t1");
  flush(db, createHlcState("inst-a"), undefined, NOW);
  db.run("DELETE FROM tasks WHERE id = 't1'");
  flush(db, createHlcState("inst-a", NOW, 5), undefined, NOW);
  const last = db
    .query<{ op: string; project_id: string }, []>(
      "SELECT op, project_id FROM fed_changes ORDER BY seq DESC LIMIT 1",
    )
    .get();
  expect(last).toEqual({ op: "del", project_id: "p1" });
  expect(db.query("SELECT 1 FROM fed_tombstones WHERE row_id = 't1'").get()).not.toBeNull();
  db.close();
});
