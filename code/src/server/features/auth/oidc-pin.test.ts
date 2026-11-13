import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { sessionHeaders } from "../../test-support/app-kit";
import { createOidcFake } from "../../test-support/oidc-fake";
import { createUser } from "./api";
import { makeOidcKit } from "./oidc-kit";

const kit = makeOidcKit();
const { fake, db, app, call, finish, begin, sessionCookie } = kit;

describe("oidc identity pinning", () => {
  const email = "pin@example.com";
  const loginAs = async (claims: Record<string, unknown>): Promise<Response> => {
    fake.claims = { email, ...claims };
    const res = await finish(await begin());
    fake.claims = {};
    return res;
  };

  test("the first login pins the sub and a different sub for the same email is refused", async () => {
    createUser(db, { email, name: "Pin", instanceAdmin: false });
    expect((await loginAs({ sub: "pin-1" })).status).toBe(302);
    const other = await loginAs({ sub: "pin-2" });
    expect(other.status).toBe(401);
    expect(sessionCookie(other)).toBe("");
    expect((await loginAs({ sub: "pin-1" })).status).toBe(302);
  });

  test("the same sub through another provider entry of the same issuer is the same pin", async () => {
    const created = await app.request("/api/auth/oidc/providers", {
      method: "POST",
      headers: kit.adminHeaders,
      body: JSON.stringify({
        name: "Second",
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret: kit.secret,
      }),
    });
    const secondId = ((await created.json()) as { id: string }).id;
    const first = kit.providerId;
    kit.providerId = secondId;
    const same = await loginAs({ sub: "pin-1" });
    const other = await loginAs({ sub: "pin-2" });
    kit.providerId = first;
    expect(same.status).toBe(302);
    expect(other.status).toBe(401);
  });

  test("an existing user without a pin is pinned on the next login", async () => {
    db.query("DELETE FROM oidc_identities").run();
    expect((await loginAs({ sub: "late-1" })).status).toBe(302);
    expect((await loginAs({ sub: "pin-1" })).status).toBe(401);
  });
});

const loginWith = async (claims: Record<string, unknown>): Promise<Response> => {
  fake.claims = claims;
  const res = await finish(await begin());
  fake.claims = {};
  return res;
};

describe("oidc pin across issuers", () => {
  const loginAs = loginWith;

  test("a pin from issuer X refuses a login through issuer Y with the same sub", async () => {
    const other = createOidcFake("other-client");
    other.clientSecret = kit.secret;
    const created = await app.request("/api/auth/oidc/providers", {
      method: "POST",
      headers: kit.adminHeaders,
      body: JSON.stringify({
        name: "Other issuer",
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: kit.secret,
      }),
    });
    expect(created.status).toBe(201);
    createUser(db, { email: "xissuer@example.com", name: "X issuer", instanceAdmin: false });
    createUser(db, { email: "xfresh@example.com", name: "X fresh", instanceAdmin: false });
    expect((await loginAs({ email: "xissuer@example.com", sub: "shared-sub" })).status).toBe(302);
    const first = kit.providerId;
    kit.providerId = ((await created.json()) as { id: string }).id;
    // Control: the second provider works for a user with no pin, so the refusal below is the pin.
    other.claims = { email: "xfresh@example.com", sub: "fresh-sub" };
    const control = await finish(await begin());
    other.claims = { email: "xissuer@example.com", sub: "shared-sub" };
    const crossed = await finish(await begin());
    other.stop();
    expect(control.status).toBe(302);
    kit.providerId = first;
    expect(crossed.status).toBe(401);
    expect(sessionCookie(crossed)).toBe("");
  });
});

describe("oidc pin uniqueness", () => {
  const loginAs = loginWith;

  test("a second user cannot pin an issuer and sub that is already pinned", async () => {
    createUser(db, { email: "uniq-a@example.com", name: "A", instanceAdmin: false });
    createUser(db, { email: "uniq-b@example.com", name: "B", instanceAdmin: false });
    expect((await loginAs({ email: "uniq-a@example.com", sub: "uniq-1" })).status).toBe(302);
    const second = await loginAs({ email: "uniq-b@example.com", sub: "uniq-1" });
    expect(second.status).toBe(401);
    expect(sessionCookie(second)).toBe("");
    const pins = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM oidc_identities WHERE sub = ?")
      .get("uniq-1");
    expect(pins?.n).toBe(1);
    const b = db
      .query<{ id: string }, []>("SELECT id FROM users WHERE email = 'uniq-b@example.com'")
      .get();
    expect(() =>
      db
        .query(
          "INSERT INTO oidc_identities (user_id, issuer, sub, created_at) VALUES (?, ?, 'uniq-1', 1)",
        )
        .run(b?.id as string, fake.issuer),
    ).toThrow(/UNIQUE/);
  });
});

describe("oidc pin survives provider delete and re-add", () => {
  const email = "readd@example.com";
  const loginAs = async (sub: string): Promise<Response> => {
    fake.claims = { email, sub };
    const res = await finish(await begin());
    fake.claims = {};
    return res;
  };

  test("same issuer and sub still works, another sub is refused", async () => {
    createUser(db, { email, name: "Readd", instanceAdmin: false });
    expect((await loginAs("readd-1")).status).toBe(302);
    expect(
      (await call("DELETE", `/api/auth/oidc/providers/${kit.providerId}`, kit.adminHeaders)).status,
    ).toBe(200);
    const created = await app.request("/api/auth/oidc/providers", {
      method: "POST",
      headers: kit.adminHeaders,
      body: JSON.stringify({
        name: "Fake",
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret: kit.secret,
      }),
    });
    kit.providerId = ((await created.json()) as { id: string }).id;
    expect((await loginAs("readd-1")).status).toBe(302);
    expect((await loginAs("readd-2")).status).toBe(401);
  });
});

describe("oidc pin admin routes", () => {
  const email = "pinadmin@example.com";
  let userId = "";
  const loginAs = async (sub: string): Promise<Response> => {
    fake.claims = { email, sub };
    const res = await finish(await begin());
    fake.claims = {};
    return res;
  };

  test("list and delete need an instance admin with a fresh step-up", async () => {
    userId = createUser(db, { email, name: "Pin admin", instanceAdmin: false });
    expect((await loginAs("padm-1")).status).toBe(302);
    const path = `/api/auth/oidc/users/${userId}/identity`;
    const plain = (await sessionHeaders(db, { stepUp: true, origin: kit.origin })).headers;
    const noStepUp = (await sessionHeaders(db, { admin: true, origin: kit.origin })).headers;
    for (const method of ["GET", "DELETE"]) {
      expect((await call(method, path, plain)).status).toBe(403);
      expect((await call(method, path, noStepUp)).status).toBe(403);
      expect((await call(method, path, { host: kit.host, origin: kit.origin })).status).toBe(401);
    }
    expect((await loginAs("padm-2")).status).toBe(401);
  });

  test("an admin lists the pin and deleting it lets the user pin again", async () => {
    const path = `/api/auth/oidc/users/${userId}/identity`;
    const listed = (await (await call("GET", path, kit.adminHeaders)).json()) as { sub: string }[];
    expect(listed.map((p) => p.sub)).toEqual(["padm-1"]);
    expect((await call("DELETE", path, kit.adminHeaders)).status).toBe(200);
    expect((await call("DELETE", path, kit.adminHeaders)).status).toBe(404);
    expect(((await (await call("GET", path, kit.adminHeaders)).json()) as unknown[]).length).toBe(
      0,
    );
    expect((await loginAs("padm-2")).status).toBe(302);
    expect((await loginAs("padm-1")).status).toBe(401);
  });
});

describe("migration 038", () => {
  test("pins carry the provider's issuer and pins of deleted providers are dropped", () => {
    const old = openDb(":memory:");
    migrate(
      old,
      migrations.filter((m) => m.version <= 36),
    );
    for (const id of ["a", "b"]) {
      createUser(old, { email: `${id}@example.com`, name: id, instanceAdmin: false });
    }
    const [a, b] = old.query<{ id: string }, []>("SELECT id FROM users ORDER BY email").all();
    old
      .query(
        "INSERT INTO oidc_providers (id, name, issuer, client_id, created_at) VALUES ('p1', 'P', 'https://idp.example.com', 'c', 1)",
      )
      .run();
    for (const [user, provider] of [
      [a?.id, "p1"],
      [b?.id, "gone"],
    ]) {
      old
        .query(
          "INSERT INTO oidc_identities (user_id, provider_id, sub, created_at) VALUES (?, ?, 's', 1)",
        )
        .run(user as string, provider as string);
    }
    migrate(old, migrations);
    const rows = old
      .query<{ user_id: string; issuer: string }, []>("SELECT user_id, issuer FROM oidc_identities")
      .all();
    expect(rows).toEqual([{ user_id: a?.id as string, issuer: "https://idp.example.com" }]);
  });
});
