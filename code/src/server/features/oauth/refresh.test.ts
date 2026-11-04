import { expect, test } from "bun:test";
import { Hono } from "hono";
import { verifyAccessToken } from "./api";
import { oauthPublicRoutes } from "./routes";
import { bootOauth, ORIGIN, pkce, REDIRECT } from "./test-kit";

interface Tokens {
  access_token: string;
  refresh_token: string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function started(): Promise<{
  kit: Awaited<ReturnType<typeof bootOauth>>;
  clientId: string;
  tokens: Tokens;
  refresh: (token: string) => Promise<Response>;
}> {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const { verifier, challenge } = pkce();
  const code = await kit.authorize(clientId, challenge);
  const tokens = (await (await kit.exchange(clientId, code, verifier)).json()) as Tokens;
  const refresh = (token: string): Promise<Response> =>
    kit.post(
      "/oauth/token",
      { grant_type: "refresh_token", client_id: clientId, refresh_token: token },
      true,
    );
  return { kit, clientId, tokens, refresh };
}

test("refresh rotates: the old token reused revokes the whole family, new tokens included", async () => {
  const { kit, tokens, refresh } = await started();
  const rotated = await refresh(tokens.refresh_token);
  expect(rotated.status).toBe(200);
  const next = (await rotated.json()) as Tokens;
  expect(next.refresh_token).not.toBe(tokens.refresh_token);
  expect(verifyAccessToken(kit.api.db, next.access_token)).not.toBeNull();
  const replay = await refresh(tokens.refresh_token);
  expect(replay.status).toBe(400);
  expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
  expect(verifyAccessToken(kit.api.db, next.access_token)).toBeNull();
  expect(verifyAccessToken(kit.api.db, tokens.access_token)).toBeNull();
  expect((await refresh(next.refresh_token)).status).toBe(400);
});

test("a refresh token cannot be used by another client or as an access token", async () => {
  const { kit, tokens } = await started();
  const other = await kit.register();
  const res = await kit.post(
    "/oauth/token",
    { grant_type: "refresh_token", client_id: other, refresh_token: tokens.refresh_token },
    true,
  );
  expect(res.status).toBe(400);
  expect(verifyAccessToken(kit.api.db, tokens.refresh_token)).toBeNull();
});

test("a removed member gets no new tokens from a refresh", async () => {
  const { kit, tokens, refresh } = await started();
  kit.api.db.query("DELETE FROM members WHERE id = ?").run(kit.org.owner.id);
  expect((await refresh(tokens.refresh_token)).status).toBe(400);
});

test("an unsupported grant type is refused", async () => {
  const kit = await bootOauth();
  const res = await kit.post("/oauth/token", { grant_type: "password" }, true);
  expect(((await res.json()) as { error: string }).error).toBe("unsupported_grant_type");
});

test("codes live 60 s, access tokens 1 h, refresh tokens 30 d (injected clock)", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  let clock = Date.now();
  const app = new Hono().route(
    "/",
    oauthPublicRoutes({ db: kit.api.db, origin: ORIGIN, now: () => clock }),
  );
  const form = (body: Record<string, string>): Promise<Response> =>
    Promise.resolve(
      app.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      }),
    );
  const exchange = (code: string, verifier: string): Promise<Response> =>
    form({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
  const late = pkce();
  const lateCode = await kit.authorize(clientId, late.challenge);
  clock += 61_000;
  const expired = await exchange(lateCode, late.verifier);
  expect(((await expired.json()) as { error: string }).error).toBe("invalid_grant");

  const fresh = pkce();
  const code = await kit.authorize(clientId, fresh.challenge);
  clock = Date.now() + 59_000;
  const res = await exchange(code, fresh.verifier);
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as Tokens;
  expect(verifyAccessToken(kit.api.db, tokens.access_token, clock + HOUR - 1)).not.toBeNull();
  expect(verifyAccessToken(kit.api.db, tokens.access_token, clock + HOUR + 1)).toBeNull();
  clock += 31 * DAY;
  const old = await form({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
  });
  expect(old.status).toBe(400);
});
