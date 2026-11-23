import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { accountUsageReport } from "./account-usage";
import { type AccountDeps, startAccountLogin, testAccount } from "./accounts-login";
import { AccountError, addAccount, removeAccount, setAccountEnabled } from "./accounts-ops";
import { getSpec, LoginError, listAccounts } from "./api";

// The label is display text only (the id names the directory), but it is still kept to a short,
// printable set so it cannot carry control characters into logs or the UI.
const addBody = z.object({ label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,63}$/) });
const patchBody = z.object({ enabled: z.boolean() });

async function respond(
  c: Context<AuthEnv>,
  run: () => unknown,
  status: 200 | 201 = 200,
): Promise<Response> {
  if (!getSpec(c.req.param("id") ?? "")) return c.json({ error: "unknown agent" }, 404);
  try {
    return c.json(await run(), status);
  } catch (err) {
    if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
    if (err instanceof LoginError) return c.json({ error: err.message }, 409);
    throw err;
  }
}

export function accountRoutes(db: Database, home: string, deps: AccountDeps = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/:id/accounts", (c) => respond(c, () => listAccounts(db, c.req.param("id"))));
  app.get("/:id/accounts/:acct/usage", async (c) => {
    const rawSince = c.req.query("since");
    const since = rawSince === undefined ? 0 : Number(rawSince);
    if (
      rawSince !== undefined &&
      (rawSince.trim() === "" || !Number.isInteger(since) || since < 0)
    ) {
      return c.json({ error: "invalid query" }, 400);
    }
    const { id, acct } = c.req.param();
    return respond(c, () => accountUsageReport(db, id, acct, since));
  });
  app.post("/:id/accounts", requireStepUp, async (c) => {
    const body = addBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid label" }, 400);
    return respond(
      c,
      () => addAccount(db, home, c.req.param("id"), body.data.label, deps.spec),
      201,
    );
  });
  app.patch("/:id/accounts/:acct", requireStepUp, async (c) => {
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { id, acct } = c.req.param();
    return respond(c, () => setAccountEnabled(db, id, acct, body.data.enabled));
  });
  app.delete("/:id/accounts/:acct", requireStepUp, (c) => {
    const { id, acct } = c.req.param();
    const how = {
      ...(deps.spec !== undefined && { spec: deps.spec }),
      ...(deps.run && { run: deps.run }),
    };
    return respond(c, () => removeAccount(db, home, id, acct, c.req.query("drain") === "1", how));
  });
  app.post("/:id/accounts/:acct/login", requireStepUp, (c) => {
    const { id, acct } = c.req.param();
    return respond(c, () => startAccountLogin(db, id, acct, deps));
  });
  app.post("/:id/accounts/:acct/test", requireStepUp, (c) => {
    const { id, acct } = c.req.param();
    return respond(c, () => testAccount(db, id, acct, deps));
  });
  return app;
}
