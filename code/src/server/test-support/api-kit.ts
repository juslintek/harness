import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/db";
import { migrations } from "../db/migrations";
import { wireChat } from "../features/chat/api";
import { addHumanMember, createOrg, type MemberRow, type Role } from "../features/orgs/api";
import { createApp } from "../http";
import { type SessionOpts, sessionHeaders } from "./app-kit";

const PORT: number = 4100;
const ORIGIN: string = `http://localhost:${PORT}`;

interface Who {
  headers: Record<string, string>;
  userId: string;
}

export interface ApiKit {
  db: Database;
  app: ReturnType<typeof createApp>;
  user: (opts?: SessionOpts) => Promise<Who>;
  call: (who: Who, method: string, path: string, body?: unknown) => Promise<Response>;
  // Creates an org straight in the db with `owner` as its owner and returns its slug and id.
  org: (owner: Who, slug: string) => { id: string; slug: string; owner: MemberRow };
  join: (orgId: string, who: Who, role: Role, handle: string) => MemberRow;
}

export function bootApi(home = "/unused"): ApiKit {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const app = createApp({
    db,
    home,
    port: PORT,
    rp: { id: "localhost", name: "Harness", origin: ORIGIN },
    instanceId: "i",
    version: "1",
  });
  return {
    db,
    app,
    user: (opts = {}) => sessionHeaders(db, { ...opts, origin: ORIGIN }),
    call: (who, method, path, body) =>
      Promise.resolve(
        app.request(path, {
          method,
          headers: who.headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    org: (owner, slug) => {
      const org = createOrg(db, {
        name: slug,
        slug,
        ownerUserId: owner.userId,
        ownerName: slug,
        ownerHandle: `own-${slug}`,
      });
      const member = db
        .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
        .get(org.id);
      return { id: org.id, slug, owner: { id: member?.id } as MemberRow };
    },
    join: (orgId, who, role, handle) => addHumanMember(db, orgId, who.userId, handle, handle, role),
  };
}
