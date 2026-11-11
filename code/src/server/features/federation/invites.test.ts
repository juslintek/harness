import { expect, test } from "bun:test";
import { consumeInvite, createInvite, INVITE_TTL_MS } from "./invites";
import { freshDb } from "./test-kit";

test("an invite works once and a second use is refused", () => {
  const db = freshDb();
  const { token } = createInvite(db, "u1", 1000);
  expect(consumeInvite(db, token, 2000)).toBe(true);
  expect(consumeInvite(db, token, 2001)).toBe(false);
});

test("an expired invite is refused, one at the edge of the window is too", () => {
  const db = freshDb();
  const { token, expiresAt } = createInvite(db, "u1", 1000);
  expect(expiresAt).toBe(1000 + INVITE_TTL_MS);
  expect(consumeInvite(db, token, expiresAt)).toBe(false);
  expect(consumeInvite(db, token, expiresAt - 1)).toBe(true);
});

test("a wrong token is refused and leaves the real invite usable", () => {
  const db = freshDb();
  const { token } = createInvite(db, "u1", 1000);
  expect(consumeInvite(db, `${token}x`, 1001)).toBe(false);
  expect(consumeInvite(db, "", 1001)).toBe(false);
  expect(consumeInvite(db, token, 1002)).toBe(true);
});

test("the token is never stored in clear", () => {
  const db = freshDb();
  const { token } = createInvite(db, "u1");
  const rows = JSON.stringify(db.query("SELECT * FROM fed_invites").all());
  expect(rows).not.toContain(token);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
