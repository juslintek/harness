import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pwaHeaders, pwaResponse } from "./pwa";

// HARNESS_UI_DIST swaps the built-in web bundle for a prebuilt directory, so a server written in
// another language can be tested against the same UI files. "/_app" is the bundle's entry path.
export async function uiDistResponse(dist: string, pathname: string): Promise<Response | null> {
  const root = resolve(dist);
  let relative = "index.html";
  if (pathname !== "/_app") {
    try {
      relative = decodeURIComponent(pathname.slice(1));
    } catch {
      return null;
    }
  }
  if (relative.includes("\0")) return null;
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) return null;
  // Bun.file follows symlinks, so the lexical check above is not enough: a link inside the dist
  // may point anywhere.
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(path);
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + sep)) return null;
  const file = Bun.file(real);
  return (await file.exists()) ? new Response(file) : null;
}

// Files in the dist win; the built-in PWA files only fill in what the dist lacks.
export async function staticResponse(
  dist: string | undefined,
  method: string,
  pathname: string,
): Promise<Response | null> {
  const fromDist = dist && method === "GET" ? await uiDistResponse(dist, pathname) : null;
  const headers = pwaHeaders(pathname);
  if (fromDist && headers) {
    // A dist's own sw.js and manifest need the same cache and scope headers as the built-in ones.
    for (const [name, value] of Object.entries(headers)) fromDist.headers.set(name, value);
  }
  return fromDist ?? pwaResponse(pathname);
}
