import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { withRealpaths } from "./real-paths";
import { buildSrtSettings, runTmpDir, scrubEnv, wrapCommand } from "./sandbox";
import { baseInput } from "./sandbox-kit";

test("settings snapshot: paths expanded, domains merged without duplicates", () => {
  const s = buildSrtSettings(baseInput);
  const uid = process.getuid?.();
  expect(s.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
  expect(s.filesystem.denyRead).toContain("/hh/harness.db*");
  expect(s.filesystem.denyRead).toContain("/hh/secret");
  expect(s.filesystem.denyRead).toContain("/hh/secrets.*");
  expect(s.filesystem.denyRead).toContain("/hh/memory");
  expect(s.filesystem.allowWrite).toEqual(
    expect.arrayContaining([
      "/wt/r1",
      "/repo/.git/objects",
      "/repo/.git/worktrees/r1",
      "/repo/.git/refs/heads/harness/r1",
      "/repo/.git/refs/heads/harness/r1.lock",
      "/repo/.git/logs/refs/heads/harness/r1",
      join(homedir(), ".claude"),
      `/private/tmp/claude-${uid}`,
      "/private/tmp/claude-*-cwd",
    ]),
  );
  expect(s.filesystem.allowWrite).not.toContain("/repo/.git");
  expect(s.filesystem.denyRead).toContain(join(homedir(), ".codex/auth.json"));
  expect(s.filesystem.denyRead).toContain(join(homedir(), ".gemini/oauth_creds.json"));
  expect(s.filesystem.denyRead).not.toContain(join(homedir(), ".claude/.credentials.json"));
  expect(s.filesystem.denyRead).toEqual(
    expect.arrayContaining(["/hh/runs", "/hh/worktrees", "/hh/scratch-checkouts"]),
  );
  expect(s.filesystem.allowRead).toEqual(["/runs/r1", "/wt/r1"]);
  expect(s.network.allowLocalBinding).toBe(true);
  expect(s.network.deniedDomains).toEqual([]);
  expect(s.enableWeakerNetworkIsolation).toBe(true);
  expect(s.network.allowedDomains.filter((d) => d === "github.com")).toHaveLength(1);
  expect(s.network.allowedDomains).toContain("api.anthropic.com");
  expect(s.network.allowedDomains).toContain("registry.npmjs.org");
});

test("git admin pointers and agent code and config dirs are write-denied", () => {
  const denied = buildSrtSettings(baseInput).filesystem.denyWrite;
  expect(denied).toEqual(
    expect.arrayContaining([
      "/repo/.git/hooks",
      "/repo/.git/config",
      "/repo/.git/modules",
      "/repo/.git/worktrees/r1/config.worktree",
      "/repo/.git/worktrees/r1/commondir",
      "/repo/.git/worktrees/r1/gitdir",
      "/wt/r1/.git",
      "/wt/r1/.claude",
      "/wt/r1/.codex",
      join(homedir(), ".codex/rules"),
      join(homedir(), ".claude/shell-snapshots"),
      join(homedir(), ".claude.json"),
      join(homedir(), ".claude/settings.local.json"),
      join(homedir(), ".claude/plugins"),
      join(homedir(), ".claude/skills"),
      join(homedir(), ".claude/commands"),
      join(homedir(), ".gemini/settings.json"),
      join(homedir(), ".gemini/antigravity-cli/settings.json"),
    ]),
  );
});

test("the worktree's .mcp.json is write-denied", () => {
  expect(buildSrtSettings(baseInput).filesystem.denyWrite).toContain("/wt/r1/.mcp.json");
});

test("a denied path reached through a symlink is denied by its real path too", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-link-")));
  try {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "link"));
    writeFileSync(join(real, "mcp-target.json"), "{}");
    symlinkSync(join(real, "mcp-target.json"), join(real, ".mcp.json"));
    const { denyWrite } = buildSrtSettings({
      ...baseInput,
      worktree: join(dir, "link"),
    }).filesystem;
    expect(denyWrite).toContain(join(dir, "link/.mcp.json"));
    expect(denyWrite).toContain(join(real, "mcp-target.json"));
    expect(denyWrite).toContain(join(real, ".claude"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("presets and missing git dir", () => {
  const off = buildSrtSettings({ ...baseInput, preset: "offline", gitCommonDir: null });
  expect(off.network.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
  expect(off.filesystem.allowWrite).not.toContain("/repo/.git");
  expect(off.filesystem.denyWrite.some((p) => typeof p === "string" && p.startsWith("/repo"))).toBe(
    false,
  );
  const open = buildSrtSettings({ ...baseInput, preset: "open-web" });
  expect(open.network.allowedDomains).toContain("*");
});

test("scrubEnv keeps the allowlist and drops secrets", () => {
  const out = scrubEnv(
    {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      ANTHROPIC_API_KEY: "k",
      GH_TOKEN: "t",
      AWS_SECRET_ACCESS_KEY: "s",
    },
    { HARNESS_TOKEN: "x" },
  );
  expect(out).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", HARNESS_TOKEN: "x" });
});

test("wrapCommand fails when the settings file is missing", () => {
  expect(() => wrapCommand("/nonexistent/srt.json", ["true"])).toThrow(/settings/);
});

test("a run may read its own agent's credentials and not the others'", () => {
  const codex = buildSrtSettings({ ...baseInput, agentId: "codex" }).filesystem.denyRead;
  expect(codex).not.toContain(join(homedir(), ".codex/auth.json"));
  expect(codex).toContain(join(homedir(), ".claude/.credentials.json"));
  const agy = buildSrtSettings({ ...baseInput, agentId: "agy" }).filesystem.denyRead;
  expect(agy).not.toContain(join(homedir(), ".gemini/oauth_creds.json"));
  expect(agy).toContain(join(homedir(), ".codex/auth.json"));
  const copilotToken = join(homedir(), ".config/github-copilot/oauth.json");
  expect(agy).toContain(copilotToken);
  expect(buildSrtSettings({ ...baseInput, agentId: "copilot" }).filesystem.denyRead).not.toContain(
    copilotToken,
  );
});

test("git access without the worktree dir and branch is refused", () => {
  expect(() => buildSrtSettings({ ...baseInput, gitWorktreeDir: null })).toThrow(/run branch/);
});

test("codex home is writable but its rules and config are not", () => {
  const s = buildSrtSettings({ ...baseInput, codexHome: "/runs/r1/codex-home" });
  expect(s.filesystem.allowWrite).toContain("/runs/r1/codex-home");
  expect(s.filesystem.denyWrite).toEqual(
    expect.arrayContaining(["/runs/r1/codex-home/rules", "/runs/r1/codex-home/config.toml"]),
  );
});

test("unsafe inputs are refused", () => {
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["~"] })).toThrow(/home/);
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["/"] })).toThrow(/home/);
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["relative/dir"] })).toThrow(
    /absolute/,
  );
  expect(() => buildSrtSettings({ ...baseInput, worktree: "wt" })).toThrow(/absolute/);
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["/hh"] })).toThrow(
    /expose the harness home/,
  );
});

test("a harness home under the system tmp dir is accepted, and runs get their own tmp", () => {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  try {
    const s = buildSrtSettings({ ...baseInput, harnessHome: home });
    expect(s.filesystem.allowWrite).toContain(runTmpDir("/runs/r1"));
    expect(s.filesystem.allowWrite).not.toContain(tmpdir());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a read-only worktree drops the worktree and git refs from allowWrite", () => {
  const { allowWrite } = buildSrtSettings({ ...baseInput, readOnlyWorktree: true }).filesystem;
  expect(allowWrite).not.toContain("/wt/r1");
  expect(allowWrite.filter((p) => String(p).startsWith("/repo/.git"))).toEqual([]);
  expect(allowWrite).toContain(runTmpDir("/runs/r1"));
  expect(allowWrite).toContain(join(homedir(), ".claude"));
});

test("another run's scratch checkout is unreadable, the run's own stays readable", () => {
  const scratch = { path: "/hh/scratch-checkouts/r1", gitDir: "/repo/.git/worktrees/r11" };
  const { filesystem } = buildSrtSettings({ ...baseInput, readOnlyWorktree: true, scratch });
  expect(filesystem.denyRead).toContain("/hh/scratch-checkouts");
  expect(filesystem.allowRead).toContain(scratch.path);
});

test("a read-only run's scratch checkout and its admin dir are writable, refs and objects are not", () => {
  const scratch = { path: "/hh/scratch-checkouts/r1", gitDir: "/repo/.git/worktrees/r11" };
  const { filesystem } = buildSrtSettings({ ...baseInput, readOnlyWorktree: true, scratch });
  expect(filesystem.allowWrite).toEqual(expect.arrayContaining([scratch.path, scratch.gitDir]));
  expect(filesystem.allowWrite).not.toContain("/wt/r1");
  expect(filesystem.allowWrite).not.toContain("/repo/.git/objects");
  expect(
    filesystem.allowWrite.filter((p) => String(p).startsWith("/repo/.git") && p !== scratch.gitDir),
  ).toEqual([]);
  expect(filesystem.denyWrite).toEqual(
    expect.arrayContaining([join(scratch.path, ".git"), join(scratch.gitDir, "commondir")]),
  );
});

test("a missing path under a symlinked directory is denied at its real location too", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-deep-")));
  try {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const deep = join(dir, "link/antigravity-cli/state/token.json");
    expect(withRealpaths([deep])).toEqual([
      deep,
      join(dir, "real/antigravity-cli/state/token.json"),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-denied paths under a symlinked or missing directory are denied at the real location too", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-read-")));
  try {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const { denyRead } = buildSrtSettings({
      ...baseInput,
      harnessHome: join(dir, "link/deeper/home"),
    }).filesystem;
    expect(denyRead).toContain(join(dir, "link/deeper/home/secret"));
    expect(denyRead).toContain(join(dir, "real/deeper/home/secret"));
    expect(denyRead).toContain(join(dir, "real/deeper/home/harness.db*"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
