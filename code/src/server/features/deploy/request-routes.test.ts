import { expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimRun, finish, getRequest } from "./requests";
import { addBinary, type Kit, linkOut, makeKit, post } from "./test-kit";

setDefaultTimeout(30_000);

interface View {
  id: string;
  status: string;
  decidedBy: string | null;
  result: { error?: string } | null;
  steps: { unit: { linux: { text: string } }; commands: { linux: string[][] }; pairing: string };
}

async function create(kit: Kit, binary = "harness-fake"): Promise<View> {
  const res = await kit
    .api()
    .request("/requests", post({ targetId: "ssh:box", binary, port: 4999 }));
  expect(res.status).toBe(201);
  return (await res.json()) as View;
}

const decide = (kit: Kit, id: string, decision: string, stepUpAt: number | null = Date.now()) =>
  kit.api({ stepUpAt }).request(`/requests/${id}/decide`, post({ decision }));

async function approved(kit: Kit): Promise<string> {
  const { id } = await create(kit);
  expect((await decide(kit, id, "approve")).status).toBe(200);
  return id;
}

async function settled(kit: Kit, id: string): Promise<View> {
  for (let i = 0; i < 100; i++) {
    const view = (await (await kit.api().request(`/requests/${id}`)).json()) as View;
    if (view.status === "done" || view.status === "failed") return view;
    await Bun.sleep(100);
  }
  throw new Error("deploy did not settle");
}

test("a new request is pending and shows the exact steps before anyone approves", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const view = await create(kit);
  expect(view.status).toBe("pending");
  expect(view.steps.unit.linux.text).toContain("Environment=HARNESS_PORT=4999");
  expect(view.steps.commands.linux).toContainEqual([
    "systemctl",
    "--user",
    "enable",
    "--now",
    "harness.service",
  ]);
  expect(view.steps.pairing).toContain("no key, login or database is copied");
  expect(kit.transportsMade()).toBe(0);
});

test("a non-admin gets 403 on every route", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const { id } = await create(kit);
  const api = kit.api({ instanceAdmin: false });
  const calls: [string, RequestInit | undefined][] = [
    ["/requests", undefined],
    [`/requests/${id}`, undefined],
    ["/requests", post({ targetId: "ssh:box", binary: "harness-fake" })],
    [`/requests/${id}/decide`, post({ decision: "approve" })],
    [`/requests/${id}/run`, post({})],
  ];
  for (const [path, init] of calls) expect((await api.request(path, init)).status).toBe(403);
  expect(getRequest(kit.db, id)?.status).toBe("pending");
});

test("deciding without a fresh step-up is 403 and changes nothing", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const { id } = await create(kit);
  expect((await decide(kit, id, "approve", null)).status).toBe(403);
  expect(getRequest(kit.db, id)?.status).toBe("pending");
});

test("the decider is the session user and a second decision is refused", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const { id } = await create(kit);
  const view = (await (await decide(kit, id, "deny")).json()) as View;
  expect(view).toMatchObject({ status: "denied", decidedBy: "u1" });
  expect((await decide(kit, id, "approve")).status).toBe(409);
  expect(getRequest(kit.db, id)?.status).toBe("denied");
});

test("run refuses pending, denied, running and done requests and starts no transport", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const run = (id: string) => kit.api().request(`/requests/${id}/run`, post({}));
  const pending = (await create(kit)).id;
  const denied = (await create(kit)).id;
  await decide(kit, denied, "deny");
  const running = await approved(kit);
  expect(claimRun(kit.db, running)).toBe("ok");
  const done = await approved(kit);
  claimRun(kit.db, done);
  finish(kit.db, done, "done", {});
  for (const id of [pending, denied, running, done]) expect((await run(id)).status).toBe(409);
  expect((await run("nope")).status).toBe(404);
  expect(kit.transportsMade()).toBe(0);
});

test("two concurrent run calls execute the deploy once", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const id = await approved(kit);
  const run = () => kit.api().request(`/requests/${id}/run`, post({}));
  const statuses = (await Promise.all([run(), run()])).map((res) => res.status).sort();
  expect(statuses).toEqual([202, 409]);
  const view = await settled(kit, id);
  kit.transport.stop();
  expect(kit.transportsMade()).toBe(1);
  expect(view.status).toBe("failed");
  expect(view.result?.error).toContain("did not answer /api/health");
  expect((await run()).status).toBe(409);
});

test("a binary that changed after approval is not copied", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  const id = await approved(kit);
  writeFileSync(join(kit.dist, "harness-fake"), "#!/bin/sh\necho swapped\n");
  await kit.api().request(`/requests/${id}/run`, post({}));
  const view = await settled(kit, id);
  expect(view.result?.error).toContain("changed after it was approved");
  expect(kit.puts).toEqual([]);
});

test("a binary outside the dist dirs is refused, by name, traversal and symlink", async () => {
  const kit = makeKit();
  addBinary(kit.dist, "harness-fake");
  writeFileSync(join(kit.home, "outside"), "x");
  linkOut(kit.dist, "link", "/etc/passwd");
  linkOut(kit.dist, "link2", join(kit.home, "outside"));
  for (const binary of [
    "../../etc/passwd",
    "../outside",
    "/etc/passwd",
    "link",
    "link2",
    "missing",
    ".",
  ]) {
    const res = await kit.api().request("/requests", post({ targetId: "ssh:box", binary }));
    expect(res.status).toBe(400);
  }
  expect(
    (await kit.api().request("/requests", post({ targetId: "ssh:nope", binary: "harness-fake" })))
      .status,
  ).toBe(404);
});

test("a remote target gets no pairing code and the health probe runs through the transport", async () => {
  const kit = makeKit("http://127.0.0.1:1", 600, "10.0.0.5");
  addBinary(kit.dist, "harness-fake");
  const view = await create(kit);
  expect(view.steps.pairing).toContain("not done for a remote target");
  await decide(kit, view.id, "approve");
  await kit.api().request(`/requests/${view.id}/run`, post({}));
  expect((await settled(kit, view.id)).result?.error).toContain("did not answer /api/health");
  kit.transport.stop();
  expect(kit.puts.some((put) => put.path.endsWith("/bin/harness"))).toBe(true);
  expect(kit.puts.some((put) => put.path.endsWith("pair-invite"))).toBe(false);
});
