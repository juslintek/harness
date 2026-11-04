import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { inspectRoutes } from "hono/dev";
import { z } from "zod";
import { LOOPBACK_PATHS } from "../src/server/features/auth/middleware";
import {
  ASK_DESTRUCTIVE,
  DENY_EXFILTRATION,
  GUARD_TIMEOUT_MS,
  MAX_COMMAND_CHARS,
  MAX_REQUEST_CHARS,
  MIN_COMMAND_CHARS,
} from "../src/server/features/guard/l2";
import { FILES as PWA_FILES } from "../src/server/pwa";
import { bootApi } from "../src/server/test-support/api-kit";
import { byText, pretty } from "./contract-lib";
import { mcpTools } from "./contract-mcp";

// The language-neutral description of everything a second server has to reproduce. The files are
// generated from the running TS code, committed, and a test fails when they go stale. errors.json
// and schemas/ are a v1 subset, not authoritative (see "Known gaps in contract-dump v1" in
// working-docs/zig-plan.md section 11). The policy flags in routes.json come from named middleware
// only: a check done inside a handler (instanceAdmin, needStepUp) is not visible there, so the
// flags are not the authorization source for another server.
export const CONTRACT_DIR: string = join(import.meta.dir, "../../contract");

const SRC = join(import.meta.dir, "../src");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort(byText);
}

interface Row {
  path: string;
  method: string;
  name: string;
  isMiddleware: boolean;
}

// A middleware pattern covers a handler path when every segment matches, a ":param" matches any
// segment, and a trailing "*" matches the rest.
function covers(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const have = path.split("/");
  for (let i = 0; i < want.length; i++) {
    if (want[i] === "*") return true;
    if (i >= have.length) return false;
    if (want[i] !== have[i] && !want[i]?.startsWith(":") && !have[i]?.startsWith(":")) return false;
  }
  return want.length === have.length;
}

function policyOf(chain: Row[], row: Row): object {
  const has = (name: string): boolean => chain.some((mw) => mw.name === name);
  return {
    admin: has("requireInstanceAdmin"),
    loopback: LOOPBACK_PATHS.has(row.path),
    orgAdmin: has("requireOrgAdmin"),
    // Mutations need Origin through mutationOriginGuard; /ws is a GET that needs it too.
    origin: has("originGuard") || (!SAFE_METHODS.has(row.method) && has("mutationOriginGuard")),
    public: !has("sessionMiddleware"),
    rateLimited: has("rateLimit"),
    session: has("sessionMiddleware"),
    stepUp: has("requireStepUp"),
  };
}

// Only middleware registered before a handler runs for it, in registration order.
function routeEntries(rows: Row[]): { method: string; path: string; policy: object }[] {
  return rows
    .flatMap((row, index) => {
      if (row.isMiddleware) return [];
      const chain = rows
        .slice(0, index)
        .filter(
          (mw) =>
            mw.isMiddleware &&
            (mw.method === "ALL" || mw.method === row.method) &&
            covers(mw.path, row.path),
        );
      return [{ method: row.method, path: row.path, policy: policyOf(chain, row) }];
    })
    .sort((a, b) => byText(`${a.path} ${a.method}`, `${b.path} ${b.method}`));
}

// Paths that main.ts, the MCP handler or the WebSocket upgrade answer outside the plain
// route-and-policy shape of routes.json.
const OTHER_PATHS = [
  {
    path: "/",
    methods: "any",
    kind: "entry",
    note: "main.ts answers any method on a Host other than 127.0.0.1:<port> with the UI shell (the /_app response, fetched with GET); on Host 127.0.0.1:<port> the request falls through to the app, whose redirect to the origin handles GET",
  },
  {
    path: "/_app",
    methods: "GET",
    kind: "static",
    note: "the web bundle's entry file, or index.html of HARNESS_UI_DIST",
  },
  {
    path: "/mcp",
    methods: "POST",
    kind: "mcp",
    note: "other methods get 405 with Allow: POST; Host must be 127.0.0.1:<port> or localhost:<port>; Bearer run token",
  },
  {
    path: "/api/guard/hook",
    methods: "POST",
    kind: "guard-hook",
    note: "Bearer run token with scope guard_hook, own run only",
  },
  {
    path: "/ws",
    methods: "GET",
    kind: "websocket",
    note: "query topic matches ^(runs|approvals|(run|org):[0-9a-f-]{36})$; Origin required",
  },
];

function routes(): { main: object[]; extra: object[] } {
  const rows = inspectRoutes(bootApi().app);
  // A policy flag comes from a middleware's name, so an unnamed one would silently drop out.
  const unnamed = rows.filter((row) => row.isMiddleware && row.name === "[middleware]");
  if (unnamed.some((row) => !(row.method === "GET" && row.path === "/"))) {
    throw new Error("a route middleware has no name; give it one so contract-dump can read it");
  }
  const pwa = Object.entries(PWA_FILES).map(([path, { type }]) => ({
    path,
    methods: "any",
    kind: "static",
    contentType: type,
    note: "served before Hono and before the host guard, public",
  }));
  const extra = [...OTHER_PATHS, ...pwa].sort((a, b) => byText(a.path, b.path));
  // A path described in routes-extra.json is answered outside the plain route shape (a POST-only
  // wrapper over app.all, a pre-Hono intercept), so its Hono rows would contradict the entry.
  const described = new Set(extra.map((entry) => entry.path));
  return { main: routeEntries(rows).filter((entry) => !described.has(entry.path)), extra };
}

async function schemas(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dir = join(SRC, "shared");
  const options = { unrepresentable: "any", reused: "inline" } as const;
  for (const file of sourceFiles(dir).filter((path) => !path.endsWith(".test.ts"))) {
    const mod: Record<string, unknown> = await import(file);
    const entries = Object.entries(mod)
      .filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType)
      .map(([name, schema]) => [
        name,
        {
          input: z.toJSONSchema(schema, { ...options, io: "input" }),
          output: z.toJSONSchema(schema, { ...options, io: "output" }),
        },
      ]);
    if (entries.length === 0) continue;
    out[`schemas/${relative(dir, file).replace(/\.ts$/, "")}.json`] = pretty(
      Object.fromEntries(entries),
    );
  }
  return out;
}

function errorCodes(): string {
  const codes = new Set<string>();
  const files = sourceFiles(join(SRC, "server")).filter(
    (path) => !path.endsWith(".test.ts") && !path.includes("/test-support/"),
  );
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/error: "([^"]+)"/g)) {
      codes.add(match[1] as string);
    }
  }
  return pretty([...codes].sort(byText));
}

const l2Thresholds = (): string =>
  pretty({
    askDestructive: ASK_DESTRUCTIVE,
    denyExfiltration: DENY_EXFILTRATION,
    guardTimeoutMs: GUARD_TIMEOUT_MS,
    maxCommandChars: MAX_COMMAND_CHARS,
    maxRequestChars: MAX_REQUEST_CHARS,
    minCommandChars: MIN_COMMAND_CHARS,
  });

// Relative path under contract/ to file content.
export async function buildContract(): Promise<Record<string, string>> {
  const { main, extra } = routes();
  return {
    "routes.json": pretty(main),
    "routes-extra.json": pretty(extra),
    "mcp-tools.json": await mcpTools(),
    "errors.json": errorCodes(),
    "l2-thresholds.json": l2Thresholds(),
    ...(await schemas()),
  };
}

if (import.meta.main) {
  const files = await buildContract();
  // Only generated files: contract/ also holds hand-written ones (guard corpus, env.md).
  rmSync(join(CONTRACT_DIR, "schemas"), { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(CONTRACT_DIR, path)), { recursive: true });
    writeFileSync(join(CONTRACT_DIR, path), content);
  }
  console.log(`wrote ${Object.keys(files).length} files to ${CONTRACT_DIR}`);
}
