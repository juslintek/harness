import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export function memoryRoutes(_db: Database, _home: string): Hono {
  return new Hono();
}
