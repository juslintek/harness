import { ROOT } from "./gate-6-kit";

export type CmdOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowFail?: boolean;
};

export function runCmd(
  cmd: string[],
  opts: CmdOpts = {},
): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0 && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode}): ${stderr || stdout}`);
  }
  return { ok: proc.exitCode === 0, stdout, stderr };
}

export async function runCmdAsync(
  cmd: string[],
  opts: CmdOpts = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} failed (${code}): ${stderr || stdout}`);
  }
  return { ok: code === 0, stdout, stderr };
}

export function androidEnv(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const javaHome = "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
  const androidHome = process.env.ANDROID_HOME ?? `${home}/Library/Android/sdk`;
  const extra = [
    `${javaHome}/bin`,
    `${androidHome}/platform-tools`,
    `${androidHome}/emulator`,
    `${androidHome}/cmdline-tools/latest/bin`,
    "/opt/homebrew/bin",
  ].join(":");
  return {
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    PATH: `${extra}:${process.env.PATH ?? ""}`,
  };
}
