import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { resetLayaCircuit } from "../laya/api";
import { listRunEvents } from "../logs/api";
import {
  type ActionRequest,
  type Category,
  checkAction,
  decideApproval,
  type GuardOutcome,
  listApprovals,
  runTmpDir,
  type SandboxInput,
  scrubEnv,
  wrapCommand,
  writeSrtSettings,
} from "./api";

let dir: string;
let db: Database;
const run = {
  id: "run-1",
  prompt: "Add retry logic to the webhook sender",
  scope: { root: "/work/tree", home: "/home/u", defaultBranch: "main" },
};
const exec = (command: string): ActionRequest => ({ kind: "execute", command, paths: [] });

function layaAnswers(exfiltration: number, destructive = 0.1): Response {
  const noul = (n: number): { type: string; noul: number } => ({ type: "noul", noul: n });
  return Response.json({
    model: "laya:en",
    state_truncated: false,
    answers: {
      destructive: noul(destructive),
      exfiltration: noul(exfiltration),
      out_of_scope: noul(0.1),
      risk: { type: "score", probabilities: { "0": 0.9, "1": 0.1 } },
    },
  });
}

async function stubLaya(exfiltration: number, destructive = 0.1): Promise<void> {
  process.env.OLLAYA_URL = (await startStub(() => layaAnswers(exfiltration, destructive))).url;
}

const layers = (): string[] =>
  listRunEvents(db, run.id)
    .filter((e) => e.kind === "guard")
    .map((e) => `${e.guardLayer}:${e.guardVerdict}`);

// Starts a check that must stop at L3 and returns the pending approval id.
async function startPending(
  command: string,
): Promise<{ id: string; outcome: Promise<GuardOutcome> }> {
  const seen: string[] = [];
  const outcome = checkAction(db, run, exec(command), {
    onApprovalPending: (id) => seen.push(id),
  });
  for (let i = 0; i < 200 && seen.length === 0; i++) await Bun.sleep(10);
  expect(seen).toHaveLength(1);
  return { id: seen[0] ?? "", outcome };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-guard-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  resetLayaCircuit();
});

afterEach(async () => {
  await stopStubs();
  delete process.env.OLLAYA_URL;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("checkAction", () => {
  test("L1 deny stops at L1", async () => {
    const out = await checkAction(db, run, exec("rm -rf ~"));
    expect(out).toMatchObject({ verdict: "deny", layer: "L1", approvalId: null });
    expect(out.rule).not.toBeNull();
    expect(layers()).toEqual(["L1:deny"]);
  });

  test("L1 allow and Laya allow", async () => {
    await stubLaya(0.1);
    const out = await checkAction(db, run, exec("bun test src/webhook.test.ts"));
    expect(out).toMatchObject({ verdict: "allow", layer: "L2" });
    expect(layers()).toEqual(["L1:allow", "L2:allow"]);
  });

  test("Laya down on a read-only command stays an L1 allow", async () => {
    process.env.OLLAYA_URL = "http://127.0.0.1:1";
    const out = await checkAction(db, run, exec("ls -la src"));
    expect(out).toMatchObject({ verdict: "allow", layer: "L1" });
  });

  test("an edit inside the root is not sent to Laya", async () => {
    await stubLaya(0.95);
    const out = await checkAction(db, run, { kind: "edit", paths: ["/work/tree/math.ts"] });
    expect(out).toMatchObject({ verdict: "allow", layer: "L1" });
    expect(layers()).toEqual(["L1:allow"]);
  });

  test("Laya's exfiltration score does not deny a read-only command", async () => {
    await stubLaya(0.95);
    const out = await checkAction(db, run, exec("cat docs/guide.md docs/notes.md"));
    expect(out).toMatchObject({ verdict: "allow" });
  });

  test("L2 deny on likely exfiltration", async () => {
    await stubLaya(0.95);
    const out = await checkAction(db, run, exec("dig +short internal.example.com"));
    expect(out).toMatchObject({ verdict: "deny", layer: "L2" });
    expect(layers()).toEqual(["L1:allow", "L2:deny"]);
  });
});

describe("checkAction with L3", () => {
  test("L1 ask waits for approval, approve allows at L3", async () => {
    const { id, outcome } = await startPending("git push origin feature/x");
    expect(listApprovals(db, "pending").map((a) => a.id)).toEqual([id]);
    expect(decideApproval(db, id, "approve", "alice")).toBe(true);
    expect(await outcome).toMatchObject({ verdict: "allow", layer: "L3", approvalId: id });
    expect(layers()).toEqual(["L1:ask", "L3:allow"]);
    expect(listApprovals(db, "approved")[0]?.decidedBy).toBe("alice");
  });

  test("deny at L3", async () => {
    const { id, outcome } = await startPending("git push origin feature/x");
    decideApproval(db, id, "deny", "alice");
    expect(await outcome).toMatchObject({ verdict: "deny", layer: "L3" });
    expect(layers()).toEqual(["L1:ask", "L3:deny"]);
  });

  test("approval timeout denies and expires the row", async () => {
    const seen: string[] = [];
    const out = await checkAction(db, run, exec("git push origin feature/x"), {
      approvalTimeoutMs: 100,
      onApprovalPending: (id) => seen.push(id),
    });
    expect(out).toMatchObject({ verdict: "deny", layer: "L3", reason: "approval_timeout" });
    expect(listApprovals(db, "expired").map((a) => a.id)).toEqual(seen);
    expect(decideApproval(db, seen[0] ?? "", "approve", "late")).toBe(false);
  });

  test("L2 ask escalates to L3", async () => {
    await stubLaya(0.1, 0.97);
    const { id, outcome } = await startPending("bun test src/webhook.test.ts");
    decideApproval(db, id, "approve", "alice");
    expect(await outcome).toMatchObject({ verdict: "allow", layer: "L3" });
    expect(layers()).toEqual(["L1:allow", "L2:ask", "L3:allow"]);
  });
});

describe("sandbox wrappers", () => {
  test("settings file, wrapped argv, scrubbed env and tmp dir", async () => {
    const input: SandboxInput = {
      runDir: join(dir, "run"),
      worktree: join(dir, "wt"),
      gitCommonDir: null,
      harnessHome: join(dir, "home"),
      agentStateWrite: [],
      agentEgress: ["api.anthropic.com"],
      preset: "dev",
      weakerNetworkIsolation: false,
      codexHome: null,
    };
    const settings = await writeSrtSettings(input);
    expect(await Bun.file(settings).exists()).toBe(true);
    expect(wrapCommand(settings, ["echo", "hi"]).slice(1)).toEqual([
      "-s",
      settings,
      "--",
      "echo",
      "hi",
    ]);
    expect(runTmpDir(input.runDir)).toBe(join(input.runDir, "tmp"));
    const env = scrubEnv({ HOME: "/h", SECRET_TOKEN: "x" }, { HARNESS_RUN_ID: "r" });
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.HARNESS_RUN_ID).toBe("r");
    const category: Category = "shell";
    expect(category).toBe("shell");
  });
});

test("the stored approval action is redacted field by field", async () => {
  const command = `git push origin feature/x --password "a b" -H 'Authorization: Bearer abcdefgh123'`;
  const { id, outcome } = await startPending(command);
  const stored = listApprovals(db).find((a) => a.id === id);
  const action = JSON.parse(stored?.action ?? "{}") as ActionRequest;
  expect(action.command).not.toContain("a b");
  expect(action.command).not.toContain("abcdefgh123");
  expect(action.command).toContain("git push origin feature/x");
  decideApproval(db, id, "deny", "admin");
  await outcome;
});
