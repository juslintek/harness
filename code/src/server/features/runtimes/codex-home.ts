import { mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Per run and rebuilt from scratch, so nothing an earlier run wrote (rules, config) survives.
// Only auth.json is linked: the user's config.toml and rules must not reach the run.
export async function prepareCodexHome(
  runDir: string,
  rulesText: string,
  realCodexDir: string = join(homedir(), ".codex"),
): Promise<string> {
  const home = join(runDir, "codex-home");
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, "rules"), { recursive: true });
  await symlink(join(realCodexDir, "auth.json"), join(home, "auth.json"));
  await Bun.write(join(home, "rules", "harness.rules"), rulesText);
  return home;
}
