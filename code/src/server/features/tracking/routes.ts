import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/api";

export function trackingRoutes(_db: Database): Hono<AuthEnv> {
  return new Hono<AuthEnv>();
}
