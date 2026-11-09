// Phase 5 gate: reach (web push, email, Slack, Telegram, webhooks, remote MCP with OAuth,
// Desktop link). Runs Part A (automated verification) by default, or Part B (--live).
import { ASSERTIONS, partAMode, runPartA } from "./gate-5-parta";
import { runPartB } from "./gate-5-partb";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--live")) {
    await runPartB();
    return;
  }

  const mode = partAMode(argv);
  const fake = mode === "fake";
  const real = mode === "real";
  console.log(`Gate 5 Part A mode: ${fake ? "fake offline" : "real Codex"}.`);
  const result = await runPartA({ real });

  console.log(`\nGate 5 summary: ${result.passed}/${ASSERTIONS} assertions passed.`);
  console.log(
    `Codex subscription usage: ${result.codexInputTokens} input / ${result.codexOutputTokens} output tokens; monetary cost unknown.`,
  );
  console.log(`Claude-reported spend: ${result.claudeSpendUsd.toFixed(4)} USD.`);

  if (result.failures.length > 0 || result.passed < ASSERTIONS) {
    console.error(`\nGate 5 failed with ${result.failures.length} issue(s):`);
    for (const f of result.failures) console.error(` - ${f}`);
    process.exit(1);
  }

  console.log("\ngate 5 passed");
}

await main();
