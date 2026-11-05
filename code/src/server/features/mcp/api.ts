import type { Database } from "bun:sqlite";
import { createRemoteHandler } from "./remote";
import { createHandler, type McpDeps } from "./server";
import {
  mint,
  type RunIdentity,
  revoke,
  type TokenHolder,
  type TokenScope,
  verify,
} from "./tokens";
import type { RemoteDeps } from "./tools-remote";

export type { McpDeps, TokenScope };

export function mintRunToken(
  db: Database,
  runId: string,
  scopes: TokenScope[],
  holder?: TokenHolder,
): string {
  return mint(db, runId, scopes, holder);
}

export function verifyRunToken(db: Database, token: string): RunIdentity | null {
  return verify(db, token);
}

export function revokeRunTokens(db: Database, runId: string): void {
  revoke(db, runId);
}

export function mcpHandler(
  db: Database,
  deps: McpDeps,
  port: number,
): (req: Request) => Promise<Response> {
  return createHandler(db, deps, port);
}

export function remoteMcpHandler(
  db: Database,
  deps: RemoteDeps,
  origin: string,
): (req: Request) => Promise<Response> {
  return createRemoteHandler(db, deps, origin);
}
