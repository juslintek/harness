import { expect, test } from "bun:test";
import { verifyAccessToken } from "./api";
import { bootOauth, flow, ORIGIN, pkce, REDIRECT, RESOURCE, type Tokens } from "./test-kit";

test("metadata documents advertise S256, both grants and the exact endpoints", async () => {
  const { get } = await bootOauth();
  const as = (await (await get("/.well-known/oauth-authorization-server")).json()) as Record<
    string,
    unknown
  >;
  expect(as.issuer).toBe(ORIGIN);
  expect(as.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
  expect(as.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
  expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  const pr = (await (
    await get("/.well-known/oauth-protected-resource/mcp/remote")
  ).json()) as Record<string, unknown>;
  expect(pr.resource).toBe(RESOURCE);
  expect(pr.authorization_servers).toEqual([ORIGIN]);
});

test("public endpoints still pass the host guard", async () => {
  const { api } = await bootOauth();
  const res = await api.app.request("/.well-known/oauth-authorization-server", {
    headers: { host: "evil.example" },
  });
  expect(res.status).toBe(403);
});

test("registration refuses http origins, non-loopback http, fragments and more than five uris", async () => {
  const { post } = await bootOauth();
  for (const uris of [
    ["http://evil.example/cb"],
    ["http://localhost/cb"],
    ["https://ok.example/cb#frag"],
    ["javascript:alert(1)"],
    Array.from({ length: 6 }, (_, i) => `https://ok.example/${i}`),
    [],
  ]) {
    const res = await post("/oauth/register", { redirect_uris: uris });
    expect(res.status).toBe(400);
  }
  const ok = await post("/oauth/register", {
    redirect_uris: ["http://127.0.0.1:8123/cb", "https://ok.example/cb"],
  });
  expect(ok.status).toBe(201);
});

test("the full flow yields working tokens with the granted scopes", async () => {
  const { kit, tokens } = await flow();
  expect(tokens.expires_in).toBe(3600);
  expect(tokens.scope).toBe("board chat");
  const who = verifyAccessToken(kit.api.db, tokens.access_token);
  expect(who?.orgId).toBe(kit.org.id);
  expect(who?.memberId).toBe(kit.org.owner.id);
  expect(who?.scopes).toEqual(["board", "chat"]);
  expect(verifyAccessToken(kit.api.db, "nonsense")).toBeNull();
  expect(verifyAccessToken(kit.api.db, tokens.refresh_token)).toBeNull();
  const stored = JSON.stringify(kit.api.db.query("SELECT * FROM oauth_tokens").all());
  expect(stored).not.toContain(tokens.access_token);
  expect(stored).not.toContain(tokens.refresh_token);
});

test("a missing or wrong code_verifier is invalid_grant", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  for (const verifier of ["", pkce().verifier]) {
    const code = await kit.authorize(clientId, pkce().challenge);
    const res = await kit.exchange(clientId, code, verifier);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  }
});

test("a failed exchange burns the code", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const { verifier, challenge } = pkce();
  const code = await kit.authorize(clientId, challenge);
  expect((await kit.exchange(clientId, code, pkce().verifier)).status).toBe(400);
  expect((await kit.exchange(clientId, code, verifier)).status).toBe(400);
});

test("the plain method is refused at consent and at authorize", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const res = await kit.consent(clientId, pkce().challenge, { code_challenge_method: "plain" });
  expect(res.status).toBe(400);
  const url = `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=plain&resource=${encodeURIComponent(RESOURCE)}&state=s1`;
  const authz = await kit.get(url);
  expect(authz.status).toBe(400);
  expect(((await authz.json()) as { error: string }).error).toBe("invalid_request");
});

test("code reuse is refused and revokes the tokens issued from it", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const { verifier, challenge } = pkce();
  const code = await kit.authorize(clientId, challenge);
  const first = (await (await kit.exchange(clientId, code, verifier)).json()) as Tokens;
  expect(verifyAccessToken(kit.api.db, first.access_token)).not.toBeNull();
  const again = await kit.exchange(clientId, code, verifier);
  expect(again.status).toBe(400);
  expect(verifyAccessToken(kit.api.db, first.access_token)).toBeNull();
  const refresh = await kit.post(
    "/oauth/token",
    { grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token },
    true,
  );
  expect(refresh.status).toBe(400);
});

test("a redirect_uri differing by a trailing slash is refused", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const consent = await kit.consent(clientId, pkce().challenge, { redirect_uri: `${REDIRECT}/` });
  expect(consent.status).toBe(400);
  const { verifier, challenge } = pkce();
  const code = await kit.authorize(clientId, challenge);
  const res = await kit.post(
    "/oauth/token",
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: `${REDIRECT}/`,
      code_verifier: verifier,
    },
    true,
  );
  expect(res.status).toBe(400);
  const authz = await kit.get(
    `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(`${REDIRECT}/`)}`,
  );
  expect(authz.status).toBe(400);
});

test("a resource other than the MCP resource is refused", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const res = await kit.consent(clientId, pkce().challenge, { resource: `${ORIGIN}/mcp` });
  expect(res.status).toBe(400);
  const { verifier, challenge } = pkce();
  const code = await kit.authorize(clientId, challenge);
  const token = await kit.post(
    "/oauth/token",
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: "https://other.example/mcp",
    },
    true,
  );
  expect(((await token.json()) as { error: string }).error).toBe("invalid_target");
});

test("consent without fresh step-up is 403 step_up_required and issues nothing", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  kit.api.db.query("UPDATE sessions SET step_up_at = NULL").run();
  const res = await kit.consent(clientId, pkce().challenge, {}, false);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
  expect(kit.api.db.query("SELECT 1 FROM oauth_codes").all()).toHaveLength(0);
});

test("one step-up covers one consent: a second grant on the same tap needs a new one", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const first = await kit.consent(clientId, pkce().challenge);
  expect(first.status).toBe(200);
  const replay = await kit.consent(clientId, pkce().challenge, {}, false);
  expect(replay.status).toBe(403);
  expect(((await replay.json()) as { error: string }).error).toBe("step_up_required");
  expect((await kit.consent(clientId, pkce().challenge)).status).toBe(200);
});

test("an authorize request with a bad parameter gets a 400, never a redirect", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "token",
  });
  const res = await kit.get(`/oauth/authorize?${query}`);
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
});

test("client names with control or bidi characters are refused", async () => {
  const kit = await bootOauth();
  for (const name of ["Cl\u202eaude", "Claude\u0007"]) {
    const res = await kit.post("/oauth/register", { client_name: name, redirect_uris: [REDIRECT] });
    expect(res.status).toBe(400);
  }
});

test("registration is rate limited", async () => {
  const kit = await bootOauth();
  for (let i = 0; i < 30; i++) await kit.register();
  expect((await kit.post("/oauth/register", { redirect_uris: [REDIRECT] })).status).toBe(429);
});

test("a full table frees unused old clients but keeps clients that hold grants", async () => {
  const kit = await bootOauth();
  const used = await kit.register();
  await kit.authorize(used, pkce().challenge);
  const insert = kit.api.db.query(
    "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, 'x', '[]', 1)",
  );
  for (let i = 0; i < 999; i++) insert.run(`old-${i}`);
  kit.api.db.query("UPDATE oauth_clients SET created_at = 1 WHERE id = ?").run(used);
  const res = await kit.post("/oauth/register", { redirect_uris: [REDIRECT] });
  expect(res.status).toBe(201);
  const ids = kit.api.db.query<{ id: string }, []>("SELECT id FROM oauth_clients").all();
  expect(ids.some((r) => r.id === used)).toBe(true);
  expect(ids.some((r) => r.id.startsWith("old-"))).toBe(false);
});

test("consent for an org the member does not belong to is 403", async () => {
  const kit = await bootOauth();
  const stranger = await kit.api.user({ stepUp: true });
  const other = kit.api.org(stranger, "other");
  const clientId = await kit.register();
  const res = await kit.consent(clientId, pkce().challenge, { org_id: other.id });
  expect(res.status).toBe(403);
});

test("granted scopes cannot exceed the request and deny redirects with access_denied", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const narrow = await kit.consent(clientId, pkce().challenge, {
    scope: "board",
    granted: ["board", "chat"],
  });
  expect(narrow.status).toBe(400);
  const board = await kit.consent(clientId, pkce().challenge, {
    scope: "board",
    granted: ["board"],
  });
  expect(board.status).toBe(200);
  const deny = await kit.api.call(kit.owner, "POST", "/oauth/deny", {
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "s9",
  });
  const to = new URL(((await deny.json()) as { redirect: string }).redirect);
  expect(to.searchParams.get("error")).toBe("access_denied");
  expect(to.searchParams.get("state")).toBe("s9");
  const forged = await kit.api.call(kit.owner, "POST", "/oauth/deny", {
    client_id: clientId,
    redirect_uri: "https://evil.example/",
  });
  expect(forged.status).toBe(400);
});

test("authorize hands a valid request to the consent page without needing a session", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const url = `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}&state=s1`;
  const res = await kit.get(url);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toStartWith("/#/oauth/consent?client_id=");
});
