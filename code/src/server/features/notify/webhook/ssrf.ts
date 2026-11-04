import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

// Expands "::" and a dotted tail into eight 16-bit groups.
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
  // ::, ::1 (both read as 0.0.0.x), IPv4-mapped and IPv4-compatible forms carry an IPv4 address.
  if (zeroPrefix && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded);
  return g[0] === 0x64 && g[1] === 0xff9b && blockedV4(embedded);
}

export function isBlockedIp(ip: string): boolean {
  return isIP(ip) === 4 ? blockedV4(ip) : blockedV6(ip);
}

function allowsPlainHttp(url: URL): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

async function resolvedBlocked(host: string): Promise<boolean> {
  try {
    const found = await lookup(host, { all: true });
    return found.length === 0 || found.some((f) => isBlockedIp(f.address));
  } catch {
    return true;
  }
}

// Null means the url may be used. Checked when a target is added and again before every send,
// because DNS can change between the two. Reasons never echo the url, which may hold a token.
export async function webhookUrlProblem(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid url";
  }
  if (url.username || url.password) return "credentials in the url are not allowed";
  if (allowsPlainHttp(url)) return null;
  if (url.protocol !== "https:") return "only https urls are allowed";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isBlockedIp(host) ? "address is not allowed" : null;
  return (await resolvedBlocked(host)) ? "host does not resolve to a public address" : null;
}
