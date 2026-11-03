import { expect, test } from "bun:test";
import { migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { findUserByEmail, redeemEnrollment } from "../src/server/features/auth/api";
import { enrollLink } from "./enroll";

test("a new email gets a named account, an existing one keeps theirs, and the link redeems", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const link = enrollLink(db, "http://localhost:4100", { email: "ann@example.com", name: "Ann" });
  const code = link.split("/#/enroll/")[1] ?? "";
  const user = findUserByEmail(db, "ann@example.com");
  expect(user?.name).toBe("Ann");
  expect(user?.instanceAdmin).toBe(false);
  expect(redeemEnrollment(db, code, { email: "x@example.com", name: "X" })).toBe(user?.id ?? "");
  enrollLink(db, "http://localhost:4100", { email: "ann@example.com", name: "Other" });
  expect(findUserByEmail(db, "ann@example.com")?.name).toBe("Ann");
});

test("a re-issued link for an existing user kills the earlier unused one", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const code = (link: string): string => link.split("/#/enroll/")[1] ?? "";
  const who = { email: "bob@example.com", name: "Bob" };
  const first = code(enrollLink(db, "http://localhost:4100", who));
  const second = code(enrollLink(db, "http://localhost:4100", who));
  const profile = { email: "x@example.com", name: "X" };
  expect(redeemEnrollment(db, first, profile)).toBeNull();
  expect(redeemEnrollment(db, second, profile)).toBe(findUserByEmail(db, who.email)?.id ?? "");
});
