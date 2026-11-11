import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { sessionHeaders } from "../../test-support/app-kit";
import { createOidcFake, type OidcFake } from "../../test-support/oidc-fake";
import { createUser } from "./api";

interface Begun {
  cookie: string;
  state: string;
  callback: string;
}

type App = ReturnType<typeof createApp>;
type Get = (path: string, headers?: Record<string, string>) => Response | Promise<Response>;
type Call = (
  method: string,
  path: string,
  headers: Record<string, string>,
  b?: string,
) => Promise<Response>;

interface OidcKit {
  origin: string;
  host: string;
  secret: string;
  fake: OidcFake;
  home: string;
  db: Database;
  app: App;
  get: Get;
  call: Call;
  sessionCookie: (res: Response) => string;
  providerId: string;
  adminHeaders: Record<string, string>;
  begin: () => Promise<Begun>;
  finish: (b: Begun, cookie?: string) => Response | Promise<Response>;
  refusedLogin: () => Promise<void>;
}

const origin = "http://localhost:4100";
const host = "localhost:4100";
const secret = "client-secret-value-123";

function makeApp(): { home: string; db: Database; app: App } {
  const home = mkdtempSync(join(tmpdir(), "oidc-test-"));
  const db = openDb(":memory:");
  migrate(db, migrations);
  const app = createApp({
    db,
    home,
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin },
    instanceId: "i",
    version: "1",
    trustProxy: true,
  });
  return { home, db, app };
}

function makeClient(app: App): { get: Get; call: Call; sessionCookie: (res: Response) => string } {
  // Each call looks like a different client, so the login rate limit does not throttle the table.
  let caller = 0;
  const get: Get = (path, headers = {}) =>
    app.request(path, {
      headers: { host, "x-forwarded-for": `10.0.0.${++caller % 250}.${caller}`, ...headers },
    });
  const call: Call = (method, path, headers, b) =>
    Promise.resolve(app.request(path, { method, headers, ...(b ? { body: b } : {}) }));
  const sessionCookie = (res: Response): string =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("harness_session="))
      ?.split(";")[0] ?? "";
  return { get, call, sessionCookie };
}

const countRows = (db: Database, table: "users" | "sessions"): number =>
  db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;

// Plays the browser: start, follow the provider's redirect, return what the callback would see.
async function beginLogin(get: Get, providerId: string): Promise<Begun> {
  const start = await get(`/api/auth/oidc/${providerId}/start`);
  expect(start.status).toBe(302);
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const back = new URL(authorize.headers.get("location") ?? "");
  return {
    cookie,
    state: back.searchParams.get("state") ?? "",
    callback: back.pathname + back.search,
  };
}

async function addFakeProvider(kit: OidcKit): Promise<void> {
  createUser(kit.db, { email: "owner@example.com", name: "Owner", instanceAdmin: false });
  kit.adminHeaders = (await sessionHeaders(kit.db, { admin: true, stepUp: true, origin })).headers;
  kit.fake.clientSecret = secret;
  const body = JSON.stringify({
    name: "Fake",
    issuer: kit.fake.issuer,
    clientId: kit.fake.clientId,
    clientSecret: secret,
  });
  const res = await kit.call("POST", "/api/auth/oidc/providers", kit.adminHeaders, body);
  expect(res.status).toBe(201);
  kit.providerId = ((await res.json()) as { id: string }).id;
}

// One fixture per test file: call at the top level so its beforeAll/afterAll belong to that file.
// providerId and adminHeaders are filled by beforeAll, so read them from the kit, never destructure them.
export function makeOidcKit(): OidcKit {
  const { home, db, app } = makeApp();
  const { get, call, sessionCookie } = makeClient(app);
  const kit: OidcKit = {
    origin,
    host,
    secret,
    fake: createOidcFake(),
    home,
    db,
    app,
    get,
    call,
    sessionCookie,
    providerId: "",
    adminHeaders: {},
    begin: () => beginLogin(get, kit.providerId),
    finish: (b, cookie = b.cookie) => get(b.callback, { cookie }),
    async refusedLogin() {
      const users = countRows(db, "users");
      const sessions = countRows(db, "sessions");
      const res = await kit.finish(await kit.begin());
      expect(res.status).toBe(401);
      expect(sessionCookie(res)).toBe("");
      expect(countRows(db, "users")).toBe(users);
      expect(countRows(db, "sessions")).toBe(sessions);
    },
  };
  beforeAll(() => addFakeProvider(kit));
  afterAll(() => kit.fake.stop());
  return kit;
}
