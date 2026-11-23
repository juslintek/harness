// Gate G1 (P1.17): end-to-end verification of local multi-account management, routing,
// watchdog scoping, account-first failover, pool-exhausted parking, removal, and canary hygiene.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startHeartbeat } from "../src/server/features/heartbeat/api";
import { addTarget, setPref, startNotify } from "../src/server/features/notify/api";
import { startWatchdog } from "../src/server/features/router/api";
import type { Notification } from "../src/shared/notify";
import { bootInstance, createReport, enrollAdmin, type Report, stepUp } from "./gate-5-kit";
import {
  verifyCanary,
  verifyFailoverAndWatchdog,
  verifyParkAndRemove,
  verifyRoutingAndUsage,
} from "./gate-accounts-checks";
import {
  type CallFn,
  codexRouteDeps,
  dumpDiagnostics,
  FAKE_BIN,
  initRepo,
  makeRunDeps,
  runLiveGate,
  seedWorld,
  setupAccounts,
} from "./gate-accounts-kit";

async function bootGateContext(root: string) {
  const home = join(root, "home");
  const defaultCodex = join(root, "default-codex");
  mkdirSync(defaultCodex, { recursive: true });
  writeFileSync(join(defaultCodex, "auth.json"), "plus");
  const inst = await bootInstance({ home });
  const admin = await enrollAdmin(inst);
  await stepUp(inst, admin.cookie);
  const world = seedWorld(inst.db, admin.userId, initRepo(join(root, "repo")));
  const notices: Notification[] = [];
  addTarget(inst.db, world.humanId, "email", { address: "admin@example.com" });
  setPref(inst.db, world.humanId, "email", "pool_exhausted", true);
  const stopExtraNotify = startNotify(inst.db, {
    home,
    origin: inst.origin,
    adapters: {
      email: {
        channel: "email",
        deliver: async (_t, n) => {
          notices.push(n);
          return { ok: true };
        },
      },
    },
  });
  const state = { holdNext: false };
  const runDeps = makeRunDeps(home, inst.port, state);
  const stopWatchdog = startWatchdog(inst.db);
  const stopHeartbeat = startHeartbeat(inst.db, {
    home,
    runDeps,
    tickMs: 25,
    routeDeps: codexRouteDeps,
  });
  const call: CallFn = (method, path, body) =>
    inst.client.call(method, path, {
      cookie: admin.cookie,
      ...(body === undefined ? {} : { body }),
    });
  return {
    home,
    defaultCodex,
    inst,
    world,
    notices,
    state,
    runDeps,
    call,
    stop: async () => {
      await stopHeartbeat();
      stopWatchdog();
      await stopExtraNotify();
      await inst.stop();
      inst.db.close();
    },
  };
}

async function runFakeGate(report: Report, print: (line: string) => void): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "harness-g1-"));
  const prevPath = process.env.PATH ?? "";
  process.env.PATH = `${FAKE_BIN}:${prevPath}`;
  process.env.FAKE_DEFAULT_HOME = join(root, "default-codex");
  const ctx = await bootGateContext(root);
  try {
    const { acctA, acctB } = await setupAccounts(ctx.call, ctx.home, report);
    await verifyRoutingAndUsage(ctx.inst.db, ctx.world, ctx.call, acctA, acctB, report);
    await verifyFailoverAndWatchdog(
      ctx.inst.db,
      ctx.world,
      ctx.call,
      ctx.runDeps,
      ctx.state,
      acctA,
      acctB,
      report,
    );
    await verifyParkAndRemove(
      ctx.inst,
      ctx.world,
      ctx.call,
      acctA,
      acctB,
      ctx.defaultCodex,
      ctx.notices,
      report,
    );
    await verifyCanary(ctx.inst, ctx.call, acctA.id, report);
    print(`G1 fake gate summary: ${report.passed()}/11 passed, ${report.failures().length} failed`);
    return report.failures().length === 0 ? 0 : 1;
  } catch (err) {
    console.error("Gate diagnostics:\n", dumpDiagnostics(ctx.inst.db));
    throw err;
  } finally {
    await ctx.stop();
    process.env.PATH = prevPath;
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const lines: string[] = [];
  const print = (line: string): void => {
    lines.push(line);
    console.log(line);
  };
  const report = createReport(print);
  const logIdx = process.argv.indexOf("--log");
  const logPath = logIdx >= 0 ? process.argv[logIdx + 1] : undefined;
  const code = process.argv.includes("--live")
    ? await runLiveGate(report)
    : await runFakeGate(report, print);
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${lines.join("\n")}\n`);
  }
  process.exit(code);
}
