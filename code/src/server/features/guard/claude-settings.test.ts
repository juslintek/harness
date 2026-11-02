import { expect, test } from "bun:test";
import { claudeSettings, codexRules } from "./api";

test("claudeSettings carries the fixed deny list and the hook", () => {
  expect(claudeSettings("bun /h/guard-hook.ts")).toEqual({
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
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "bun /h/guard-hook.ts" }] }],
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
