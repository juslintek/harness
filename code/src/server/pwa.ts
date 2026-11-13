import iconPath from "../web/pwa/icon.svg" with { type: "file" };
import manifestPath from "../web/pwa/manifest.webmanifest" with { type: "file" };
import swPath from "../web/pwa/sw.js" with { type: "file" };

// Embedded so a compiled binary serves them without the source tree.

export const FILES: Record<string, { file: string; type: string }> = {
  "/manifest.webmanifest": { file: manifestPath, type: "application/manifest+json" },
  "/sw.js": { file: swPath, type: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: iconPath, type: "image/svg+xml" },
};

// No-cache on all three so a new service worker or manifest is picked up on the next load, and
// service-worker-allowed lets /sw.js control the whole origin. These files are public: the
// browser fetches them without a session while installing.
export function pwaHeaders(pathname: string): Record<string, string> | null {
  const entry = FILES[pathname];
  if (!entry) return null;
  const headers: Record<string, string> = {
    "content-type": entry.type,
    "cache-control": "no-cache",
  };
  if (pathname === "/sw.js") headers["service-worker-allowed"] = "/";
  return headers;
}

export function pwaResponse(pathname: string): Response | null {
  const headers = pwaHeaders(pathname);
  const entry = FILES[pathname];
  if (!headers || !entry) return null;
  return new Response(Bun.file(entry.file), { headers });
}
