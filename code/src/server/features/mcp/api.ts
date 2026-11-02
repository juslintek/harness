import type { Database } from "bun:sqlite";
import { createHandler } from "./server";
import { mint, type RunIdentity, revoke, type TokenScope, verify } from "./tokens";

export type { TokenScope };

export function mintRunToken(db: Database, runId: string, scopes: TokenScope[]): string {
  return mint(db, runId, scopes);
}

export function verifyRunToken(db: Database, token: string): RunIdentity | null {
  return verify(db, token);
}

export function revokeRunTokens(db: Database, runId: string): void {
  revoke(db, runId);
}

export function mcpHandler(
  db: Database,
  onReport: (runId: string, text: string) => void,
  port: number,
): (req: Request) => Promise<Response> {
  return createHandler(db, onReport, port);
}
