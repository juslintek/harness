import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { orgChannelOf, seedMember } from "../../test-support/bridge-kit";
import { postMessage, wireChat } from "../chat/api";
import { createEcho } from "./inbound";
import { startOutbound } from "./outbound";
import { linkBridge } from "./repo";

test("stop waits for queued outbound posts", async () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const ada = seedMember(db, "ada");
  wireChat(db);
  const channelId = orgChannelOf(db, ada.memberId);
  linkBridge(db, { orgId: ada.orgId, channelId, kind: "slack", externalId: "C1" });
  let resolveSend!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const pending = new Promise<void>((resolve) => (resolveSend = resolve));
  const stop = startOutbound(db, createEcho(), {
    slack: async () => {
      markStarted();
      await pending;
    },
  });

  postMessage(db, { channelId, authorId: ada.memberId, body: "queued" });
  await started;
  let stopped = false;
  const draining = stop().then(() => (stopped = true));
  await Promise.resolve();
  expect(stopped).toBe(false);
  resolveSend();
  await draining;
  expect(stopped).toBe(true);
});
