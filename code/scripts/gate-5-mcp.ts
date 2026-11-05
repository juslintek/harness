// Assertions 8 and 9: a scripted OAuth client reaching the board and chat over /mcp/remote, and the
// Claude Desktop link writing and removing its entry in a temp config.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createUser } from "../src/server/features/auth/api";
import { createTask } from "../src/server/features/board/api";
import { listChannels } from "../src/server/features/chat/api";
import { createOrg, createProject, memberForUser } from "../src/server/features/orgs/api";
import type { World } from "./gate-5-checks";
import { stepUp } from "./gate-5-kit";

const REDIRECT = "https://claude.example/cb";

function pkce(): { verifier: string; challenge: string } {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return {
    verifier,
    challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
  };
}

interface Granted {
  token: string;
  redirectedState: string | null;
}

// Register, authorize, consent with a fresh passkey tap, exchange the code with the PKCE verifier.
async function oauthToken(w: World): Promise<Granted | null> {
  const { client } = w.inst;
  const resource = `${w.inst.origin}/mcp/remote`;
  const reg = await client.call("POST", "/oauth/register", {
    body: { client_name: "Gate client", redirect_uris: [REDIRECT] },
  });
  const clientId = ((await reg.json()) as { client_id?: string }).client_id ?? "";
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    state: "s1",
  });
  const authorize = await client.call("GET", `/oauth/authorize?${query}`);
  w.report.check(
    8,
    authorize.status === 302,
    `authorize hands over to the consent page (${authorize.status})`,
  );
  await stepUp(w.inst, w.admin.cookie);
  const consent = await client.call("POST", "/oauth/consent", {
    cookie: w.admin.cookie,
    body: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      org_id: w.orgId,
      granted: ["board", "chat"],
      state: "s1",
    },
  });
  if (consent.status !== 200) return null;
  const redirect = new URL(((await consent.json()) as { redirect: string }).redirect);
  const tokenRes = await client.call("POST", "/oauth/token", {
    form: true,
    body: {
      grant_type: "authorization_code",
      client_id: clientId,
      code: redirect.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource,
    },
  });
  if (tokenRes.status !== 200) return null;
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  return token ? { token, redirectedState: redirect.searchParams.get("state") } : null;
}

async function callTool(
  w: World,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const mcp = new Client({ name: "gate5", version: "0" });
  const host = new URL(w.inst.origin).host;
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${w.inst.port}/mcp/remote`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, host } },
    }),
  );
  try {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return { isError: result.isError === true, text };
  } finally {
    await mcp.close();
  }
}

export async function checkOauthAndMcp(w: World): Promise<void> {
  const { db } = w.inst;
  const project = createProject(db, { orgId: w.orgId, key: "gate", name: "Gate" });
  createTask(db, {
    projectId: project.id,
    title: "visible to the remote client",
    createdBy: w.adminMemberId,
  });
  const own = listChannels(db, w.adminMemberId)[0];
  const stranger = createUser(db, {
    email: "other@gate5.test",
    name: "Other",
    instanceAdmin: false,
  });
  const other = createOrg(db, {
    name: "Other org",
    slug: "other-org",
    ownerUserId: stranger,
    ownerName: "Other",
    ownerHandle: "other",
  });
  const foreign = listChannels(db, memberForUser(db, other.id, stranger)?.id ?? "")[0];
  const granted = await oauthToken(w);
  w.report.check(
    8,
    granted !== null && granted.redirectedState === "s1",
    "consent with step-up and PKCE exchange give a token",
  );
  if (granted === null || !own || !foreign) return;
  const board = await callTool(w, granted.token, "board_list", {});
  w.report.check(
    8,
    !board.isError && board.text.includes("visible to the remote client"),
    "board_list over /mcp/remote shows the board",
  );
  const post = await callTool(w, granted.token, "chat_post", {
    channel: own.id,
    body: "hello from the gate",
  });
  w.report.check(8, !post.isError, "chat_post into the granted org succeeds");
  const refused = await callTool(w, granted.token, "chat_post", {
    channel: foreign.id,
    body: "leak",
  });
  const leaked = db.query("SELECT 1 FROM messages WHERE body = 'leak'").get();
  w.report.check(
    8,
    refused.isError && leaked === null,
    "chat_post into another org's channel is refused and writes nothing",
  );
}

export async function checkDesktopLink(w: World): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gate5-desktop-"));
  const path = join(dir, "claude_desktop_config.json");
  const before = process.env.CLAUDE_DESKTOP_CONFIG;
  process.env.CLAUDE_DESKTOP_CONFIG = path;
  try {
    await stepUp(w.inst, w.admin.cookie);
    const link = await w.inst.client.call("POST", "/api/integrations/claude-desktop/link", {
      cookie: w.admin.cookie,
      body: {},
    });
    const linked = (await link.json()) as { configPath?: string; linked?: boolean };
    const entry = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> })
      : {};
    w.report.check(
      9,
      link.status === 200 && linked.configPath === path,
      "link answers with the temp config path, not the real one",
    );
    w.report.check(
      9,
      entry.mcpServers?.harness !== undefined,
      "the temp config holds the harness entry",
    );
    await stepUp(w.inst, w.admin.cookie);
    const unlink = await w.inst.client.call("DELETE", "/api/integrations/claude-desktop/link", {
      cookie: w.admin.cookie,
    });
    const after = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    w.report.check(
      9,
      unlink.status === 200 && after.mcpServers?.harness === undefined,
      "unlink removes the entry again",
    );
  } finally {
    if (before === undefined) delete process.env.CLAUDE_DESKTOP_CONFIG;
    else process.env.CLAUDE_DESKTOP_CONFIG = before;
  }
}
