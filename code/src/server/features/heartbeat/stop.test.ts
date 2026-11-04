import { expect, test } from "bun:test";
import { wakeNow } from "./api";
import { setup } from "./kit";

test("a launch queued before stop does not start, and stop resolves once the chain is idle", async () => {
  const k = setup();
  const bot = k.agent("bot");
  const stop = k.start();
  wakeNow(k.db, bot.id, "test");
  await stop();
  await Bun.sleep(100);
  expect(k.seen).toHaveLength(0);
});
