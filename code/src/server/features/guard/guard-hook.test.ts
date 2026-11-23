import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case cold-starts a bun process, which can exceed the 5s default when the machine is busy.
setDefaultTimeout(30_000);

const script = join(import.meta.dir, "../../../../scripts/guard-hook.ts");
const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HARNESS_SCOPE_ROOT: "/work/tree",
  HARNESS_DEFAULT_BRANCH: "main",
  HOME: "/home/u",
};

async function hook(
  stdin: string,
  env: Record<string, string> = baseEnv,
  preload?: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", ...(preload ? ["--preload", preload] : []), script], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const bash = (command: string): string =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/work/tree" });

test("deny exits 2 with the reason on stderr", async () => {
  const res = await hook(bash("rm -rf ~"));
  expect(res.code).toBe(2);
  expect(res.err.length).toBeGreaterThan(0);
});

test("allow exits 0 silently", async () => {
  expect(await hook(bash("ls"))).toMatchObject({ code: 0, out: "" });
});

test("ask prints the permission decision", async () => {
  const res = await hook(bash("git push origin feature/x"));
  expect(res.code).toBe(0);
  expect(res.out).toContain('"permissionDecision":"ask"');
});

test("missing scope fails closed", async () => {
  const { HARNESS_SCOPE_ROOT: _drop, ...env } = baseEnv;
  expect((await hook(bash("ls"), env)).code).toBe(2);
});

test("reading a credential path is denied", async () => {
  const res = await hook(
    JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/home/u/.ssh/id_rsa" },
      cwd: "/work/tree",
    }),
  );
  expect(res.code).toBe(2);
});

test.each([
  ["null"],
  ['"x"'],
  ["[]"],
  ["1"],
  ["{}"],
  ['{"tool_name":"Bash"}'],
  ['{"tool_name":1,"tool_input":{}}'],
])("invalid hook input %s fails closed", async (stdin) => {
  const res = await hook(stdin);
  expect(res.code).toBe(2);
  expect(res.err).toContain("harness guard");
});

// L1 itself does not throw on hostile input, so the catch-all is driven by a preload that makes
// a stdlib call inside the hook fail (cwd is read when the input carries none).
test("a throw inside the hook fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-hook-"));
  const preload = join(dir, "throw-cwd.ts");
  await Bun.write(preload, 'process.cwd = () => { throw new Error("cwd gone"); };');
  const res = await hook(JSON.stringify({ tool_name: "Read", tool_input: {} }), baseEnv, preload);
  rmSync(dir, { recursive: true, force: true });
  expect(res.code).toBe(2);
  expect(res.err).toContain("cwd gone");
});

test("an unhandled rejection fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-hook-"));
  const preload = join(dir, "reject.ts");
  await Bun.write(
    preload,
    `const read = Bun.stdin.text.bind(Bun.stdin);
Object.defineProperty(Bun.stdin, "text", { value: async () => {
  Promise.reject(new Error("late boom"));
  await new Promise((r) => setTimeout(r, 50));
  return read();
} });`,
  );
  const res = await hook(bash("ls"), baseEnv, preload);
  rmSync(dir, { recursive: true, force: true });
  expect(res.code).toBe(2);
});

test("a valid unknown tool is still an ask, not an allow", async () => {
  const res = await hook(JSON.stringify({ tool_name: "Mystery", tool_input: {} }));
  expect(res.out).toContain('"permissionDecision":"ask"');
});

test("ToolSearch and harness MCP tools are allowed via toolName", async () => {
  expect(await hook(JSON.stringify({ tool_name: "ToolSearch", tool_input: {} }))).toMatchObject({
    code: 0,
    out: "",
  });
  expect(
    await hook(JSON.stringify({ tool_name: "mcp__harness__whoami", tool_input: {} })),
  ).toMatchObject({ code: 0, out: "" });
});

test("missing HOME fails closed", async () => {
  const { HOME: _drop, ...env } = baseEnv;
  expect((await hook(bash("ls"), env)).code).toBe(2);
});

test("unparseable stdin fails closed", async () => {
  expect((await hook("not json")).code).toBe(2);
});
