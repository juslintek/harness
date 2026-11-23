import { pathToFileURL } from "node:url";
import { resolvePackagedAdapter } from "./packaged";

const ADAPTER_FILES = {
  claude: "claude-agent-acp.mjs",
  codex: "codex-acp.mjs",
} as const;

type AdapterRuntime = keyof typeof ADAPTER_FILES;

// Runs a bundled ACP adapter inside the compiled binary's embedded Bun runtime so packaged
// installations do not need Node, Bun, or node_modules on the host.
export async function runAcpAdapter(args: string[]): Promise<void> {
  const [runtime, ...rest] = args;
  if (runtime !== "claude" && runtime !== "codex") {
    console.error(`harness acp-adapter: unknown adapter ${JSON.stringify(runtime ?? "")}`);
    process.exit(2);
  }
  const fileName = ADAPTER_FILES[runtime as AdapterRuntime];
  const scriptPath = resolvePackagedAdapter(fileName);
  if (!scriptPath) {
    console.error(`harness acp-adapter: bundled adapter ${fileName} not found`);
    process.exit(1);
  }
  // Point the adapter at the host CLI on PATH when no explicit override was set, avoiding
  // node_modules resolution of bundled platform SDK binaries.
  if (runtime === "claude" && !process.env.CLAUDE_CODE_EXECUTABLE) {
    const cli = Bun.which("claude");
    if (cli) process.env.CLAUDE_CODE_EXECUTABLE = cli;
  }
  if (runtime === "codex" && !process.env.CODEX_PATH) {
    const cli = Bun.which("codex");
    if (cli) process.env.CODEX_PATH = cli;
  }
  process.argv = [process.execPath, scriptPath, ...rest];
  try {
    await import(pathToFileURL(scriptPath).href);
  } catch (err) {
    console.error(`harness acp-adapter: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
