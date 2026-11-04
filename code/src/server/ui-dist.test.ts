import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticResponse, uiDistResponse } from "./ui-dist";

const dist = mkdtempSync(join(tmpdir(), "ui-dist-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<p>hi</p>");
writeFileSync(join(dist, "assets", "app.js"), "export {};");
afterAll(() => rmSync(dist, { recursive: true, force: true }));

test("/_app serves index.html and other paths serve the matching file", async () => {
  expect(await (await uiDistResponse(dist, "/_app"))?.text()).toBe("<p>hi</p>");
  const js = await uiDistResponse(dist, "/assets/app.js");
  expect(js?.headers.get("content-type")).toContain("javascript");
});

test("missing files, directories and paths outside the directory fall through", async () => {
  expect(await uiDistResponse(dist, "/api/health")).toBeNull();
  expect(await uiDistResponse(dist, "/assets")).toBeNull();
  expect(await uiDistResponse(dist, "/%2e%2e/etc/passwd")).toBeNull();
  expect(await uiDistResponse(dist, "/")).toBeNull();
  expect(await uiDistResponse(dist, "/%E0%A4%A")).toBeNull();
  expect(await uiDistResponse(dist, "/assets%00/app.js")).toBeNull();
});

test("a symlink to a file outside the directory is refused, one to a file inside is served", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ui-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(dist, "leak.txt"));
  symlinkSync(join(dist, "assets", "app.js"), join(dist, "alias.js"));
  try {
    expect(await uiDistResponse(dist, "/leak.txt")).toBeNull();
    expect(await (await uiDistResponse(dist, "/alias.js"))?.text()).toBe("export {};");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("files in the dist win over the built-in PWA files, which fill in what the dist lacks", async () => {
  writeFileSync(join(dist, "sw.js"), "// custom");
  const worker = await staticResponse(dist, "GET", "/sw.js");
  expect(await worker?.text()).toBe("// custom");
  expect(worker?.headers.get("cache-control")).toBe("no-cache");
  expect(worker?.headers.get("service-worker-allowed")).toBe("/");
  expect(worker?.headers.get("content-type")).toContain("javascript");
  expect(await staticResponse(dist, "GET", "/icon.svg")).not.toBeNull();
  expect((await staticResponse(dist, "GET", "/icon.svg"))?.headers.get("cache-control")).toBe(
    "no-cache",
  );
  expect(await staticResponse(undefined, "GET", "/sw.js")).not.toBeNull();
  expect(await staticResponse(dist, "GET", "/api/health")).toBeNull();
});
