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
  hooks: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>;
  };
}

export function claudeSettings(hookCmd: string): ClaudeSettings {
  return {
    permissions: { deny: [...CLAUDE_DENY] },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd }] }] },
  };
}
