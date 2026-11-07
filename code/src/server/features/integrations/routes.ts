import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { deleteSecret, getSecret, setSecret } from "../agents/api";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { mintLocalLinkToken, revokeLocalLinkToken } from "../oauth/api";
import { getOrgBySlug, listOrgsForUser, type MemberRow, memberForUser } from "../orgs/api";
import {
  ConfigError,
  checkConfig,
  desktopConfigPath,
  isInstalled,
  isLinked,
  linkConfig,
  unlinkConfig,
} from "./desktop";

const TOKEN_SECRET = "desktop.token";

const STDIO_SCRIPT = join(dirname(import.meta.path), "../../../../scripts/mcp-stdio.ts");

function clearDesktopToken(db: Database, home: string): void {
  const token = getSecret(TOKEN_SECRET, home);
  if (token) revokeLocalLinkToken(db, token);
  deleteSecret(TOKEN_SECRET, home);
}

function pickMember(db: Database, userId: string, slug: string | undefined): MemberRow | null {
  const org = slug ? getOrgBySlug(db, slug) : listOrgsForUser(db, userId)[0];
  return org ? memberForUser(db, org.id, userId) : null;
}

export function integrationRoutes(db: Database, home: string, port: number): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/claude-desktop", (c) => {
    const path = desktopConfigPath();
    return c.json({ configPath: path, installed: isInstalled(path), linked: isLinked(path) });
  });

  app.post("/claude-desktop/link", requireStepUp, (c) => {
    const path = desktopConfigPath();
    const member = pickMember(db, c.get("actor").userId, c.req.query("org"));
    if (!member) return c.json({ error: "no org membership for this user" }, 400);
    try {
      checkConfig(path);
    } catch (error) {
      if (error instanceof ConfigError) return c.json({ error: error.message }, 409);
      throw error;
    }
    clearDesktopToken(db, home);
    const token = mintLocalLinkToken(db, member.id, member.orgId);
    try {
      setSecret(TOKEN_SECRET, token, home);
      linkConfig(path, {
        command: process.execPath,
        args: [STDIO_SCRIPT, "--home", home, "--port", String(port)],
      });
    } catch (error) {
      revokeLocalLinkToken(db, token);
      deleteSecret(TOKEN_SECRET, home);
      throw error;
    }
    return c.json({ configPath: path, linked: true, orgId: member.orgId });
  });

  app.delete("/claude-desktop/link", requireStepUp, (c) => {
    clearDesktopToken(db, home);
    const path = desktopConfigPath();
    try {
      unlinkConfig(path);
    } catch (error) {
      if (error instanceof ConfigError) return c.json({ error: error.message }, 409);
      throw error;
    }
    return c.json({ configPath: path, linked: false });
  });

  return app;
}
