import { expect, test } from "bun:test";
import { noteSummarySchema } from "../../../shared/memory";
import { BASE, boot, useHome } from "./routes-test-kit";

useHome();

test("list, backlinks and link responses carry exactly the public summary keys", async () => {
  const k = await boot();
  const put = async (rel: string, body: string) =>
    (await (await k.call(k.alice, "POST", `${BASE}/notes`, { scope: "org", rel, body })).json())
      .note.id as string;
  const target = await put("ref.md", "# Ref");
  const source = await put("guide.md", "# Guide\n[[ref]]");
  const json = async (path: string) => (await k.call(k.alice, "GET", path)).json();
  const lists = [
    ...(await json(`${BASE}/notes?q=ref`)),
    ...(await json(`${BASE}/notes`)),
    ...(await json(`${BASE}/notes/${target}/backlinks`)),
    await json(`${BASE}/notes/${source}/link?target=ref`),
  ];
  expect(lists.length).toBeGreaterThan(3);
  // zod strips unknown keys, so equality with the parsed value means no internal field leaked.
  for (const n of lists) expect(n).toEqual(noteSummarySchema.parse(n));
});

test("a wikilink resolves on the server: same directory first, never another org's note", async () => {
  const k = await boot();
  const put = async (who: typeof k.alice, org: string, rel: string, body: string) =>
    (
      await (
        await k.call(who, "POST", `/api/orgs/${org}/memory/notes`, { scope: "org", rel, body })
      ).json()
    ).note.id as string;
  const far = await put(k.alice, "acme", "ref.md", "# Far ref");
  const near = await put(k.alice, "acme", "zz/ref.md", "# Near ref");
  const source = await put(k.alice, "acme", "zz/guide.md", "# Guide\n[[ref]] [[betaonly]]");
  await put(k.bob, "beta", "betaonly.md", "# Beta only");
  const link = (target: string) =>
    k.call(k.alice, "GET", `${BASE}/notes/${source}/link?target=${target}`);
  const hit = await link("ref");
  expect(hit.status).toBe(200);
  expect((await hit.json()).id).toBe(near);
  expect(near).not.toBe(far);
  expect((await link("betaonly")).status).toBe(404);
  expect((await link("nothing")).status).toBe(404);
  expect(
    (await k.call(k.bob, "GET", `/api/orgs/beta/memory/notes/${source}/link?target=ref`)).status,
  ).toBe(404);
});
