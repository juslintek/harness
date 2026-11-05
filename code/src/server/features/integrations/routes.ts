import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { deleteSecret, setSecret } from "../agents/api";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { mintLocalLinkToken, revokeLocalLinkTokens } from "../oauth/api";
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

function ownMembers(db: Database, userId: string): MemberRow[] {
  return listOrgsForUser(db, userId).flatMap((org) => memberForUser(db, org.id, userId) ?? []);
}

function pickMember(db: Database, userId: string, slug: string | undefined): MemberRow | null {
  const org = slug ? getOrgBySlug(db, slug) : listOrgsForUser(db, userId)[0];
  return org ? memberForUser(db, org.id, userId) : null;
}

export function integrationRoutes(db: Database, home: string): Hono<AuthEnv> {
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
    // One live token at a time, so a repeated link does not leave older ones valid.
    revokeLocalLinkTokens(db, member.id);
    setSecret(TOKEN_SECRET, mintLocalLinkToken(db, member.id, member.orgId), home);
    try {
      linkConfig(path, { command: process.execPath, args: [STDIO_SCRIPT, "--home", home] });
    } catch (error) {
      revokeLocalLinkTokens(db, member.id);
      deleteSecret(TOKEN_SECRET, home);
      throw error;
    }
    return c.json({ configPath: path, linked: true, orgId: member.orgId });
  });

  app.delete("/claude-desktop/link", requireStepUp, (c) => {
    for (const member of ownMembers(db, c.get("actor").userId)) {
      revokeLocalLinkTokens(db, member.id);
    }
    deleteSecret(TOKEN_SECRET, home);
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
