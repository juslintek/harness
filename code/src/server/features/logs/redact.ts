const SECRET_WORDS = "password|passwd|secret|token|api[_-]?key|access[_-]?key";

// [kind, pattern, replacement]. A leading $1 keeps the key or scheme so the log stays readable.
const RULES: ReadonlyArray<readonly [string, RegExp, string]> = [
  [
    "private-key",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[REDACTED:private-key]",
  ],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED:anthropic-key]"],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED:openai-key]"],
  [
    "github-token",
    /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g,
    "[REDACTED:github-token]",
  ],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED:aws-key]"],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED:google-key]"],
  ["stripe-key", /\b[sr]k_live_[A-Za-z0-9]{16,}/g, "[REDACTED:stripe-key]"],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED:npm-token]"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED:jwt]"],
  ["bearer", /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED:bearer]"],
  [
    "basic-auth",
    /(authorization["']?\s*[:=]\s*["']?)basic\s+[A-Za-z0-9+/=]{8,}/gi,
    "$1[REDACTED:basic-auth]",
  ],
  [
    "url-credentials",
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    "$1[REDACTED:url-credentials]@",
  ],
  [
    "cli-secret",
    new RegExp(`(--(?:${SECRET_WORDS})[=\\s]+)(?!\\[REDACTED)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"),
    "$1[REDACTED:secret]",
  ],
  [
    "secret",
    new RegExp(
      `(["']?\\b[\\w-]*(?:${SECRET_WORDS})["']?\\s*[:=]\\s*)(?!\\[REDACTED)("[^"]*"|'[^']*'|[^\\s"',;&}]+)`,
      "gi",
    ),
    "$1[REDACTED:secret]",
  ],
];

// AWS secret keys have no fixed prefix, so they are only caught right after an access key id.
const AWS_SECRET = /(\[REDACTED:aws-key\][\s:=,"']*)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [, re, replacement] of RULES) out = out.replace(re, replacement);
  return out.replace(AWS_SECRET, "$1[REDACTED:aws-secret]");
}
