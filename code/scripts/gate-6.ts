// Phase 6 gate: distribution, federation and self-update, all local (no real host, no tunnel,
// no real passkey dialog). Assertion numbers match working-docs/plans/phase-6.md Task 15.
import { buildHost, runDeployPart } from "./gate-6-deploy";
import { runFederationPart } from "./gate-6-fed";
import { openLog } from "./gate-6-kit";
import { runUpdatePart } from "./gate-6-update";

const ASSERTIONS = 9;

async function main(): Promise<void> {
  const log = openLog();
  try {
    const built = await buildHost(log);
    await runDeployPart(log, built);
    await runFederationPart(log);
    await runUpdatePart(log, built);
  } catch (err) {
    log.print(`gate stopped early: ${(err as Error).stack ?? err}`);
  }
  const passed = log.report.passed();
  const failures = log.report.failures();
  log.print(`gate 6: ${passed}/${ASSERTIONS} assertions passed`);
  for (const f of failures) log.print(` - FAIL ${f}`);
  log.print(`log: ${log.path}`);
  process.exit(passed === ASSERTIONS && failures.length === 0 ? 0 : 1);
}

await main();
