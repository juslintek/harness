// Regenerates the fixtures the Zig logs tests read: a zstd segment sealed by the TS server and
// the TS redact() output for a corpus. From code/: bun ../zig/src/logs/fixtures/gen.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations, openSeedDb } from "../../../../code/conformance/kit/seed";
import { appendEvent, redact, sealSegments } from "../../../../code/src/server/features/logs/api";

const dir = import.meta.dir;

const RUN = "00000000-0000-7000-8000-000000000001";
const filler = "lorem ipsum dolor sit amet ".repeat(5_000);
const bodies = [
  "first body about deploys",
  "Šis įrašas turi lietuviškų raidžių: ąčęėįšųūž",
  "emoji 🙂 and text after it",
  `${filler}needlemarker${filler}`,
];

const db = openSeedDb(":memory:");
applyMigrations(db);
const events = bodies.map((body, i) => {
  const r = appendEvent(db, { runId: RUN, kind: "message", ts: 1_700_000_000_000 + i, body });
  if (!r) throw new Error("append failed");
  return { rowid: r.rowid, id: r.id, body };
});
if (sealSegments(db, { runId: RUN }) !== 1) throw new Error("expected one segment");

const seg = db
  .query<{ id: string; run_id: string; level: number; raw_len: number; bytes: Uint8Array }, []>(
    "SELECT id, run_id, level, raw_len, bytes FROM segments",
  )
  .get();
if (!seg) throw new Error("no segment");
const placed = events.map((e) => {
  const row = db
    .query<{ seg_offset: number; seg_len: number }, [number]>(
      "SELECT seg_offset, seg_len FROM events WHERE rowid = ?",
    )
    .get(e.rowid);
  const big = e.body.length > 1000;
  return {
    rowid: e.rowid,
    id: e.id,
    offset: row?.seg_offset,
    len: row?.seg_len,
    // The long body is not stored, only what the test needs to recognise it.
    body: big ? null : e.body,
    markerAt: big ? Buffer.from(e.body).indexOf("needlemarker") : null,
  };
});
writeFileSync(
  join(dir, "segment.json"),
  `${JSON.stringify(
    {
      segment: {
        id: seg.id,
        runId: seg.run_id,
        level: seg.level,
        rawLen: seg.raw_len,
        bytes: Buffer.from(seg.bytes).toString("base64"),
      },
      events: placed,
    },
    null,
    1,
  )}\n`,
);

const jwt =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const corpus = [
  "",
  "nothing secret here",
  "PASSWORD=hunter2 TOKEN=abc SECRET=x",
  "password = \"a b c\" and password: 'x y' done",
  'password="unterminated and more',
  "password=[REDACTED:secret] again",
  "--password=hunter2 --api-key abc --access_key 'q r'",
  "--token  \t tok1 --secret=--password",
  '{"api_key":"abc","token":"t","nested":{"secret":"s"}}',
  "x-api-key: abc123; token=abc&other=1",
  "my_token_value=abc not_a_secret=1 mytoken=zzz",
  "Token : abc\nSecret\t=\tdef",
  "Ünïcödé password=héllo wörld",
  "password=\u00a0spaced",
  "password=a\u2028b",
  "emoji 🙂 token=🙂🙂 end",
  "tÖken=abc passwörd=abc",
  "Bearer abcdefgh and BEARER   ABCDEFGH12 and bearer short",
  "Authorization: Basic dXNlcjpwYXNzd29yZA==",
  'authorization="Basic abcdefgh1234"',
  "AUTHORIZATION: basic ABCDEFGH",
  "postgres://user:pa:ss@host:5432/db and http://u:p@x/ and ftp://onlyuser@host",
  "git clone HTTPS://Bob:Pw@github.com/x.git; a1+b.c-d://u:p@h",
  "sk-ant-abcdefgh sk-ant-abc sk-abcdefghijklmnopqrstuvwxyz sk-proj-abcdefghijklmnop12",
  "xsk-ant-abcdefghijkl and _sk-ant-abcdefghijkl",
  "ghp_abcdefghijklmnopqrst ghs_abcdefghijklmnopqrstu gho_short",
  "AKIAIOSFODNN7EXAMPLE, wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  'AKIAIOSFODNN7EXAMPLE\n:= "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYextra"',
  "ASIAIOSFODNN7EXAMPLE0 AKIAIOSFODNN7EXAMPLE",
  "xoxb-1234567890-abcdef xoxz-1234567890",
  "AIzaSyA1234567890abcdefghijklmnopqrstuv AIzaShort",
  "sk_live_abcdefghijklmnop rk_live_abcdefghijklmnop12 pk_live_abcdefghijklmnop",
  "npm_abcdefghijklmnopqrstuvwxyz0123456789 npm_abcdefghijklmnopqrstuvwxyz01234567890",
  `${jwt} and eyJabcde.eyJabcde.abc`,
  "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- tail",
  "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\nmore",
  "-----BEGIN PRIVATE KEY-----",
  "multi\nline\npassword=abc\nnext line token: def",
  "a=b;secret=1,c=d&token=2}x",
  "'password':'hunter2', \"token\": \"abc def\"",
  "https://user:pw@host/path?token=abc&secret=def",
  "curl -H 'Authorization: Bearer abcdefghijkl' -u user:pass",
  "SECRET_ACCESS_KEY=abc AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
  "ACCESS-KEY: abc and api-key=def and apikey=ghi and api_key:jkl",
  "password=a password=b token=c",
];
writeFileSync(
  join(dir, "redact.json"),
  `${JSON.stringify(
    corpus.map((input) => ({ input, expected: redact(input) })),
    null,
    1,
  )}\n`,
);
console.log(`segment ${seg.raw_len} raw bytes, ${corpus.length} redact cases`);
