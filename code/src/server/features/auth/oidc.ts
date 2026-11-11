import { z } from "zod";
import { type Identity, type IdTokenExpectation, verifyIdToken } from "./oidc-jwt";
import type { OidcProvider } from "./oidc-repo";

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1_000_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface PendingLogin {
  providerId: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

// Lost on restart on purpose: a login that was in flight just starts again.
const pending = new Map<string, PendingLogin>();

// Plain http is for loopback only, so tests and local development work without TLS; every
// other provider endpoint must be https.
export function isAllowedProviderUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

// Redirects are never followed: a provider that answers with one is treated as unavailable, so a
// compromised or misconfigured host cannot steer these server-side requests to another host.
async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  if (!isAllowedProviderUrl(url)) return null;
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryDoc: z.ZodType<Discovery> = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
});

async function discover(issuer: string): Promise<Discovery | null> {
  const body = await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const doc = discoveryDoc.safeParse(body);
  if (!doc.success || doc.data.issuer !== issuer) return null;
  const urls = [doc.data.authorization_endpoint, doc.data.token_endpoint, doc.data.jwks_uri];
  return urls.every(isAllowedProviderUrl) ? doc.data : null;
}

const random = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const s256 = (verifier: string): string =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

export async function beginAuthorization(
  provider: OidcProvider,
  redirectUri: string,
  now: number = Date.now(),
): Promise<{ location: string; state: string } | null> {
  const doc = await discover(provider.issuer);
  if (!doc) return null;
  for (const [key, entry] of pending) if (entry.expiresAt <= now) pending.delete(key);
  if (pending.size >= MAX_PENDING) return null;
  const state = random();
  const entry = { providerId: provider.id, nonce: random(), verifier: random() };
  pending.set(state, { ...entry, expiresAt: now + PENDING_TTL_MS });
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", entry.nonce);
  url.searchParams.set("code_challenge", s256(entry.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { location: url.toString(), state };
}

// One use: the entry is gone whether or not the rest of the login succeeds.
export function takePending(state: string, now: number = Date.now()): PendingLogin | null {
  const entry = pending.get(state);
  pending.delete(state);
  return entry && entry.expiresAt > now ? entry : null;
}

const tokenResponse = z.object({ id_token: z.string().min(1) });
const jwksDoc = z.object({ keys: z.array(z.unknown()) });

export async function redeemCode(
  provider: OidcProvider,
  clientSecret: string | undefined,
  input: { code: string; redirectUri: string; entry: PendingLogin; now?: number },
): Promise<Identity | null> {
  const doc = await discover(provider.issuer);
  if (!doc) return null;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: provider.clientId,
    code_verifier: input.entry.verifier,
  });
  if (clientSecret) form.set("client_secret", clientSecret);
  const token = tokenResponse.safeParse(
    await fetchJson(doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
    }),
  );
  const jwks = jwksDoc.safeParse(await fetchJson(doc.jwks_uri));
  if (!token.success || !jwks.success) return null;
  const want: IdTokenExpectation = {
    issuer: provider.issuer,
    audience: provider.clientId,
    nonce: input.entry.nonce,
    now: input.now ?? Date.now(),
  };
  return verifyIdToken(token.data.id_token, jwks.data.keys, want);
}
