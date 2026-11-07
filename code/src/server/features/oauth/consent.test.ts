import { expect, test } from "bun:test";
import { bootOauth, type OauthKit, ORIGIN, pkce, REDIRECT } from "./test-kit";

async function consentProof(kit: OauthKit, body: object) {
  const response = await kit.consentOptions(body);
  expect(response.status).toBe(200);
  const options = (await response.json()) as Parameters<typeof kit.authn.get>[0] & {
    challengeId: string;
  };
  return { challengeId: options.challengeId, response: await kit.authn.get(options) };
}

function postApp(kit: OauthKit, path: string, body: object) {
  return kit.restart().request(path, {
    method: "POST",
    headers: { ...kit.owner.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a recent generic step-up cannot approve an OAuth grant", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const res = await kit.consent(clientId, pkce().challenge, {}, false);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
  expect(kit.api.db.query("SELECT 1 FROM oauth_codes").all()).toHaveLength(0);
});

test("grant-bound proof rejects changed client, PKCE, org, scope, and redirect", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const otherClient = await kit.register();
  const otherOrg = kit.api.org(kit.owner, "second");
  const body = kit.consentBody(clientId, pkce().challenge);
  const proof = await consentProof(kit, body);
  const altered = [
    { ...body, client_id: otherClient },
    { ...body, code_challenge: pkce().challenge },
    { ...body, org_id: otherOrg.id },
    { ...body, granted: ["board"] },
    { ...body, redirect_uri: `${REDIRECT}/other` },
  ];
  for (const grant of altered) {
    const res = await kit.consentVerify(grant, proof.challengeId, proof.response);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
  }
  expect((await kit.consentVerify(body, proof.challengeId, proof.response)).status).toBe(200);
});

test("verified consent survives app restart but its proof cannot replay", async () => {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const body = kit.consentBody(clientId, pkce().challenge);
  const proof = await consentProof(kit, body);
  expect((await kit.consentVerify(body, proof.challengeId, proof.response)).status).toBe(200);
  const replay = await postApp(kit, "/oauth/consent/verify", { ...body, ...proof });
  expect(replay.status).toBe(403);
  expect((await postApp(kit, "/oauth/consent", body)).status).toBe(200);
  expect((await postApp(kit, "/oauth/consent", body)).status).toBe(403);
});

test("consent options and approval require a session and matching Origin", async () => {
  const kit = await bootOauth();
  const body = JSON.stringify({ client_id: await kit.register() });
  for (const path of ["/oauth/consent", "/oauth/consent/options"]) {
    const anon = await kit.api.app.request(path, {
      method: "POST",
      headers: { host: "localhost:4100", origin: ORIGIN },
      body,
    });
    expect(anon.status).toBe(401);
    const crossSite = await kit.api.app.request(path, {
      method: "POST",
      headers: { ...kit.owner.headers, origin: "https://evil.example" },
      body,
    });
    expect(crossSite.status).toBe(403);
  }
});
