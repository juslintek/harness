import type { Database } from "bun:sqlite";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyLocalLinkToken, verifyRemoteAccessToken } from "../oauth/api";
import { buildRemoteServer, type RemoteDeps } from "./tools-remote";

function bearer(req: Request): string | null {
  return /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
}

// Only an OAuth access token opens this: a run token hashes to nothing in the OAuth store, and the
// loopback /mcp likewise knows nothing of OAuth tokens. The host check lives in hostGuard.
function createOAuthHandler(
  db: Database,
  deps: RemoteDeps,
  authenticate: typeof verifyRemoteAccessToken,
  metadata: string | null,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    const token = bearer(req);
    const who = token ? authenticate(db, token) : null;
    if (!token || !who) {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": metadata ? `Bearer resource_metadata="${metadata}"` : "Bearer",
        },
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildRemoteServer(db, token, who, deps);
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  };
}

export function createRemoteHandler(
  db: Database,
  deps: RemoteDeps,
  origin: string,
): (req: Request) => Promise<Response> {
  return createOAuthHandler(
    db,
    deps,
    verifyRemoteAccessToken,
    `${origin}/.well-known/oauth-protected-resource/mcp/remote`,
  );
}

export function createLocalHandler(
  db: Database,
  deps: RemoteDeps,
): (req: Request) => Promise<Response> {
  return createOAuthHandler(db, deps, verifyLocalLinkToken, null);
}
