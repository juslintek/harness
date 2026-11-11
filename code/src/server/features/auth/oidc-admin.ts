import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { z } from "zod";
import { deleteSecret, getSecret, setSecret } from "../agents/api";
import { type AuthEnv, requireInstanceAdmin, requireStepUp } from "./middleware";
import { isAllowedProviderUrl } from "./oidc";
import { deleteProvider, insertProvider, listProviders, type OidcProvider } from "./oidc-repo";
import { invalidBody, parseBody } from "./routes";

const providerBody = z.object({
  name: z.string().trim().min(1).max(80),
  issuer: z.string().max(300).refine(isAllowedProviderUrl),
  clientId: z.string().min(1).max(300),
  clientSecret: z.string().min(1).max(1000).optional(),
  enabled: z.boolean().default(true),
});

// hasSecret says whether one is stored; the value itself is never read back out.
const view = (p: OidcProvider, home: string): Record<string, unknown> => ({
  ...p,
  hasSecret: getSecret(`oidc.${p.id}`, home) !== undefined,
});

export function oidcAdminRoutes(app: Hono<AuthEnv>, db: Database, home: string): void {
  app.get("/oidc/providers", requireInstanceAdmin, requireStepUp, (c) =>
    c.json(listProviders(db).map((p) => view(p, home))),
  );
  app.post("/oidc/providers", requireInstanceAdmin, requireStepUp, async (c) => {
    const body = await parseBody(c, providerBody);
    if (!body) return invalidBody(c);
    const { clientSecret, ...fields } = body;
    const provider = insertProvider(db, fields);
    if (clientSecret) setSecret(`oidc.${provider.id}`, clientSecret, home);
    return c.json(view(provider, home), 201);
  });
  app.delete("/oidc/providers/:id", requireInstanceAdmin, requireStepUp, (c) => {
    const id = c.req.param("id");
    if (!deleteProvider(db, id)) return c.json({ error: "unknown provider" }, 404);
    deleteSecret(`oidc.${id}`, home);
    return c.json({ ok: true });
  });
}
