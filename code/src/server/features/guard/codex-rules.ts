// Codex matches these as argv prefixes after unwrapping `zsh -lc`; a hit is
// rejected before any process starts and never reaches the ACP permission flow.
const FORBIDDEN_PREFIXES: string[][] = [
  ["rm", "-rf", "/"],
  ["rm", "-rf", "~"],
  ["rm", "-rf", "$HOME"],
  ["git", "push", "--force"],
  ["git", "push", "-f"],
  ["git", "reset", "--hard"],
  ["git", "clean", "-fdx"],
  ["security", "find-generic-password"],
  ["security", "find-internet-password"],
  ["dd"],
  ["mkfs"],
  ["diskutil", "eraseDisk"],
];

export function codexRules(): string {
  const lines = FORBIDDEN_PREFIXES.map(
    (p) =>
      `prefix_rule(pattern=${JSON.stringify(p)}, decision="forbidden", justification="blocked by harness guard")`,
  );
  return `${lines.join("\n")}\n`;
}
