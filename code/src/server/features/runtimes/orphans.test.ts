import { expect, test } from "bun:test";
import { gone } from "./acp-kit";
import { bootTime, ownsGroup, type ProcInfo, pidIdentity } from "./orphans";

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
  const identity = `${bootTime()}|leader start is not compared once the leader is dead`;
  try {
    expect(gone(leader)).toBe(true);
    expect(ownsGroup(leader, identity)).toBe(true);
  } finally {
    process.kill(-leader, "SIGKILL");
  }
  await Bun.sleep(100);
  expect(gone(member)).toBe(true);
  expect(ownsGroup(leader, identity)).toBe(false);
});

function info(over: Partial<ProcInfo>): ProcInfo {
  return {
    boot: () => "boot-1",
    command: () => "srt --settings x",
    start: () => "Mon Nov  2 10:00:00 2026",
    groupHasMembers: () => true,
    ...over,
  };
}

const identity = "boot-1|Mon Nov  2 10:00:00 2026";

test("a recorded pid is only ours when boot and leader start time still match", () => {
  expect(pidIdentity(7, info({}))).toBe(identity);
  expect(ownsGroup(7, identity, info({}))).toBe(true);
  expect(ownsGroup(7, identity, info({ boot: () => "boot-2" }))).toBe(false);
  expect(ownsGroup(7, identity, info({ start: () => "Mon Nov  2 11:00:00 2026" }))).toBe(false);
  expect(ownsGroup(7, identity, info({ command: () => "zsh" }))).toBe(false);
  expect(ownsGroup(7, null, info({}))).toBe(false);
});

test("after a reboot a group under the recorded pid is not claimed", () => {
  const dead = info({ boot: () => "boot-2", command: () => null });
  expect(ownsGroup(7, identity, dead)).toBe(false);
  expect(ownsGroup(7, identity, { ...dead, boot: () => "boot-1" })).toBe(true);
});
