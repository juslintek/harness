import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { sessionHeaders } from "../../test-support/app-kit";
import { getSecret } from "../agents/api";
import { wireChat } from "../chat/api";
import { mintLocalLinkToken, verifyAccessToken } from "../oauth/api";
import { createOrg, memberForUser } from "../orgs/api";
import { desktopConfigPath } from "./desktop";

const ORIGIN = "http://localhost:4100";
let dir: string;
let config: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-link-"));
  config = join(dir, "Claude", "claude_desktop_config.json");
  home = join(dir, "home");
  process.env.CLAUDE_DESKTOP_CONFIG = config;
});

afterEach(() => {
  delete process.env.CLAUDE_DESKTOP_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(opts: { admin?: boolean; stepUp?: boolean } = {}) {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const app = createApp({
    db,
    home,
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin: ORIGIN },
    instanceId: "i",
    version: "1",
  });
  const who = await sessionHeaders(db, { admin: true, stepUp: true, ...opts, origin: ORIGIN });
  const org = createOrg(db, {
    name: "acme",
    slug: "acme",
    ownerUserId: who.userId,
    ownerName: "acme",
    ownerHandle: "own-acme",
  });
  const call = (method: string, path = "/api/integrations/claude-desktop/link") =>
    app.request(path, { method, headers: who.headers });
  return { db, app, who, call, org };
}

const ours = (): { args: string[]; command: string } =>
  JSON.parse(readFileSync(config, "utf8")).mcpServers.harness;

test("a missing config file is created with only the harness entry", async () => {
  const { call } = await boot();
  const res = await call("POST");
  expect(res.status).toBe(200);
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  expect(Object.keys(parsed)).toEqual(["mcpServers"]);
  expect(Object.keys(parsed.mcpServers)).toEqual(["harness"]);
  expect(ours().command).toBe(process.execPath);
  expect(ours().args[0]).toMatch(/scripts\/mcp-stdio\.ts$/);
  expect(existsSync(ours().args[0] as string)).toBe(true);
  expect(ours().args.slice(1)).toEqual(["--home", home, "--port", "4100"]);
  expect(existsSync(`${config}.harness-backup`)).toBe(false);
});

test("other keys and servers survive, with the original kept as a backup", async () => {
  const { call } = await boot();
  const before = {
    theme: "dark",
    mcpServers: { other: { command: "x", args: ["a"], env: { K: "v" } } },
  };
  await Bun.write(config, JSON.stringify(before));
  await call("POST");
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  expect(parsed.theme).toBe("dark");
  expect(parsed.mcpServers.other).toEqual(before.mcpServers.other);
  expect(JSON.parse(readFileSync(`${config}.harness-backup`, "utf8"))).toEqual(before);
});

test("invalid JSON is a 409 and leaves the file and backups untouched", async () => {
  const { call } = await boot();
  await Bun.write(config, "{ not json");
  const res = await call("POST");
  expect(res.status).toBe(409);
  expect(readFileSync(config, "utf8")).toBe("{ not json");
  expect(existsSync(`${config}.harness-backup`)).toBe(false);
  expect(getSecret("desktop.token", home)).toBeUndefined();
});

test("linking twice leaves one entry, the first backup and one live token", async () => {
  const { call, db } = await boot();
  await Bun.write(config, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  await call("POST");
  const first = getSecret("desktop.token", home) as string;
  writeFileSync(`${config}.harness-backup`, "keep me");
  await call("POST");
  const second = getSecret("desktop.token", home) as string;
  expect(Object.keys(JSON.parse(readFileSync(config, "utf8")).mcpServers).sort()).toEqual([
    "harness",
    "other",
  ]);
  expect(readFileSync(`${config}.harness-backup`, "utf8")).toBe("keep me");
  expect(verifyAccessToken(db, first)).toBeNull();
  expect(verifyAccessToken(db, second)).not.toBeNull();
});

test("the token lives only in secrets.json, never in the config or a response", async () => {
  const { call, db } = await boot();
  const link = await call("POST");
  const status = await call("GET", "/api/integrations/claude-desktop");
  const token = getSecret("desktop.token", home) as string;
  expect(token.length).toBeGreaterThan(20);
  expect(verifyAccessToken(db, token)?.scopes).toEqual(["board", "chat"]);
  expect(readFileSync(config, "utf8")).not.toContain(token);
  expect(await link.text()).not.toContain(token);
  expect(await status.text()).not.toContain(token);
  expect(statSync(join(home, "secrets.json")).mode & 0o777).toBe(0o600);
});

test("status reports path, installed and linked", async () => {
  const { call } = await boot();
  const path = "/api/integrations/claude-desktop";
  const before = await (await call("GET", path)).json();
  expect(before).toEqual({ configPath: config, installed: false, linked: false });
  await call("POST");
  expect(await (await call("GET", path)).json()).toEqual({
    configPath: config,
    installed: true,
    linked: true,
  });
});

test("unlink removes only harness, revokes the token and deletes the secret", async () => {
  const { call, db } = await boot();
  await Bun.write(config, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  await call("POST");
  const token = getSecret("desktop.token", home) as string;
  const res = await call("DELETE");
  expect(res.status).toBe(200);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
    mcpServers: { other: { command: "x" } },
  });
  expect(verifyAccessToken(db, token)).toBeNull();
  expect(getSecret("desktop.token", home)).toBeUndefined();
});

test("a non-admin and a session without step-up are refused", async () => {
  const plain = await boot({ admin: false });
  expect((await plain.call("POST")).status).toBe(403);
  expect((await plain.call("GET", "/api/integrations/claude-desktop")).status).toBe(403);
  const stale = await boot({ stepUp: false });
  expect((await stale.call("POST")).status).toBe(403);
  expect((await stale.call("DELETE")).status).toBe(403);
  expect(existsSync(config)).toBe(false);
});

test("an admin with no org membership gets a 400", async () => {
  const { call, db } = await boot();
  db.query("DELETE FROM members").run();
  expect((await call("POST")).status).toBe(400);
});

test("the config path follows the platform unless overridden", () => {
  expect(desktopConfigPath({}, "darwin")).toMatch(
    /Library\/Application Support\/Claude\/claude_desktop_config\.json$/,
  );
  expect(desktopConfigPath({ APPDATA: "C:\\A" }, "win32")).toContain("Claude");
  expect(desktopConfigPath({}, "linux")).toMatch(/\.config\/Claude\/claude_desktop_config\.json$/);
  expect(desktopConfigPath({ CLAUDE_DESKTOP_CONFIG: "/x/y.json" }, "darwin")).toBe("/x/y.json");
});

test.each([false, true])(
  "relink and unlink revoke the stored token across admins: %s",
  async (otherAdmin) => {
    const { app, who, call, db, org } = await boot();
    expect((await call("POST")).status).toBe(200);
    const first = getSecret("desktop.token", home) as string;
    const next = otherAdmin
      ? await sessionHeaders(db, { admin: true, stepUp: true, origin: ORIGIN })
      : who;
    const secondOrg = createOrg(db, {
      name: "second",
      slug: "second",
      ownerUserId: next.userId,
      ownerName: "Second",
      ownerHandle: "second",
    });
    const member = memberForUser(db, secondOrg.id, next.userId);
    if (!member) throw new Error("missing second member");
    const independent = mintLocalLinkToken(db, member.id, secondOrg.id);
    const relink = await app.request("/api/integrations/claude-desktop/link?org=second", {
      method: "POST",
      headers: next.headers,
    });
    expect(relink.status).toBe(200);
    const second = getSecret("desktop.token", home) as string;
    expect(verifyAccessToken(db, first)).toBeNull();
    expect(verifyAccessToken(db, second)?.orgId).toBe(secondOrg.id);
    expect(verifyAccessToken(db, independent)).not.toBeNull();
    // The original admin may have no membership in the linked token's organization.
    expect((await call("DELETE")).status).toBe(200);
    expect(verifyAccessToken(db, second)).toBeNull();
    expect(verifyAccessToken(db, independent)).not.toBeNull();
    expect(getSecret("desktop.token", home)).toBeUndefined();
    expect(org.id).not.toBe(secondOrg.id);
  },
);
