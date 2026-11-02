import type { Database } from "bun:sqlite";

export interface User {
  id: string;
  email: string;
  name: string;
  instanceAdmin: boolean;
  createdAt: number;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  instance_admin: number;
  created_at: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    instanceAdmin: row.instance_admin === 1,
    createdAt: row.created_at,
  };
}

export function countUsers(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM users").get()?.n ?? 0;
}

export function getUser(db: Database, id: string): User | null {
  const row = db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  return row ? toUser(row) : null;
}

export function findUserByEmail(db: Database, email: string): User | null {
  const row = db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ?").get(email);
  return row ? toUser(row) : null;
}

export function createUser(
  db: Database,
  profile: { email: string; name: string; instanceAdmin: boolean },
): string {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, profile.email, profile.name, profile.instanceAdmin ? 1 : 0, Date.now());
  return id;
}
