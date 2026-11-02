import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettings, codexRules } from "./api";
import { hookCommand } from "./claude-settings";

test("claudeSettings carries the fixed deny list and the hook", () => {
  expect(claudeSettings("/b/bun", "/h/guard-hook.ts")).toEqual({
    permissions: {
      deny: [
        "Read(~/.ssh/**)",
        "Read(~/.aws/**)",
        "Read(~/.config/gh/**)",
        "Read(~/.gnupg/**)",
        "Read(~/.netrc)",
        "Bash(rm -rf ~*)",
        "Bash(rm -rf /*)",
        "Bash(git push --force*)",
        "Bash(security find-*)",
      ],
    },
    attribution: { commit: "", pr: "", sessionUrl: false },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: hookCommand("/b/bun", "/h/guard-hook.ts") }],
        },
      ],
    },
  });
});

test("codexRules is one forbidden prefix_rule per line", () => {
  const lines = codexRules().trim().split("\n");
  expect(lines).toHaveLength(12);
  for (const line of lines) {
    expect(line).toMatch(/^prefix_rule\(pattern=\["[^\]]+"\], decision="forbidden"/);
  }
  expect(lines[0]).toContain('pattern=["rm","-rf","/"]');
  expect(codexRules()).toContain('"diskutil","eraseDisk"');
});

async function launch(bin: string, script: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["sh", "-c", hookCommand(bin, script)], {
    stdin: new Blob(["{}"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

test("the hook launcher passes stdout through for a path with a space and a quote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness hook's "));
  try {
    const script = join(dir, "ask.ts");
    writeFileSync(script, 'console.log("passthrough");');
    expect(await launch(process.execPath, script)).toEqual({ code: 0, out: "passthrough\n" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook launcher exits 2 when the script cannot load or exits non-zero", async () => {
  expect((await launch(process.execPath, "/nonexistent dir/guard-hook.ts")).code).toBe(2);
  const dir = mkdtempSync(join(tmpdir(), "harness-hook-"));
  try {
    const script = join(dir, "one.ts");
    writeFileSync(script, "process.exit(1);");
    expect((await launch(process.execPath, script)).code).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
