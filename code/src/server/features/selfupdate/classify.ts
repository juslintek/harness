export interface Change {
  status: string;
  path: string;
  oldPath?: string;
}

export type ReadNew = (path: string) => Promise<string | null>;

const GUARDED_DIRS = [
  "src/server/features/guard",
  "src/server/features/auth",
  "src/server/features/federation",
  "src/server/features/oauth",
  "src/server/features/mcp",
  "src/server/features/selfupdate",
];
export const GUARDED_FILES: ReadonlySet<string> = new Set([
  "src/server/features/policies/routes.ts",
  "src/server/features/policies/proposals.ts",
  "src/server/features/policies/resolve.ts",
  "src/server/features/runtimes/launch.ts",
  "src/server/features/runtimes/decide.ts",
  "src/server/features/orgs/roles.ts",
  "src/server/features/orgs/routes-kit.ts",
  "src/main.ts",
  "src/server/db/migrations.ts",
  "src/server/config.ts",
  "scripts/guard-hook.ts",
  ".dependency-cruiser.cjs",
  "biome.json",
  "lefthook.yml",
  "src/server/http.ts",
  "src/server/origin-app.ts",
  "src/server/packaged.ts",
  "src/server/acp-adapter.ts",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "scripts/build.ts",
]);
// For an extensionless import Bun 1.4.4 tries .tsx, .jsx, .mts and an exact extensionless file
// before .ts (checked with bun run and bun build), so such a sibling shadows a guarded module.
// .cts, .js, .mjs, .cjs and .json lose to .ts today but are flagged in case that order changes.
// json is a shadow candidate but never a guarded stem.
export const SOURCE_EXT: RegExp = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SHADOW_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json)$/;
const GUARDED_STEMS: ReadonlySet<string> = new Set(
  [...GUARDED_FILES]
    .filter((file) => SOURCE_EXT.test(file))
    .map((file) => file.replace(SOURCE_EXT, "")),
);
const SQL_DIR = "src/server/db";
// Substrings, not words: `\b` does not match inside snake_case names like team_members.
const MIGRATION_TERMS = new RegExp(
  [
    "approvals",
    "sessions",
    "passkey",
    "grants",
    "tokens",
    "users",
    "members",
    "polic",
    "peers",
    "fed_invites",
    "oidc_",
    "oauth_",
    "recovery_codes",
    "email_codes",
    "enrollments",
    "challenges",
    "notify_targets",
    "instance",
    "update_requests",
    "deploy_requests",
  ].join("|"),
  "i",
);
const TSCONFIG = /^tsconfig[^/]*$/;
const NESTED_CONFIG = /^(package\.json|tsconfig[^/]*|jsconfig\.json|bunfig\.toml)$/;
// Case-insensitive APFS folds more than toLowerCase does (U+017F, ligatures) and a checkout also
// strips trailing dots and spaces, so a path like these can land on a guarded file unseen by the
// normalised matching. Any such path, and any control character, is flagged outright.
const NOT_PRINTABLE_ASCII = /[^ -~]/;

// Compared in one canonical form so case, `./`, `//`, `..` and backslashes cannot dodge the
// prefixes. A leading `code/` is dropped because the harness app sits under it in the repo.
export function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.normalize("NFC").replaceAll("\\", "/").toLowerCase().split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  if (parts[0] === "code") parts.shift();
  return parts.join("/");
}

const isSql = (path: string): boolean => {
  const norm = normalise(path);
  return under(norm, SQL_DIR) && norm.endsWith(".sql");
};

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function disguised(path: string): boolean {
  if (NOT_PRINTABLE_ASCII.test(path)) return true;
  return path.split(/[/\\]/).some((part) => part !== "." && part !== ".." && /[. ]$/.test(part));
}

// A nested node_modules or config file redirects bare imports of guarded modules.
function nestedResolution(norm: string): boolean {
  const parts = norm.split("/");
  return parts.includes("node_modules") || NESTED_CONFIG.test(parts[parts.length - 1] ?? "");
}

function guarded(path: string): boolean {
  const norm = normalise(path);
  return (
    disguised(path) ||
    nestedResolution(norm) ||
    GUARDED_DIRS.some((dir) => under(norm, dir)) ||
    GUARDED_FILES.has(norm) ||
    GUARDED_STEMS.has(norm.replace(SHADOW_EXT, "")) ||
    TSCONFIG.test(norm) ||
    norm.includes("sandbox") ||
    norm.includes("srt")
  );
}

// A migration that cannot be read, or that is gone, is flagged: its content is unknown.
async function sensitiveMigration(change: Change, readNew: ReadNew): Promise<boolean> {
  if (change.oldPath !== undefined && isSql(change.oldPath)) return true;
  if (!isSql(change.path)) return false;
  if (change.status.startsWith("D")) return true;
  const text = await readNew(change.path);
  return text === null || MIGRATION_TERMS.test(text);
}

export async function classify(
  changes: Change[],
  readNew: ReadNew = async () => null,
): Promise<{ flagged: string[] }> {
  const flagged = new Set<string>();
  for (const change of changes) {
    for (const path of [change.path, change.oldPath]) {
      if (path !== undefined && guarded(path)) flagged.add(path);
    }
    if (await sensitiveMigration(change, readNew)) flagged.add(change.path);
  }
  return { flagged: [...flagged] };
}
