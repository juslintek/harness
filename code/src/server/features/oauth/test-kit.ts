import { expect } from "bun:test";
import { type ApiKit, bootApi } from "../../test-support/api-kit";

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
  // The public endpoints as a client outside the browser calls them: Host only, no cookie.
  post: (path: string, body: unknown, form?: boolean) => Promise<Response>;
  get: (path: string) => Promise<Response>;
  register: (redirectUris?: string[]) => Promise<string>;
  consent: (
    clientId: string,
    challenge: string,
    extra?: Record<string, unknown>,
  ) => Promise<Response>;
  authorize: (clientId: string, challenge: string) => Promise<string>;
  exchange: (clientId: string, code: string, verifier: string) => Promise<Response>;
}

export async function bootOauth(): Promise<OauthKit> {
  const api = bootApi();
  const owner = await api.user({ stepUp: true });
  const org = api.org(owner, "acme");
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
  const consent: OauthKit["consent"] = (clientId, challenge, extra = {}) =>
    api.call(owner, "POST", "/oauth/consent", {
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
  const authorize: OauthKit["authorize"] = async (clientId, challenge) => {
    const res = await consent(clientId, challenge);
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    return redirect.searchParams.get("code") ?? "";
  };
  const exchange: OauthKit["exchange"] = (clientId, code, verifier) =>
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
  return { api, owner, org, post, get, register, consent, authorize, exchange };
}
