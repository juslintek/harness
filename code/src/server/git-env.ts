// Git hooks export these into the hook process. Left in place, a `git init` or `git worktree add`
// in a temp dir acts on the repository that is running the hook instead.
const REPO_LOCATING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export function gitEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !REPO_LOCATING.includes(key)) env[key] = value;
  }
  return env;
}
