import { expect, test } from "bun:test";
import { statusWord } from "./status";

test("raw values become plain words, and waiting for you is a warning", () => {
  expect(statusWord("in_progress")).toEqual({ word: "in progress", tone: "neutral" });
  expect(statusWord("tool_call").word).toBe("command");
  expect(statusWord("waiting_approval")).toEqual({ word: "waiting for you", tone: "warning" });
  expect(statusWord("pending", "approval")).toEqual({ word: "waiting for you", tone: "warning" });
  expect(statusWord("pending", "wakeup")).toEqual({ word: "queued", tone: "neutral" });
  expect(statusWord("warn", "budget").word).toBe("near limit");
  expect(statusWord("deciding", "hire").tone).toBe("warning");
  expect(statusWord("answering", "hire").word).toBe("answering follow-ups");
});
