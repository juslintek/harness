import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { resolveSeccompApplyPath } from "../../packaged";

interface ParsedArgs {
  settingsPath: string | null;
  commandString: string | null;
  argv: string[];
}

function parseSrtArgs(args: string[]): ParsedArgs | { error: string } {
  let settingsPath: string | null = null;
  let commandString: string | null = null;
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") return { settingsPath, commandString, argv: args.slice(i + 1) };
    if (arg !== "-s" && arg !== "--settings" && arg !== "-c") break;
    const value = args[i + 1];
    if (!value) return { error: `${arg} requires a value` };
    if (arg === "-c") commandString = value;
    else settingsPath = value;
    i += 2;
  }
  return { settingsPath, commandString, argv: args.slice(i) };
}

const shellQuote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`;

function loadSettings(path: string): ReturnType<typeof SandboxRuntimeConfigSchema.safeParse> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to read srt settings ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return SandboxRuntimeConfigSchema.safeParse(raw);
}

function spawnSandboxed(wrapped: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(wrapped, { shell: true, stdio: "inherit" });
    const onSigInt = (): void => {
      child.kill("SIGINT");
    };
    const onSigTerm = (): void => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    const finish = (code: number): void => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      SandboxManager.cleanupAfterCommand();
      void SandboxManager.reset().finally(() => resolve(code));
    };
    child.on("error", (err) => {
      console.error(`harness srt: failed to spawn command: ${err.message}`);
      finish(1);
    });
    child.on("exit", (code, signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM") finish(0);
      else if (signal) {
        console.error(`harness srt: process killed by signal: ${signal}`);
        finish(1);
      } else finish(code ?? 0);
    });
  });
}

function withBundledSeccomp(
  config: Parameters<typeof SandboxManager.initialize>[0],
): Parameters<typeof SandboxManager.initialize>[0] {
  if (config.seccomp?.applyPath) return config;
  const applyPath = resolveSeccompApplyPath();
  return applyPath ? { ...config, seccomp: { ...config.seccomp, applyPath } } : config;
}

// Built-in srt launcher for compiled binaries, replacing node_modules/.bin/srt outside a source
// checkout. Fails closed if settings are missing or invalid rather than falling back to defaults.
export async function runSrtCli(args: string[]): Promise<number> {
  const parsed = parseSrtArgs(args);
  if ("error" in parsed) {
    console.error(`harness srt: ${parsed.error}`);
    return 1;
  }
  if (!parsed.settingsPath) {
    console.error("harness srt: -s <settings> is required");
    return 1;
  }
  const command =
    parsed.commandString ?? (parsed.argv.length > 0 ? parsed.argv.map(shellQuote).join(" ") : null);
  if (!command) {
    console.error("harness srt: no command specified");
    return 1;
  }
  try {
    const checked = loadSettings(parsed.settingsPath);
    if (!checked.success) {
      console.error(`harness srt: invalid settings: ${checked.error.message}`);
      return 1;
    }
    await SandboxManager.initialize(withBundledSeccomp(checked.data));
    return await spawnSandboxed(await SandboxManager.wrapWithSandbox(command));
  } catch (err) {
    console.error(`harness srt: ${err instanceof Error ? err.message : String(err)}`);
    await SandboxManager.reset().catch(() => {});
    return 1;
  }
}
