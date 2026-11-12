import { expect, test } from "bun:test";

// sw.js is a classic worker script, so the pure helper is cut out of the source and evaluated.
async function loadStaleKeys(): Promise<(cached: string[], assets: string[]) => string[]> {
  const source = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const start = source.indexOf("function staleKeys");
  const end = source.indexOf("\n}\n", start) + 3;
  return new Function(`${source.slice(start, end)}; return staleKeys;`)();
}

test("staleKeys keeps the page and the new assets, drops the rest", async () => {
  const staleKeys = await loadStaleKeys();
  const cached = [
    "/",
    "/assets/index-old.js",
    "/assets/index-new.js",
    "/icon.svg",
    "/assets/x.css",
  ];
  expect(staleKeys(cached, ["/assets/index-new.js", "/icon.svg"])).toEqual([
    "/assets/index-old.js",
    "/assets/x.css",
  ]);
});

async function loadTarget(): Promise<(url: string | undefined) => string> {
  const source = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const start = source.indexOf("function target");
  const end = source.indexOf("\n}\n", start) + 3;
  const location = new URL("https://harness.example/");
  return new Function("location", `${source.slice(start, end)}; return target;`)(location);
}

test("a notification only opens pages of this origin", async () => {
  const target = await loadTarget();
  expect(target("/#/approvals/ap_1")).toBe("https://harness.example/#/approvals/ap_1");
  expect(target(undefined)).toBe("https://harness.example/");
  expect(target("https://evil.example/x")).toBe("https://harness.example/");
});
