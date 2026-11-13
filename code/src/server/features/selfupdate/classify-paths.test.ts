import { expect, test } from "bun:test";
import { type Change, classify } from "./classify";

const flagged = async (change: Change): Promise<string[]> => (await classify([change])).flagged;
const cp = (code: number): string => String.fromCodePoint(code);
const dir = "code/src/server/features";

// each path is a variant that a case-insensitive or trimming checkout maps onto a guarded file
const DISGUISED: [string, string][] = [
  ["long s", `code/${cp(0x17f)}rc/server/features/auth/api`],
  ["long s gitignore", `code/${cp(0x17f)}rc/server/features/auth/.gitignore`],
  ["ligature", `${dir}/notes/${cp(0xfb06)}ore.ts`],
  ["nfd accent", `${dir}/notes/re${cp(0x301)}adme.md`],
  ["control char", `${dir}/notes/a${cp(7)}b.md`],
  ["delete char", `${dir}/notes/a${cp(0x7f)}b.md`],
  ["trailing dot", `${dir}/notes./readme.md`],
  ["trailing space", `${dir}/notes /readme.md`],
];

const variants = (path: string): [string, Change][] => [
  ["modify", { status: "M", path }],
  ["delete", { status: "D", path }],
  ["rename to", { status: "R100", path, oldPath: "code/src/lib/x.ts" }],
  ["rename from", { status: "R100", path: "code/src/lib/x.ts", oldPath: path }],
];

const NESTED = [
  `${dir}/node_modules/@simplewebauthn/server/index.js`,
  `${dir}/notes/package.json`,
  `${dir}/notes/tsconfig.json`,
  `${dir}/notes/tsconfig.base.json`,
  `${dir}/notes/jsconfig.json`,
  `${dir}/notes/bunfig.toml`,
  "code/src/web/Node_Modules/x/y.js",
];

for (const [name, path] of DISGUISED)
  test.each(variants(path))(`flags ${name} path on %s`, async (_kind, change) => {
    expect((await flagged(change)).length).toBeGreaterThan(0);
  });

for (const path of NESTED)
  test.each(variants(path))(`flags nested resolution ${path} on %s`, async (_kind, change) => {
    expect((await flagged(change)).length).toBeGreaterThan(0);
  });

test("ordinary ascii paths are not flagged", async () => {
  for (const path of [
    `${dir}/notes/readme.md`,
    `${dir}/notes/config.json`,
    "code/src/web/components/node-modules-help.ts",
    "docs/a.b/readme.md",
    "code/src/web/nested/package-notes.md",
  ]) {
    expect(await flagged({ status: "M", path })).toEqual([]);
  }
  expect(
    await flagged({ status: "R100", path: `${dir}/notes/b.md`, oldPath: `${dir}/notes/a.md` }),
  ).toEqual([]);
});
