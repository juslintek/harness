import { expect, test } from "bun:test";
import { orgUrl } from "./notify-data";

test("notification requests include their selected organization", () => {
  expect(orgUrl("/api/notify/prefs", "team-a")).toBe("/api/notify/prefs?org=team-a");
});
