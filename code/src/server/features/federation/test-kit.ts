import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import type { Change } from "./apply";

export function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return db;
}

// A local org owning a project; with `sharedWith` it also grants to an org that lives on another instance.
export function seedProject(
  db: Database,
  opts: { shared: boolean },
): { orgId: string; projectId: string } {
  db.run("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1', 'acme', 'Acme', 1)");
  db.run(
    "INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('p1', 'o1', 'ENG', 'Eng', 1)",
  );
  if (opts.shared) {
    db.run(
      "INSERT INTO orgs (id, slug, name, created_at, home_instance) VALUES ('o2', 'peer', 'Peer', 1, 'inst-b')",
    );
    db.run(
      "INSERT INTO grants (id, project_id, org_id, permission, granted_by, created_at) VALUES ('g1', 'p1', 'o2', 'write', 'u', 1)",
    );
  }
  return { orgId: "o1", projectId: "p1" };
}

export function addTask(db: Database, id: string, title = "t"): void {
  db.run(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, rank, created_by, created_at, updated_at)
     VALUES (?, 'o1', 'p1', (SELECT COUNT(*) + 1 FROM tasks), ?, 'todo', 1, 'u', 1, 1)`,
    [id, title],
  );
}

function taskData(id: string, title: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    org_id: "o1",
    project_id: "p1",
    number: 1,
    parent_id: null,
    title,
    description: "",
    status: "todo",
    rank: 1,
    assignee_id: null,
    holder_id: null,
    checked_out_at: null,
    estimate_minutes: null,
    created_by: "u",
    created_at: 1,
    updated_at: 1,
    ...extra,
  });
}

export function taskChange(id: string, hlc: string, title: string, origin = "inst-b"): Change {
  return {
    project_id: "p1",
    table_name: "tasks",
    row_id: id,
    op: "put",
    hlc,
    origin_instance: origin,
    data: taskData(id, title),
  };
}

export function taskDel(id: string, hlc: string, origin = "inst-b"): Change {
  return {
    project_id: "p1",
    table_name: "tasks",
    row_id: id,
    op: "del",
    hlc,
    origin_instance: origin,
    data: null,
  };
}

export const hlcAt = (ms: number, counter = 0, instance = "inst-b"): string =>
  `${String(ms).padStart(13, "0")}-${String(counter).padStart(4, "0")}-${instance}`;
