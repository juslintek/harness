import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gitOutput } from "../../git-env";
import { defaultBranch, type RunRow } from "../runtimes/api";

const MANIFESTS: Record<string, string> = {
  "package.json": "node",
  "composer.json": "php",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  Gemfile: "ruby",
  "pom.xml": "jvm",
};

const FRAMEWORKS = new Set(["react", "preact", "vue", "svelte", "next", "hono", "express"]);

function isFramework(dep: string): boolean {
  return FRAMEWORKS.has(dep) || dep === "laravel/framework" || dep.startsWith("symfony/");
}

function dependencyNames(text: string | null): string[] {
  if (text === null) return [];
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "require", "require-dev"].flatMap((key) => {
      const section = json[key];
      return section && typeof section === "object" ? Object.keys(section) : [];
    });
  } catch {
    return [];
  }
}

function languageOf(name: string): string | undefined {
  return MANIFESTS[name] ?? (name.startsWith("build.gradle") ? "jvm" : undefined);
}

export function detectStack(files: string[], readFile: (path: string) => string | null): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const name = basename(file);
    const language = languageOf(name);
    if (language) found.add(language);
    if (name !== "package.json" && name !== "composer.json") continue;
    for (const dep of dependencyNames(readFile(file))) if (isFramework(dep)) found.add(dep);
  }
  return [...found];
}

function storeStack(db: Database, runId: string, items: string[]): void {
  const insert = db.query("INSERT OR IGNORE INTO run_stack (run_id, item) VALUES (?, ?)");
  for (const item of items) insert.run(runId, item);
}

async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const out = await gitOutput(cwd, args);
  return out === null ? [] : out.split("\n").filter(Boolean);
}

// Files the run touched: committed on its branch since the default branch, plus uncommitted ones.
// A worktree that is already gone yields no files, which just leaves the stack empty.
async function touchedFiles(run: RunRow): Promise<string[]> {
  if (run.worktree === null) return [];
  const base = await defaultBranch(run.repo).catch(() => null);
  const committed = base
    ? await gitLines(["diff", "--name-only", `${base}...HEAD`], run.worktree)
    : [];
  const dirty = (await gitLines(["status", "--porcelain"], run.worktree)).map((l) => l.slice(3));
  return [...new Set([...committed, ...dirty])];
}

export async function recordRunStack(db: Database, run: RunRow): Promise<void> {
  const worktree = run.worktree;
  if (worktree === null) return;
  const read = (path: string): string | null => {
    try {
      return readFileSync(join(worktree, path), "utf8");
    } catch {
      return null;
    }
  };
  storeStack(db, run.id, detectStack(await touchedFiles(run), read));
}
