const TIMEOUT_MS = 5000;

// Discovery is best effort: an absent binary, a failing exit or bad output all mean "nothing found".
export async function runBin(
  bin: string | undefined,
  name: string,
  args: string[],
): Promise<string | null> {
  const path = Bun.which(name, bin ? { PATH: bin } : {});
  if (!path) return null;
  try {
    const proc = Bun.spawn([path, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: TIMEOUT_MS,
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}
