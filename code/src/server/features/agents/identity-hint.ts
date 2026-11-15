// A short display string from a login probe: plan and organisation only. Probe output can carry
// an email or a token, so each field is checked and anything that looks like either is dropped.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._()&'-]*$/;
const MAX_LENGTH = 48;
const LONGEST_WORD = 15;
const LONG_SEGMENT = 8;

// Separators split a value into words. A word that is long, or a dotted value of two long
// segments, is how opaque ids, JWTs and tokens look; plan and organisation names are not.
function plain(text: string): boolean {
  if (text.length > MAX_LENGTH || !SAFE.test(text)) return false;
  if (text.split(/[^A-Za-z0-9]+/).some((word) => word.length > LONGEST_WORD)) return false;
  return text.split(".").filter((part) => part.length >= LONG_SEGMENT).length < 2;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return plain(text) ? text : null;
}

function claudeHint(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const fields = parsed as Record<string, unknown>;
  const parts = [fields.subscriptionType, fields.orgName]
    .map(clean)
    .filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ").slice(0, MAX_LENGTH) : null;
}

function codexHint(stdout: string): string | null {
  const plan = clean(stdout.match(/^Plan:\s*(.+)$/m)?.[1]);
  return plan ? `ChatGPT ${plan}` : "ChatGPT";
}

export function identityHint(runtime: string, stdout: string): string | null {
  if (runtime === "claude") return claudeHint(stdout);
  if (runtime === "codex") return codexHint(stdout);
  return null;
}
