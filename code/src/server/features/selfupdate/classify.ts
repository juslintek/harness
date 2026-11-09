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
  "src/server/features/selfupdate",
];
const GUARDED_FILES = new Set([
  "src/server/features/policies/routes.ts",
  "src/server/features/policies/proposals.ts",
  "src/server/features/policies/resolve.ts",
  "src/server/features/runtimes/launch.ts",
  "scripts/guard-hook.ts",
  ".dependency-cruiser.cjs",
  "biome.json",
  "lefthook.yml",
]);
const MIGRATIONS = "src/server/db/migrations";
const MIGRATION_TERMS = /approvals|sessions|passkey|grants/i;

// Compared in one canonical form so case, `./`, `//`, `..` and backslashes cannot dodge the
// prefixes. A leading `code/` is dropped because the harness app sits under it in the repo.
function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.normalize("NFC").replaceAll("\\", "/").toLowerCase().split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  if (parts[0] === "code") parts.shift();
  return parts.join("/");
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function guarded(path: string): boolean {
  const norm = normalise(path);
  return (
    GUARDED_DIRS.some((dir) => under(norm, dir)) ||
    GUARDED_FILES.has(norm) ||
    norm.includes("sandbox") ||
    norm.includes("srt")
  );
}

// A migration that cannot be read, or that is gone, is flagged: its content is unknown.
async function sensitiveMigration(change: Change, readNew: ReadNew): Promise<boolean> {
  if (change.oldPath !== undefined && under(normalise(change.oldPath), MIGRATIONS)) return true;
  if (!under(normalise(change.path), MIGRATIONS)) return false;
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
