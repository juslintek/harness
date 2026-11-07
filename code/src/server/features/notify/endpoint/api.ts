import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

function blockedV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function groupsV6(ip: string): number[] {
  let text = ip.split("%")[0] ?? ip;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = text.slice(0, -tail.length) + ((a << 8) | b).toString(16);
    text += `:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - front.length - back.length;
  return [...front, ...Array<string>(fill).fill("0"), ...back].map((g) => Number.parseInt(g, 16));
}

function blockedV6(ip: string): boolean {
  const g = groupsV6(ip);
  const [first = 0] = g;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00) return true;
  const embedded = `${(g[6] ?? 0) >> 8}.${(g[6] ?? 0) & 255}.${(g[7] ?? 0) >> 8}.${(g[7] ?? 0) & 255}`;
  const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded);
  return g[0] === 0x64 && g[1] === 0xff9b && blockedV4(embedded);
}

export function isBlockedIp(ip: string): boolean {
  return isIP(ip) === 4 ? blockedV4(ip) : blockedV6(ip);
}

export interface Endpoint {
  url: URL;
  address?: string;
}

type EndpointCheck = { ok: true; endpoint: Endpoint } | { ok: false; retry: boolean };

interface Request {
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  timeoutMs: number;
}

function testLoopback(url: URL): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

export async function safeEndpoint(
  raw: string,
  resolve: typeof lookup = lookup,
): Promise<EndpointCheck> {
  if (raw.length > 2048) return { ok: false, retry: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, retry: false };
  }
  if (url.username || url.password) return { ok: false, retry: false };
  if (testLoopback(url)) return { ok: true, endpoint: { url } };
  if (url.protocol !== "https:") return { ok: false, retry: false };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    return isBlockedIp(hostname)
      ? { ok: false, retry: false }
      : { ok: true, endpoint: { url, address: hostname } };
  }
  try {
    const addresses = await resolve(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
      return { ok: false, retry: false };
    }
    const address = addresses[0]?.address;
    return address ? { ok: true, endpoint: { url, address } } : { ok: false, retry: false };
  } catch {
    return { ok: false, retry: true };
  }
}

export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return ((_: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}

export async function endpointProblem(raw: string): Promise<string | null> {
  return (await safeEndpoint(raw)).ok ? null : "endpoint is not a public HTTPS address";
}

export async function requestEndpoint(endpoint: Endpoint, request: Request): Promise<number> {
  if (!endpoint.address) {
    const response = await fetch(endpoint.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as BodyInit,
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return response.status;
  }
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      endpoint.url,
      {
        method: request.method,
        headers: request.headers,
        ...(isIP(endpoint.url.hostname.replace(/^\[|\]$/g, ""))
          ? {}
          : { servername: endpoint.url.hostname }),
        lookup: pinnedLookup(endpoint.address ?? ""),
        signal: AbortSignal.timeout(request.timeoutMs),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.once("error", reject);
    outgoing.end(request.body);
  });
}
