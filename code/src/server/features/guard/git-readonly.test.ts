import { expect, test } from "bun:test";
import { evaluateL1 } from "./api";
import type { Scope } from "./l1";

const scope: Scope = { root: "/work/wt", home: "/home/u", defaultBranch: "main" };
const categoryOf = (command: string): string => {
  const got = evaluateL1({ kind: "execute", command, paths: [] }, scope);
  return got.verdict === "allow" ? got.category : got.verdict;
};

const READ = [
  "cat ~/.agents/skills/x/SKILL.md && git status && rg foo src",
  "cat ~/.agents/skills/x/SKILL.md; pwd; rg --files | head; git status --short",
  "git log --oneline -5",
  "git -C . diff --stat",
  "git -C src log",
  "git branch --show-current",
  "git branch --list 'feat*'",
  "git branch -a",
  "git branch --contains HEAD",
  "git --no-pager show HEAD:math.ts",
  "git tag -l 'v*'",
  "git tag",
  "git remote -v",
  "git remote get-url origin",
  "git worktree list",
  "git stash list",
  "git config --get user.name",
  "git log -p -- src/a.ts",
  "LANG=C git status",
  "LC_ALL=C TZ=UTC git log",
  "git grep -n foo -- src",
  "git rev-parse --show-toplevel",
];

const NOT_READ = [
  "git -c core.pager=sh log",
  "GIT_PAGER=sh git log",
  "PAGER=x git diff",
  "git --exec-path=/tmp log",
  "git log --output=/tmp/x",
  "git log --out=/tmp/x",
  "git diff --ext-diff",
  "git diff --textconv",
  "git branch -D x",
  "git branch feature",
  "git tag v1",
  "git tag -d v1",
  "git config user.name x",
  "git config --list",
  "git config --get user.name --unset",
  "git --git-dir=/elsewhere log",
  "git --git-dir /elsewhere log",
  "git -p log",
  "git --paginate log",
  "env GIT_DIR=/x git log",
  "env -i git status",
  "LD_PRELOAD=x git status",
  "FOO=1 cat x",
  "FOO=1; git status",
  "git -C /etc log",
  "git -C .. log",
  "git -C $X log",
  "git log $FLAGS",
  "git log `echo --output=x`",
  "git grep -O sh foo",
  "git grep --open-files-in-pager=sh foo",
  "git diff --no-index /etc/passwd x",
  "git blame --contents /etc/passwd x",
  "git remote add o http://x",
  "git remote remove o",
  "git worktree add ../x",
  "git stash drop",
  "git push",
  "git checkout main",
  "git status && git commit -m x",
  "./git status",
  "/tmp/git status",
  "git st",
  "git log --out*",
];

test("safe git and skill reads are category read", () => {
  const misses = READ.filter((c) => categoryOf(c) !== "read");
  expect(misses).toEqual([]);
});

test("git forms that write, page, run programs or read config values are not read", () => {
  const leaks = NOT_READ.filter((c) => categoryOf(c) === "read");
  expect(leaks).toEqual([]);
});
