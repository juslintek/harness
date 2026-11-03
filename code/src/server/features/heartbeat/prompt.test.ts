import { expect, test } from "bun:test";
import { createPosition } from "../orgs/api";
import { setup } from "./kit";
import { buildPrompt } from "./prompt";

test("a member with reports is told to delegate and not to code; the report is not", () => {
  const k = setup();
  const lead = k.agent("lead");
  const dev = k.agent("dev");
  const leadPos = createPosition(k.db, {
    orgId: k.orgId,
    title: "Tech lead",
    memberId: lead.id,
    isManager: true,
  });
  createPosition(k.db, {
    orgId: k.orgId,
    title: "Developer",
    memberId: dev.id,
    reportsTo: leadPos.id,
  });
  const managerPrompt = buildPrompt(k.db, lead, []);
  expect(managerPrompt).toContain("You manage @dev.");
  expect(managerPrompt).toContain("worktree is read-only");
  expect(managerPrompt).toContain("`task_delegate`");
  expect(managerPrompt).toContain("move the parent task to `done`");
  const devPrompt = buildPrompt(k.db, dev, []);
  expect(devPrompt).not.toContain("You manage");
  expect(devPrompt).toContain("`task_checkout`");
  expect(devPrompt).toContain("project channel with `chat_post`");
  expect(devPrompt).toContain("`$TMPDIR`");
  expect(devPrompt).toContain("do not post just to acknowledge");
  expect(devPrompt).toContain("release it with `task_release`");
});
