import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";

test("migrations through 34 apply on a fresh db", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  expect(migrations.length).toBeGreaterThanOrEqual(34);
  db.close();
});
