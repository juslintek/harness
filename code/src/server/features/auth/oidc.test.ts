import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionHeaders } from "../../test-support/app-kit";
import type { OidcFake } from "../../test-support/oidc-fake";
import { takePending } from "./oidc";
import { makeOidcKit } from "./oidc-kit";

const kit = makeOidcKit();
const { fake, db, home, call, get, begin, finish, refusedLogin, sessionCookie } = kit;

describe("oidc login", () => {
  test("the matching user gets a session cookie, the client secret is sent", async () => {
    fake.claims = {};
    const res = await finish(await begin());
    expect(res.status).toBe(302);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe("");
    const me = await get("/api/auth/me", { cookie });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("owner@example.com");
    expect(fake.tokenRequests.at(-1)?.get("client_secret")).toBe(kit.secret);
  });

  test("an RS256 token is accepted and the session cannot step up", async () => {
    fake.alg = "RS256";
    const res = await finish(await begin());
    fake.alg = "ES256";
    expect(res.status).toBe(302);
    const cookie = sessionCookie(res);
    const me = (await (await get("/api/auth/me", { cookie })).json()) as {
      session: { method: string; stepUpFresh: boolean };
    };
    expect(me.session).toMatchObject({ method: "email", stepUpFresh: false });
  });
});

describe("oidc login refusals", () => {
  const now = Math.floor(Date.now() / 1000);
  const refused: [string, Partial<Pick<OidcFake, "claims" | "alg" | "signer">>][] = [
    ["wrong nonce", { claims: { nonce: "other" } }],
    ["wrong audience", { claims: { aud: "someone-else" } }],
    ["audience list without azp", { claims: { aud: [fake.clientId, "x"] } }],
    ["wrong issuer", { claims: { iss: "http://evil.example" } }],
    ["expired", { claims: { exp: now - 3600 } }],
    ["not yet valid", { claims: { nbf: now + 3600 } }],
    ["unverified email", { claims: { email_verified: false } }],
    ["email_verified as a string", { claims: { email_verified: "true" } }],
    ["no email", { claims: { email: undefined } }],
    ["unknown email", { claims: { email: "nobody@example.com" } }],
    ["bad signature", { signer: "stranger" }],
    ["alg none", { alg: "none" }],
    ["alg HS256", { alg: "HS256" }],
  ];
  for (const [name, tweak] of refused) {
    test(`${name} is refused and creates nothing`, async () => {
      Object.assign(fake, tweak);
      try {
        await refusedLogin();
      } finally {
        fake.claims = {};
        fake.alg = "ES256";
        fake.signer = "jwks";
      }
    });
  }
});

describe("oidc state handling", () => {
  test("a replayed callback is refused", async () => {
    const b = await begin();
    expect((await finish(b)).status).toBe(302);
    expect((await finish(b)).status).toBe(401);
  });

  test("the state of another start is refused", async () => {
    const first = await begin();
    const second = await begin();
    const mixed = `${first.callback.split("?")[0]}?code=${new URL(`http://x${first.callback}`).searchParams.get("code")}&state=${second.state}`;
    expect((await get(mixed, { cookie: second.cookie })).status).toBe(401);
    expect((await finish(first, second.cookie)).status).toBe(401);
  });

  test("a callback without the browser cookie is refused", async () => {
    expect((await finish(await begin(), "")).status).toBe(401);
  });

  test("a pending login expires after ten minutes", async () => {
    const b = await begin();
    expect(takePending(b.state, Date.now() + 11 * 60_000)).toBeNull();
  });
});

const body = JSON.stringify({ name: "Other", issuer: "https://idp.example.com", clientId: "c" });

describe("oidc provider admin", () => {
  test("config routes need an instance admin with a fresh step-up", async () => {
    const plain = (await sessionHeaders(db, { stepUp: true, origin: kit.origin })).headers;
    const noStepUp = (await sessionHeaders(db, { admin: true, origin: kit.origin })).headers;
    for (const [method, path] of [
      ["GET", "/api/auth/oidc/providers"],
      ["POST", "/api/auth/oidc/providers"],
      ["DELETE", `/api/auth/oidc/providers/${kit.providerId}`],
    ] as const) {
      expect((await call(method, path, plain, body)).status).toBe(403);
      expect((await call(method, path, noStepUp, body)).status).toBe(403);
      expect((await call(method, path, { host: kit.host, origin: kit.origin }, body)).status).toBe(
        401,
      );
    }
    expect(
      db.query("SELECT 1 FROM oidc_providers WHERE id = ?").get(kit.providerId),
    ).not.toBeNull();
  });

  test("the client secret is in no response and not in the db", async () => {
    const list = await (await call("GET", "/api/auth/oidc/providers", kit.adminHeaders)).text();
    expect(list).not.toContain(kit.secret);
    expect(list).toContain('"hasSecret":true');
    const rows = JSON.stringify(db.query("SELECT * FROM oidc_providers").all());
    expect(rows).not.toContain(kit.secret);
    expect(readFileSync(join(home, "secrets.json"), "utf8")).toContain(`oidc.${kit.providerId}`);
  });
});

describe("oidc provider config", () => {
  test("provider urls must be https, or http on loopback", async () => {
    const plainHttp = JSON.stringify({
      name: "x",
      issuer: "http://idp.example.com",
      clientId: "c",
    });
    expect(
      (await call("POST", "/api/auth/oidc/providers", kit.adminHeaders, plainHttp)).status,
    ).toBe(400);
    expect((await call("POST", "/api/auth/oidc/providers", kit.adminHeaders, body)).status).toBe(
      201,
    );
  });

  test("the public list has id and name only, and a disabled provider cannot start", async () => {
    const list = (await (await get("/api/auth/oidc/providers/public")).json()) as object[];
    expect(list).toContainEqual({ id: kit.providerId, name: "Fake" });
    expect(list.every((p) => Object.keys(p).sort().join() === "id,name")).toBe(true);
    db.query("UPDATE oidc_providers SET enabled = 0 WHERE id = ?").run(kit.providerId);
    expect((await get(`/api/auth/oidc/${kit.providerId}/start`)).status).toBe(404);
    db.query("UPDATE oidc_providers SET enabled = 1 WHERE id = ?").run(kit.providerId);
  });

  test("a provider that answers discovery with a redirect is not followed", async () => {
    const row = db
      .query<{ id: string }, [string]>(
        "INSERT INTO oidc_providers (id, name, issuer, client_id, enabled, created_at) VALUES ('redir', 'R', ?, 'c', 1, 1) RETURNING id",
      )
      .get(`${fake.issuer}/redirecting`);
    expect((await get(`/api/auth/oidc/${row?.id}/start`)).status).toBe(502);
  });

  test("deleting a provider removes its secret", async () => {
    const res = await call(
      "DELETE",
      `/api/auth/oidc/providers/${kit.providerId}`,
      kit.adminHeaders,
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(home, "secrets.json"), "utf8")).not.toContain(
      `oidc.${kit.providerId}`,
    );
  });
});
