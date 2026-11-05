// Phase 5 gate: reach (web push, email, Slack, Telegram, webhooks, remote MCP with OAuth,
// Claude Desktop link). Runs Part A (automated verification) by default, or Part B (--live).
import { ASSERTIONS, runPartA } from "./gate-5-parta";
import { runPartB } from "./gate-5-partb";

function capArg(argv: string[]): number | undefined {
  const at = argv.indexOf("--cap");
  if (at === -1 || at + 1 >= argv.length) return undefined;
  const val = Number(argv[at + 1]);
  return Number.isFinite(val) ? val : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--live")) {
    await runPartB();
    return;
  }

  const real = argv.includes("--real");
  const capUsd = capArg(argv);
  const result = await runPartA({ real, ...(capUsd === undefined ? {} : { capUsd }) });

  console.log(`\nGate 5 summary: ${result.passed}/${ASSERTIONS} assertions passed.`);
  console.log(`Claude spend: ${result.spendUsd.toFixed(4)} USD.`);

  if (result.failures.length > 0 || result.passed < ASSERTIONS) {
    console.error(`\nGate 5 failed with ${result.failures.length} issue(s):`);
    for (const f of result.failures) console.error(` - ${f}`);
    process.exit(1);
  }

  console.log("\ngate 5 passed");
}

await main();
