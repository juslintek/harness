import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OrgView } from "../../../shared/orgs";
import type { openDb } from "../../db/db";
import { budgetGate } from "../budgets/api";
import { wireChat } from "../chat/api";
import {
  addAgentMember,
  createOrg,
  createProject,
  type MemberRow,
  type ProjectRow,
} from "../orgs/api";
import { addEstimate, taskTrackingFields } from "../tracking/api";
import { type McpDeps, mcpHandler, mintRunToken, type TokenScope } from "./api";

export const trackingPort: McpDeps["tracking"] = {
  addEstimate,
  taskFields: taskTrackingFields,
  budgetState: (db, memberId) => budgetGate(db, memberId).state,
};

export type Db = ReturnType<typeof openDb>;

export const ALL: TokenScope[] = ["report", "guard_hook", "board", "chat"];

export async function listen(
  database: Db,
  harnessHome = "/Users/x/.harness",
): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const own: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch: (req) =>
        mcpHandler(
          database,
          { onReport: () => {}, harnessHome, tracking: trackingPort },
          own.port as number,
        )(req),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${own.port}/`, {
        method: "POST",
        keepalive: false,
      });
      if (res.status === 401) return own;
    } catch {
      // port unreachable, try another
    }
    await own.stop(true);
  }
  throw new Error("no loopback port became reachable");
}

export interface World {
  a: OrgView;
  b: OrgView;
  agent: (orgId: string, handle: string) => MemberRow;
  project: ProjectRow;
  projectB: ProjectRow;
}

export function world(database: Db): World {
  const org = (slug: string, handle: string) =>
    createOrg(database, {
      name: slug,
      slug,
      ownerUserId: handle,
      ownerName: handle,
      ownerHandle: handle,
    });
  const a = org("acme", "owner");
  const b = org("beta", "boss");
  wireChat(database);
  const agent = (orgId: string, handle: string) =>
    addAgentMember(database, orgId, { agentId: "x", handle, displayName: handle, specialties: [] });
  const project = createProject(database, { orgId: a.id, key: "web", name: "Web" });
  const projectB = createProject(database, { orgId: b.id, key: "web", name: "Web B" });
  return { a, b, agent, project, projectB };
}

export function tokenFor(
  db: Db,
  memberId: string,
  orgId: string,
  scopes: TokenScope[] = ALL,
): string {
  return mintRunToken(db, Bun.randomUUIDv7(), scopes, { memberId, orgId });
}

export async function call(
  server: ReturnType<typeof Bun.serve>,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  return { isError: result.isError === true, text };
}
