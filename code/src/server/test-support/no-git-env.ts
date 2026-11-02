import { gitEnv } from "../git-env";

// A pre-push hook runs `bun test` with GIT_DIR set, and tests that call git directly would act on
// the real repository. Bun.spawn snapshots the launch env and ignores later deletes from
// process.env, so the default env of every spawn is replaced here instead.
type SpawnOpts = { env?: Record<string, string | undefined> } & Record<string, unknown>;

for (const name of ["spawn", "spawnSync"] as const) {
  const real = Bun[name] as (cmd: unknown, opts?: SpawnOpts) => unknown;
  const wrapped = (cmd: unknown, opts?: SpawnOpts): unknown => {
    const arrayForm = Array.isArray(cmd);
    const options = (arrayForm ? opts : (cmd as SpawnOpts)) ?? {};
    const patched = { ...options, env: options.env ?? gitEnv() };
    return arrayForm ? real(cmd, patched) : real(patched);
  };
  Object.assign(Bun, { [name]: wrapped });
}
