import { expect, test } from "bun:test";
import { TABLES } from "./schema";
import { freshDb } from "./test-kit";

const FORBIDDEN_COLUMNS = [
  "agent_id",
  "model",
  "user_id",
  "heartbeat_minutes",
  "specialties",
  "member_id",
  "source_agent",
  "repo",
];
const FORBIDDEN_TABLE =
  /^(agents|runs?|run_tokens|approvals|policies|profiles|oauth_.*|notify_.*|secrets|tokens)$/;

test("allowlist carries no credential, agent or run data", () => {
  for (const table of TABLES) {
    expect(table.name).not.toMatch(FORBIDDEN_TABLE);
    for (const column of [...table.columns, ...table.pk, ...table.refs.map((r) => r.column)]) {
      expect(FORBIDDEN_COLUMNS).not.toContain(column);
    }
    for (const ref of table.refs) expect(ref.table).not.toMatch(FORBIDDEN_TABLE);
  }
});

test("members and orgs are stubs", () => {
  const columns = (name: string) => TABLES.find((t) => t.name === name)?.columns;
  expect(columns("orgs")).toEqual(["id", "slug", "name", "home_instance"]);
  expect(columns("members")).toEqual(["id", "org_id", "kind", "handle", "display_name", "role"]);
});

test("every listed column exists and tables come parents first", () => {
  const db = freshDb();
  const seen = new Set<string>();
  for (const table of TABLES) {
    const real = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table.name})`)
      .all()
      .map((c) => c.name);
    for (const column of table.columns) expect(real).toContain(column);
    expect(real).toContain("hlc");
    expect(real).toContain("origin_instance");
    for (const ref of table.refs)
      expect(seen.has(ref.table) || ref.table === table.name).toBe(true);
    seen.add(table.name);
  }
  db.close();
});
