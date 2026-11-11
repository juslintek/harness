import { createHmac, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";

type FakeAlg = "ES256" | "RS256" | "HS256" | "none";

export interface OidcFake {
  issuer: string;
  clientId: string;
  // Applied to the next id_tokens the token endpoint mints; set back to {} between cases.
  claims: Record<string, unknown>;
  alg: FakeAlg;
  // "stranger" signs with a key the JWKS does not list.
  signer: "jwks" | "stranger";
  clientSecret: string | undefined;
  tokenRequests: URLSearchParams[];
  mint: (claims?: Record<string, unknown>, nonce?: string) => string;
  stop: () => void;
}

interface Issued {
  challenge: string;
  nonce: string;
  redirectUri: string;
}

const b64 = (value: string | Buffer): string => Buffer.from(value).toString("base64url");
const s256 = (verifier: string): string =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

interface Keys {
  es: KeyObject;
  rs: KeyObject;
  stranger: KeyObject;
  jwks: { keys: Record<string, unknown>[] };
}

function makeKeys(): Keys {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = (key: KeyObject, kid: string, alg: string): Record<string, unknown> => ({
    ...key.export({ format: "jwk" }),
    kid,
    use: "sig",
    alg,
  });
  return {
    es: ec.privateKey,
    rs: rsa.privateKey,
    stranger: stranger.privateKey,
    jwks: { keys: [pub(ec.publicKey, "es1", "ES256"), pub(rsa.publicKey, "rs1", "RS256")] },
  };
}

function signToken(keys: Keys, state: OidcFake, header: object, payload: object): string {
  const data = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const input = Buffer.from(data);
  if (state.alg === "none") return `${data}.`;
  if (state.alg === "HS256")
    return `${data}.${b64(createHmac("sha256", "x").update(data).digest())}`;
  const ec = state.signer === "stranger" ? keys.stranger : keys.es;
  const sig =
    state.alg === "ES256"
      ? sign("sha256", input, { key: ec, dsaEncoding: "ieee-p1363" })
      : sign("sha256", input, keys.rs);
  return `${data}.${b64(sig)}`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

interface Wiring {
  keys: Keys;
  fake: OidcFake;
  issued: Map<string, Issued>;
}

function authorize(w: Wiring, url: URL): Response {
  const q = url.searchParams;
  const redirectUri = q.get("redirect_uri") ?? "";
  if (q.get("client_id") !== w.fake.clientId || q.get("code_challenge_method") !== "S256") {
    return json({ error: "invalid_request" }, 400);
  }
  const code = randomUUID();
  w.issued.set(code, {
    challenge: q.get("code_challenge") ?? "",
    nonce: q.get("nonce") ?? "",
    redirectUri,
  });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", q.get("state") ?? "");
  return Response.redirect(back.toString(), 302);
}

async function token(w: Wiring, req: Request): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  w.fake.tokenRequests.push(form);
  const issued = w.issued.get(form.get("code") ?? "");
  w.issued.delete(form.get("code") ?? "");
  const verifierOk = issued && s256(form.get("code_verifier") ?? "") === issued.challenge;
  const secretOk =
    w.fake.clientSecret === undefined || form.get("client_secret") === w.fake.clientSecret;
  const clientOk = form.get("client_id") === w.fake.clientId;
  if (
    !issued ||
    !verifierOk ||
    !secretOk ||
    !clientOk ||
    form.get("redirect_uri") !== issued.redirectUri
  ) {
    return json({ error: "invalid_grant" }, 400);
  }
  return json({ id_token: w.fake.mint({}, issued.nonce), token_type: "Bearer" });
}

function discovery(base: string): Record<string, string> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    jwks_uri: `${base}/jwks`,
  };
}

// A provider on loopback: discovery, JWKS (one ES256 and one RS256 key), an authorize endpoint that
// redirects straight back, and a token endpoint that checks PKCE and returns a minted id_token.
export function createOidcFake(clientId = "harness-client"): OidcFake {
  const keys = makeKeys();
  const issued = new Map<string, Issued>();
  let base = "";
  const fake: OidcFake = {
    issuer: "",
    clientId,
    claims: {},
    alg: "ES256",
    signer: "jwks",
    clientSecret: undefined,
    tokenRequests: [],
    mint: (claims = {}, nonce = "n") => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: base,
        aud: clientId,
        sub: "sub-1",
        email: "owner@example.com",
        email_verified: true,
        nonce,
        iat: now,
        exp: now + 300,
        ...fake.claims,
        ...claims,
      };
      const kid = fake.alg === "RS256" ? "rs1" : "es1";
      return signToken(keys, fake, { alg: fake.alg, typ: "JWT", kid }, payload);
    },
    stop: () => server.stop(true),
  };
  const wiring: Wiring = { keys, fake, issued };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") return json(discovery(base));
      if (url.pathname === "/redirecting/.well-known/openid-configuration") {
        return Response.redirect("https://evil.example/.well-known/openid-configuration", 302);
      }
      if (url.pathname === "/jwks") return json(keys.jwks);
      if (url.pathname === "/authorize") return authorize(wiring, url);
      if (url.pathname === "/token" && req.method === "POST") return token(wiring, req);
      return json({ error: "not found" }, 404);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  fake.issuer = base;
  return fake;
}
