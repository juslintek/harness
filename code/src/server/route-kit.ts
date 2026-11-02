import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError, type z } from "zod";

export const notFound = (c: Context): Response => c.json({ error: "not_found" }, 404);
export const forbidden = (c: Context): Response => c.json({ error: "forbidden" }, 403);

// Returns the response to send when the body does not fit, so callers can `return` it as is.
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : c.json({ error: "invalid body" }, 400);
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T | Response {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success ? parsed.data : c.json({ error: "invalid query" }, 400);
}

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

// An explicit undefined must never overwrite a stored value in a patch.
export function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}

// Base for expected refusals that carry a message meant for the caller; routeError answers 400.
export class DomainError extends Error {}

function sqliteCode(err: Error): string {
  return err.name === "SQLiteError" ? String((err as Error & { code?: string }).code) : "";
}

// Domain functions signal bad input with a plain Error and the schema's UNIQUE and FK constraints
// back them up; anything else is a bug and stays a 500.
export function routeError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return err.getResponse();
  const code = sqliteCode(err);
  if (code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return c.json({ error: "conflict" }, 409);
  }
  if (code.startsWith("SQLITE_CONSTRAINT")) return c.json({ error: "invalid" }, 400);
  if (err instanceof DomainError || err.constructor === Error) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof ZodError) return c.json({ error: "invalid" }, 400);
  console.error("request failed", err);
  return c.json({ error: "internal" }, 500);
}
