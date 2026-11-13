import { expect, test } from "bun:test";
import { join } from "node:path";
import { type Change, classify, GUARDED_FILES, normalise, SOURCE_EXT } from "./classify";

const G = "code/src/server/features/guard/x.ts";
const mod = (path: string): Change => ({ status: "M", path });
const flaggedFor = async (change: Change, text = "select 1"): Promise<string[]> =>
  (await classify([change], async () => text)).flagged;

const FLAGGED: [string, Change][] = [
  ["guard file", mod(G)],
  ["auth file", mod("code/src/server/features/auth/passkeys.ts")],
  ["federation sign file", mod("code/src/server/features/federation/sign.ts")],
  ["policies proposals", mod("code/src/server/features/policies/proposals.ts")],
  ["launcher", mod("code/src/server/features/runtimes/launch.ts")],
  ["guard hook", mod("code/scripts/guard-hook.ts")],
  ["oauth", mod("code/src/server/features/oauth/api.ts")],
  ["pipeline itself", mod("code/src/server/features/selfupdate/pipeline.ts")],
  ["classifier itself", mod("code/src/server/features/selfupdate/classify.ts")],
  ["sandbox profile", mod("code/config/sandbox-profile.json")],
  ["srt", mod("code/src/server/srt-wrap.ts")],
  ["depcruise config", mod("code/.dependency-cruiser.cjs")],
  ["biome config", mod("code/biome.json")],
  ["lefthook", mod("lefthook.yml")],
  ["upper case", mod("Code/Src/Server/Features/Guard/x.ts")],
  ["dot slash", mod("./code/src/server/features/guard/x.ts")],
  ["double slash", mod("code/src/server/features//guard/x.ts")],
  ["dotdot", mod("code/src/server/features//auth/../auth/x.ts")],
  ["dotdot out of a harmless dir", mod("code/src/web/../server/features/guard/x.ts")],
  ["backslashes", mod("code\\src\\server\\features\\guard\\x.ts")],
  ["deleted guard file", { status: "D", path: G }],
  ["type change in guard", { status: "T", path: G }],
  ["rename out of guard", { status: "R100", path: "code/src/lib/x.ts", oldPath: G }],
  ["rename into guard", { status: "R090", path: G, oldPath: "code/src/lib/x.ts" }],
  ["http mounting", mod("code/src/server/http.ts")],
  ["origin app", mod("code/src/server/origin-app.ts")],
  ["mcp tools", mod("code/src/server/features/mcp/tools.ts")],
  ["package.json", mod("code/package.json")],
  ["bun.lock", mod("code/bun.lock")],
  ["bunfig", mod("code/bunfig.toml")],
  ["tsconfig", mod("code/tsconfig.json")],
  ["tsconfig variant", mod("code/tsconfig.build.json")],
  ["build script", mod("code/scripts/build.ts")],
  ["migration mentioning approvals", mod("code/src/server/db/migrations/040_x.sql")],
];

test.each(FLAGGED)("flags %s", async (_name, change) => {
  const text = change.path.includes("migrations") ? "ALTER TABLE approvals ADD x" : "select 1";
  expect((await flaggedFor(change, text)).length).toBeGreaterThan(0);
});

test.each([
  ["board routes", "code/src/server/features/board/routes.ts"],
  ["web tsx", "code/src/web/App.tsx"],
  ["docs", "docs/design.md"],
  ["a notes file named like the dir", "code/src/server/features/board/guard-notes.md"],
  ["a sibling dir with the same prefix", "code/src/server/features/guarded/x.ts"],
  ["unrelated migration", "code/src/server/db/migrations/041_x.sql"],
])("does not flag %s", async (_name, path) => {
  expect(await flaggedFor(mod(path))).toEqual([]);
});

test("migration terms are matched case-insensitively and unreadable or deleted ones flag", async () => {
  const path = "code/src/server/db/migrations/042_x.sql";
  expect(await flaggedFor(mod(path), "create table PassKey_x")).toEqual([path]);
  expect(await flaggedFor(mod(path), "alter table grants add y")).toEqual([path]);
  expect((await classify([mod(path)], async () => null)).flagged).toEqual([path]);
  expect((await classify([mod(path)])).flagged).toEqual([path]);
  expect(await flaggedFor({ status: "D", path })).toEqual([path]);
});

test.each(["users", "members", "policies", "peers", "fed_invites", "run_tokens", "oauth_tokens"])(
  "a migration touching %s is flagged",
  async (table) => {
    const path = "code/src/server/db/migrations/043_x.sql";
    expect(await flaggedFor(mod(path), `UPDATE ${table} SET x = 1`)).toEqual([path]);
  },
);

test("a migration on an unrelated table is not flagged", async () => {
  const path = "code/src/server/db/migrations/044_x.sql";
  expect(await flaggedFor(mod(path), "ALTER TABLE board_cards ADD note TEXT")).toEqual([]);
});

test("a rename reports the side that matched", async () => {
  const out = { status: "R100", path: "code/src/lib/x.ts", oldPath: G };
  expect(await flaggedFor(out)).toEqual([G]);
});

const AUTHZ_FILES = [
  "code/src/server/features/runtimes/decide.ts",
  "code/src/server/features/orgs/roles.ts",
  "code/src/server/features/orgs/routes-kit.ts",
  "code/src/main.ts",
  "code/src/server/db/migrations.ts",
  "code/src/server/config.ts",
];

test.each(AUTHZ_FILES)(
  "authorization path %s is flagged as modify, delete and rename",
  async (path) => {
    expect(await flaggedFor(mod(path))).toEqual([path]);
    expect(await flaggedFor({ status: "D", path })).toEqual([path]);
    const out = { status: "R100", path: "code/src/lib/x.ts", oldPath: path };
    expect(await flaggedFor(out)).toEqual([path]);
    const into = { status: "R100", path, oldPath: "code/src/lib/x.ts" };
    expect(await flaggedFor(into)).toEqual([path]);
  },
);

test.each([
  "oidc_providers",
  "oidc_identities",
  "recovery_codes",
  "email_codes",
  "enrollments",
  "challenges",
  "oauth_clients",
  "oauth_codes",
  "notify_targets",
  "team_members",
  "channel_members",
  "bridge_users",
  "policy_rules",
  "update_requests",
  "deploy_requests",
  "instance",
])("a migration touching snake_case table %s is flagged", async (table) => {
  const path = "code/src/server/db/migrations/045_x.sql";
  expect(await flaggedFor(mod(path), `INSERT INTO ${table} (a) VALUES (1)`)).toEqual([path]);
});

test("a migration outside the migrations folder but under db is content-checked", async () => {
  const path = "code/src/server/db/seed/001_x.sql";
  expect(await flaggedFor(mod(path), "INSERT INTO oidc_providers (id) VALUES ('x')")).toEqual([
    path,
  ]);
  expect(await flaggedFor(mod(path), "select 1")).toEqual([]);
});

const SHADOW_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", ""];
const GUARDED_SOURCES = [...GUARDED_FILES].filter((f) => SOURCE_EXT.test(f));

// For an extensionless import Bun 1.4.4 tries .tsx, .jsx, .mts and an exact extensionless file
// before .ts, so such a sibling shadows the module (.cts and .js do not win, but are flagged too).
test.each(GUARDED_SOURCES)("sibling extension variants of %s are flagged", async (file) => {
  const stem = file.replace(/\.\w+$/, "");
  for (const ext of SHADOW_EXT) {
    const path = ext === "" ? `code/${stem}` : `code/${stem}.${ext}`;
    expect(await flaggedFor(mod(path))).toEqual([path]);
    expect(await flaggedFor({ status: "D", path })).toEqual([path]);
    const out = { status: "R100", path: "code/src/lib/x.ts", oldPath: path };
    expect(await flaggedFor(out)).toEqual([path]);
  }
});

test("non-source guarded files still match exactly", async () => {
  expect(await flaggedFor(mod("code/biome.ts"))).toEqual([]);
  expect(await flaggedFor(mod("code/package.ts"))).toEqual([]);
  expect(await flaggedFor(mod("lefthook.json"))).toEqual([]);
});

// Entries are relative to the code dir, except repo-root files like lefthook.yml. A typo in
// this list silently leaves the real file unguarded, so every entry must be a tracked path.
// `git ls-files` is case-sensitive; existsSync is not on APFS, so a case typo would pass it.
const repoRoot = join(import.meta.dir, "../../../../..");
const tracked = new Set(
  Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot }).stdout.toString().split("\n"),
);

test.each([...GUARDED_FILES])("guarded file %s is tracked and already normalised", (file) => {
  expect(tracked.has(`code/${file}`) || tracked.has(file)).toBe(true);
  expect(file).toBe(normalise(file));
});
