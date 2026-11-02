import { expect, test } from "bun:test";
import { redact } from "./api";

const jwt =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

const cases: Array<[string, string, string]> = [
  ["anthropic", "key sk-ant-api03-abcDEF123456_xyz end", "key [REDACTED:anthropic-key] end"],
  ["openai", "key sk-proj-abcDEF1234567890abcdEF end", "key [REDACTED:openai-key] end"],
  ["github", "t ghp_abcdefghijklmnopqrstuvwxyz0123456789 e", "t [REDACTED:github-token] e"],
  [
    "github pat",
    "t github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz e",
    "t [REDACTED:github-token] e",
  ],
  ["bearer", "Authorization: Bearer abc123.def456-ghi", "Authorization: [REDACTED:bearer]"],
  ["env", "run PASSWORD=hunter2 now", "run PASSWORD=[REDACTED:secret] now"],
  ["env prefixed", "GITHUB_TOKEN=abc x", "GITHUB_TOKEN=[REDACTED:secret] x"],
  [
    "lowercase assignment",
    "password=hunter2 api_key=abc123",
    "password=[REDACTED:secret] api_key=[REDACTED:secret]",
  ],
  ["colon assignment", "secret: s3cr3t!", "secret: [REDACTED:secret]"],
  ["json", '{"password":"hunter2","n":1}', '{"password":[REDACTED:secret],"n":1}'],
  ["cli flag", "tool --password hunter2 --verbose", "tool --password [REDACTED:secret] --verbose"],
  ["quoted with spaces", 'PASSWORD="a b c" next', "PASSWORD=[REDACTED:secret] next"],
  ["lowercase bearer", "Authorization: bearer abcdef123456", "Authorization: [REDACTED:bearer]"],
  ["basic", "Authorization: Basic dXNlcjpwYXNz", "Authorization: [REDACTED:basic-auth]"],
  [
    "url userinfo",
    "clone https://bob:pw123@github.com/x.git",
    "clone https://[REDACTED:url-credentials]@github.com/x.git",
  ],
  ["x-api-key", "-H 'X-Api-Key: abc123def'", "-H 'X-Api-Key: [REDACTED:secret]'"],
  ["slack", "t xoxb-1234567890-abcdefghij e", "t [REDACTED:slack-token] e"],
  ["google", "k AIzaSyA1234567890abcdefghijklmnopqrstuv e", "k [REDACTED:google-key] e"],
  ["stripe", "k sk_live_abcdefghijklmnop1234 e", "k [REDACTED:stripe-key] e"],
  ["npm", "k npm_abcdefghijklmnopqrstuvwxyz0123456789 e", "k [REDACTED:npm-token] e"],
  ["jwt", `tok ${jwt} end`, "tok [REDACTED:jwt] end"],
  [
    "private key",
    "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nb",
    "a\n[REDACTED:private-key]\nb",
  ],
];

for (const [name, input, expected] of cases) {
  test(`redacts ${name}`, () => {
    expect(redact(input)).toBe(expected);
  });
}

test("redacts an AWS access key id and its secret", () => {
  const out = redact("AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  expect(out).toBe("[REDACTED:aws-key] [REDACTED:aws-secret]");
});

test("leaves plain text unchanged", () => {
  const text =
    "ls -la /tmp/foo_bar && echo token count is 5; sk-learn is a library; max_tokens=100 --token-count 5";
  expect(redact(text)).toBe(text);
});
