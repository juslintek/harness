import type { Database } from "bun:sqlite";

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export function listPasskeys(db: Database, userId: string): PasskeyInfo[] {
  return db
    .query<{ id: string; name: string; created_at: number; last_used_at: number | null }, [string]>(
      "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at",
    )
    .all(userId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
}

// The count and the delete share one transaction so two parallel deletes cannot both pass the
// "keep one" rule and leave the account without a passkey.
export function deletePasskey(
  db: Database,
  userId: string,
  id: string,
): "deleted" | "last" | "missing" {
  return db.transaction((): "deleted" | "last" | "missing" => {
    const owned = db.query("SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?").get(id, userId);
    if (!owned) return "missing";
    const count = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?")
      .get(userId)?.n;
    if ((count ?? 0) <= 1) return "last";
    db.query("DELETE FROM passkeys WHERE id = ? AND user_id = ?").run(id, userId);
    return "deleted";
  })();
}
