import { expect } from "bun:test";
import { createApp } from "../http";
import { type ApiKit, bootApi } from "./api-kit";
import { createSoftAuthenticator } from "./soft-authenticator";

export const ORIGIN: string = "http://localhost:4100";
export const RESOURCE: string = `${ORIGIN}/mcp/remote`;
export const REDIRECT: string = "https://claude.example/cb";

export function pkce(): { verifier: string; challenge: string } {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
}

export async function flow(): Promise<{
  kit: Awaited<ReturnType<typeof bootOauth>>;
  clientId: string;
  tokens: Tokens;
}> {
  const kit = await bootOauth();
  const clientId = await kit.register();
  const { verifier, challenge } = pkce();
  const code = await kit.authorize(clientId, challenge);
  const res = await kit.exchange(clientId, code, verifier);
  expect(res.status).toBe(200);
  return { kit, clientId, tokens: (await res.json()) as Tokens };
}

export interface OauthKit {
  api: ApiKit;
  owner: Awaited<ReturnType<ApiKit["user"]>>;
  org: { id: string; slug: string; owner: { id: string } };
  authn: ReturnType<typeof createSoftAuthenticator>;
  restart: () => ReturnType<typeof createApp>;
  // The public endpoints as a client outside the browser calls them: Host only, no cookie.
  post: (path: string, body: unknown, form?: boolean) => Promise<Response>;
  get: (path: string) => Promise<Response>;
  register: (redirectUris?: string[]) => Promise<string>;
  consentBody: (clientId: string, challenge: string, extra?: Record<string, unknown>) => object;
  consentOptions: (body: object) => Promise<Response>;
  consentVerify: (body: object, challengeId: string, response: unknown) => Promise<Response>;
  consent: (
    clientId: string,
    challenge: string,
    extra?: Record<string, unknown>,
    freshTap?: boolean,
  ) => Promise<Response>;
  authorize: (clientId: string, challenge: string) => Promise<string>;
  exchange: (clientId: string, code: string, verifier: string) => Promise<Response>;
}

function exchangeWith(post: OauthKit["post"]): OauthKit["exchange"] {
  return (clientId, code, verifier) =>
    post(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: RESOURCE,
      },
      true,
    );
}

async function registerTestPasskey(
  api: ApiKit,
  owner: Awaited<ReturnType<ApiKit["user"]>>,
  authn: ReturnType<typeof createSoftAuthenticator>,
): Promise<void> {
  const response = await api.call(owner, "POST", "/api/auth/passkeys/options", {});
  const options = (await response.json()) as Parameters<typeof authn.create>[0] & {
    challengeId: string;
  };
  const credential = await authn.create(options);
  const verified = await api.call(owner, "POST", "/api/auth/passkeys/verify", {
    challengeId: options.challengeId,
    response: credential,
    name: "OAuth test",
  });
  expect(verified.status).toBe(200);
}

function publicRequests(api: ApiKit): Pick<OauthKit, "post" | "get" | "register"> {
  const headers = { host: "localhost:4100" };
  const post: OauthKit["post"] = (path, body, form = false) =>
    Promise.resolve(
      api.app.request(path, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
        },
        body: form
          ? new URLSearchParams(body as Record<string, string>).toString()
          : JSON.stringify(body),
      }),
    );
  const get: OauthKit["get"] = (path) => Promise.resolve(api.app.request(path, { headers }));
  const register: OauthKit["register"] = async (redirectUris = [REDIRECT]) => {
    const res = await post("/oauth/register", {
      client_name: "Claude",
      redirect_uris: redirectUris,
    });
    return ((await res.json()) as { client_id: string }).client_id;
  };
  return { post, get, register };
}

function consentRequests(
  api: ApiKit,
  owner: Awaited<ReturnType<ApiKit["user"]>>,
  org: OauthKit["org"],
  authn: ReturnType<typeof createSoftAuthenticator>,
): Pick<OauthKit, "consentBody" | "consentOptions" | "consentVerify" | "consent"> {
  const consentBody: OauthKit["consentBody"] = (clientId, challenge, extra = {}) => ({
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    org_id: org.id,
    granted: ["board", "chat"],
    state: "xyz",
    ...extra,
  });
  const consentOptions: OauthKit["consentOptions"] = (body) =>
    api.call(owner, "POST", "/oauth/consent/options", body);
  const consentVerify: OauthKit["consentVerify"] = (body, challengeId, response) =>
    api.call(owner, "POST", "/oauth/consent/verify", { ...body, challengeId, response });
  const consent: OauthKit["consent"] = (clientId, challenge, extra = {}, freshTap = true) => {
    const body = consentBody(clientId, challenge, extra);
    if (!freshTap) return api.call(owner, "POST", "/oauth/consent", body);
    return (async () => {
      const optionsResponse = await consentOptions(body);
      if (!optionsResponse.ok) return optionsResponse;
      const options = (await optionsResponse.json()) as Parameters<typeof authn.get>[0];
      const response = await authn.get(options);
      const id = (options as typeof options & { challengeId: string }).challengeId;
      const verified = await consentVerify(body, id, response);
      if (!verified.ok) return verified;
      return api.call(owner, "POST", "/oauth/consent", body);
    })();
  };
  return { consentBody, consentOptions, consentVerify, consent };
}

export async function bootOauth(): Promise<OauthKit> {
  const api = bootApi();
  const owner = await api.user({ stepUp: true });
  const org = api.org(owner, "acme");
  const rp = { id: "localhost", name: "Harness", origin: ORIGIN };
  const restart: OauthKit["restart"] = () =>
    createApp({
      db: api.db,
      home: "/unused",
      port: 4100,
      rp,
      instanceId: "i",
      version: "1",
    });
  const authn = createSoftAuthenticator(rp);
  await registerTestPasskey(api, owner, authn);
  const publicApi = publicRequests(api);
  const consentApi = consentRequests(api, owner, org, authn);
  const authorize: OauthKit["authorize"] = async (clientId, challenge) => {
    const res = await consentApi.consent(clientId, challenge);
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    return redirect.searchParams.get("code") ?? "";
  };
  const exchange = exchangeWith(publicApi.post);
  return {
    api,
    owner,
    org,
    authn,
    restart,
    ...publicApi,
    ...consentApi,
    authorize,
    exchange,
  };
}
