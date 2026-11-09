import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";

test("migrations 32 to 34 apply on a fresh db", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  expect(migrations.at(-1)?.version).toBe(34);
  db.close();
});
