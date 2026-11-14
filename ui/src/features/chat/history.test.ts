import { expect, test } from "bun:test";
import type { MessageView } from "@shared/chat";
import { merge } from "./history";

const msg = (id: string, createdAt: number, body = id): MessageView => ({
  id,
  channelId: "c",
  threadRootId: null,
  authorId: null,
  author: null,
  body,
  createdAt,
  editedAt: null,
  replyCount: 0,
  mentions: [],
  taskIds: [],
  tasks: [],
});

test("merge keeps older pages, orders by time then id, and prefers the newer copy", () => {
  const merged = merge(
    [msg("b", 2), msg("a", 2), msg("old", 1)],
    [msg("b", 2, "edited"), msg("c", 3)],
  );
  expect(merged.map((m) => m.id)).toEqual(["old", "a", "b", "c"]);
  expect(merged.find((m) => m.id === "b")?.body).toBe("edited");
});
