import type { Database } from "bun:sqlite";
import { insertClient } from "./repo";

const LOCAL_CLIENT_NAME = "Claude Desktop (local)";

export function isLocalClient(db: Database, clientId: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM oauth_clients WHERE id = ? AND name = ? AND redirect_uris = '[]'",
      )
      .get(clientId, LOCAL_CLIENT_NAME) !== null
  );
}

export function localClientId(db: Database, now: number): string {
  const found = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM oauth_clients WHERE name = ? AND redirect_uris = '[]'",
    )
    .get(LOCAL_CLIENT_NAME);
  return found?.id ?? insertClient(db, LOCAL_CLIENT_NAME, [], now);
}

export function revokeLocalTokens(db: Database, memberId: string, now: number): number {
  return db
    .query(
      `UPDATE oauth_tokens SET revoked_at = ?
        WHERE member_id = ? AND revoked_at IS NULL
          AND client_id IN (SELECT id FROM oauth_clients WHERE name = ? AND redirect_uris = '[]')`,
    )
    .run(now, memberId, LOCAL_CLIENT_NAME).changes;
}
