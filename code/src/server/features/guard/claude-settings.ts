// Native deny rules the agent enforces on its own, so they hold even when the
// ACP permission flow is never consulted (read-only tools do not ask).
const CLAUDE_DENY = [
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.config/gh/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.netrc)",
  "Bash(rm -rf ~*)",
  "Bash(rm -rf /*)",
  "Bash(git push --force*)",
  "Bash(security find-*)",
];

export interface ClaudeSettings {
  permissions: { deny: string[] };
  attribution: { commit: string; pr: string; sessionUrl: boolean };
  hooks: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>;
  };
}

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

// Claude treats exit 1 from a hook as non-blocking, and a bun that cannot load the script exits 1.
// The wrapper maps every non-zero exit to 2 so a broken launcher blocks the tool call.
export function hookCommand(bin: string, script: string): string {
  const inner = `${quote(bin)} ${quote(script)}; c=$?; [ $c -eq 0 ] || exit 2`;
  return `sh -c ${quote(inner)}`;
}

export function claudeSettings(bin: string, script: string): ClaudeSettings {
  const hookCmd = hookCommand(bin, script);
  return {
    permissions: { deny: [...CLAUDE_DENY] },
    // Empty strings hide the Co-Authored-By trailer and the PR footer (claude 2.1.x).
    attribution: { commit: "", pr: "", sessionUrl: false },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd }] }] },
  };
}
