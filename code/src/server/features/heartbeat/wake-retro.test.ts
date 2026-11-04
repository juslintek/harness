import { expect, test } from "bun:test";
import { setup } from "./kit";
import { buildPrompt } from "./prompt";
import { insertWake, pendingWakes } from "./repo";

test("a wake with reason retro can be stored and described", () => {
  const k = setup();
  const dev = k.agent("dev");
  insertWake(k.db, {
    memberId: dev.id,
    reason: "retro",
    detail: { excerpt: "task #1 shipped" },
    causedBy: null,
  });
  const wakes = pendingWakes(k.db, dev.id);
  expect(wakes.map((w) => w.reason)).toEqual(["retro"]);
  expect(buildPrompt(k.db, dev, wakes)).toContain("task #1 shipped");
});
