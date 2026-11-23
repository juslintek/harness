// Claude PreToolUse hook, run by the agent inside its srt sandbox as its own process. It stays on
// L1 alone (no DB, no Laya) so it starts fast; the ACP permission flow covers L2 and L3.
import { resolve } from "node:path";
import { z } from "zod";
import { type ActionRequest, evaluateL1 } from "./l1";

// Claude Code treats every exit code except 2 as a non-blocking hook error, so any input this
// schema does not accept must end in exit 2 instead of being waved through as an unknown tool.
const HookInput = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  cwd: z.string().optional(),
});
type HookInput = z.infer<typeof HookInput>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function absolute(path: string, cwd: string): string {
  return path.startsWith("~") ? path : resolve(cwd, path);
}

function toAction(input: HookInput): ActionRequest {
  const tool = input.tool_name;
  const args = input.tool_input;
  const cwd = str(input.cwd) ?? process.cwd();
  const paths = (...keys: string[]): string[] => {
    const found = keys.map((k) => str(args[k])).filter((p): p is string => p !== undefined);
    return (found.length > 0 ? found : [cwd]).map((p) => absolute(p, cwd));
  };
  if (tool === "Bash") {
    const command = str(args.command);
    return command === undefined
      ? { kind: "execute", paths: [] }
      : { kind: "execute", command, paths: [] };
  }
  if (["Read", "Glob", "Grep"].includes(tool)) {
    return { kind: "read", paths: paths("file_path", "path") };
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    return { kind: "edit", paths: paths("file_path", "notebook_path") };
  }
  if (tool === "WebFetch" || tool === "WebSearch") return { kind: "fetch", paths: [] };
  return { kind: "other", paths: [], toolName: tool };
}

async function report(verdict: string, rule: string | null, command: string): Promise<void> {
  const url = process.env.HARNESS_HOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.HARNESS_RUN_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ runId: process.env.HARNESS_RUN_ID, verdict, rule, command }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Telemetry only; the decision never depends on it.
  }
}

async function evaluateStdin(): Promise<number> {
  const root = process.env.HARNESS_SCOPE_ROOT;
  const home = process.env.HOME;
  if (!root || !home) {
    console.error("harness guard: HARNESS_SCOPE_ROOT or HOME is not set");
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error("harness guard: hook input is not valid JSON");
    return 2;
  }
  const checked = HookInput.safeParse(parsed);
  if (!checked.success) {
    console.error("harness guard: hook input needs tool_name and tool_input");
    return 2;
  }
  const action = toAction(checked.data);
  const result = evaluateL1(action, {
    root,
    home,
    defaultBranch: process.env.HARNESS_DEFAULT_BRANCH ?? "main",
  });
  await report(result.verdict, result.rule, action.command ?? action.paths.join(" "));
  if (result.verdict === "deny") {
    console.error(`harness guard: ${result.reason}`);
    return 2;
  }
  if (result.verdict === "ask") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
      }),
    );
  }
  return 0;
}

function failClosed(error: unknown): never {
  console.error(`harness guard: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

export async function runGuardHook(): Promise<number> {
  process.on("uncaughtException", failClosed);
  process.on("unhandledRejection", failClosed);
  return evaluateStdin().catch(failClosed);
}
