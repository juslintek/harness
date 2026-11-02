import { expect, test } from "bun:test";
import { gone } from "./acp-kit";
import { ownsGroup } from "./orphans";

// The leader exits at once and leaves a sleeping member behind, as when srt dies first.
async function orphanGroup(): Promise<{ leader: number; member: number }> {
  const proc = Bun.spawn(["sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"], {
    detached: true,
    stdout: "pipe",
    stdin: "ignore",
  });
  const member = Number((await new Response(proc.stdout).text()).trim());
  await proc.exited;
  return { leader: proc.pid, member };
}

test("a group whose srt leader died is still ours until its members are gone", async () => {
  const { leader, member } = await orphanGroup();
  try {
    expect(gone(leader)).toBe(true);
    expect(ownsGroup(leader)).toBe(true);
  } finally {
    process.kill(-leader, "SIGKILL");
  }
  await Bun.sleep(100);
  expect(gone(member)).toBe(true);
  expect(ownsGroup(leader)).toBe(false);
});
