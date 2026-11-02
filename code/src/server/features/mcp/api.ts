import type { Database } from "bun:sqlite";
import { createHandler, type McpDeps } from "./server";
import { mint, type RunIdentity, revoke, type TokenScope, verify } from "./tokens";

export type { McpDeps, TokenScope };

export function mintRunToken(
  db: Database,
  runId: string,
  scopes: TokenScope[],
  member?: { memberId: string; orgId: string },
): string {
  return mint(db, runId, scopes, member);
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
