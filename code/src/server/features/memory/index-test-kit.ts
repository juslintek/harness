import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { serializeNote } from "./frontmatter";
import { diskToLocated, type Located, type Viewer } from "./paths";

export function testDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-memidx-"));
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  for (const org of ["A", "B"]) {
    db.run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, 1)", [
      org,
      org.toLowerCase(),
      org,
    ]);
  }
  return { db, dir };
}

export function viewer(orgId: string, memberId: string | null, projectIds: string[]): Viewer {
  return { orgId, memberId, projectIds, canWriteGlobal: false, canWrite: true, actor: "t" };
}

export function loc(disk: string): Located {
  return diskToLocated(disk) as Located;
}

export function noteText(
  body: string,
  extra: { id?: string; updated?: string; tags?: string[]; type?: "fact" | "lesson" } = {},
): string {
  return serializeNote(
    {
      tags: extra.tags ?? [],
      type: extra.type ?? "fact",
      sourceAgent: "bot",
      ...(extra.id === undefined ? {} : { id: extra.id }),
      ...(extra.updated === undefined ? {} : { updated: extra.updated }),
      extra: {},
    },
    body,
  );
}
