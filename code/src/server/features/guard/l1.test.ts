import { expect, test } from "bun:test";
import { corpus } from "./corpus";
import { type ActionRequest, type Category, evaluateL1, type Scope, splitCommands } from "./l1";

const scope: Scope = { root: "/work/wt", home: "/home/u", defaultBranch: "main" };
const run = (action: ActionRequest) => evaluateL1(action, scope);
const exec = (command: string) => run({ kind: "execute", command, paths: [] });

test("corpus has enough cases", () => {
  expect(corpus.length).toBeGreaterThanOrEqual(120);
});

test("every corpus case matches", () => {
  const misses = corpus.flatMap(({ cmd, expect: want }) => {
    const got = exec(cmd);
    return got.verdict === want
      ? []
      : [`${JSON.stringify(cmd)}: want ${want}, got ${got.verdict} (${got.rule})`];
  });
  expect(misses.join("\n")).toBe("");
});

test("non-shell actions", () => {
  expect(run({ kind: "edit", paths: ["/etc/hosts"] }).verdict).toBe("deny");
  expect(run({ kind: "edit", paths: ["/work/wt/src/a.ts"] }).verdict).toBe("allow");
  expect(run({ kind: "edit", paths: ["src/a.ts", "/etc/hosts"] }).verdict).toBe("deny");
  expect(run({ kind: "edit", paths: ["/work/wt/.git/hooks/pre-commit"] }).verdict).toBe("deny");
  expect(run({ kind: "edit", paths: ["/work/wt/.git"] }).verdict).toBe("deny");
  expect(run({ kind: "edit", paths: ["/work/wt/.gitignore"] }).verdict).toBe("allow");
  expect(run({ kind: "delete", paths: ["/work/wt/a"] })).toMatchObject({
    verdict: "allow",
    category: "delete",
  });
  const read = run({ kind: "read", paths: ["/work/wt/src/a.ts"] });
  expect(read).toMatchObject({ verdict: "allow", category: "read" });
  expect(run({ kind: "read", paths: ["~/.aws/credentials"] })).toMatchObject({
    verdict: "deny",
    category: "secret",
  });
  expect(run({ kind: "read", paths: ["/etc/hosts"] }).verdict).toBe("ask");
  expect(run({ kind: "fetch", paths: [] }).verdict).toBe("ask");
  expect(run({ kind: "other", paths: [] }).verdict).toBe("ask");
  expect(run({ kind: "other", paths: [], toolName: "ToolSearch" }).verdict).toBe("allow");
});

test("result carries rule and category", () => {
  expect(exec("git push origin main")).toMatchObject({
    verdict: "deny",
    rule: "git.push-default-branch",
  });
  expect(exec("git push")).toMatchObject({ verdict: "ask", category: "git_push" });
  expect(exec("rm a")).toMatchObject({ verdict: "allow", category: "delete" });
  const secret: Category = "secret";
  expect(exec("cat ~/.ssh/id_rsa").category).toBe(secret);
});

test("splitCommands unwraps wrappers and substitutions", () => {
  expect(splitCommands("a b && c | d; e")).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
  expect(splitCommands("sudo env X=1 nice -n 5 rm -rf x")).toEqual([["rm", "-rf", "x"]]);
  expect(splitCommands('bash -c "ls; pwd"')).toContainEqual(["pwd"]);
  expect(splitCommands("echo $(whoami)")).toContainEqual(["whoami"]);
  expect(splitCommands("FOO=1 ls 'a b'")).toEqual([["ls", "a b"]]);
});

test("secrets.json under a custom HARNESS_HOME is a credential location", () => {
  const custom: Scope = { ...scope, harnessHome: "/data/h" };
  const at = (command: string) => evaluateL1({ kind: "execute", command, paths: [] }, custom);
  for (const command of [
    "cat /data/h/secrets.json",
    "cp /data/h/secrets.json /tmp/k",
    "cat /data/h/secrets*",
    "rg token /data",
  ])
    expect(at(command).verdict).not.toBe("allow");
  expect(at("cat /data/h/secrets.json")).toMatchObject({ verdict: "deny", category: "secret" });
  expect(evaluateL1({ kind: "read", paths: ["/data/h/secrets.json"] }, custom).verdict).toBe(
    "deny",
  );
  expect(at("cat /data/h/harness.db").rule).not.toBe("secret.path");
  expect(exec("cat /data/h/secrets.json").rule).not.toBe("secret.path");
});
