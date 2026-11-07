import { expect, test } from "bun:test";
import { bootOauth, flow } from "../../test-support/oauth-kit";
import {
  mintLocalLinkToken,
  revokeLocalLinkToken,
  revokeLocalLinkTokens,
  verifyAccessToken,
} from "./api";

test("a token whose member left the org stops verifying on the next call", async () => {
  const { kit, tokens } = await flow();
  expect(verifyAccessToken(kit.api.db, tokens.access_token)).not.toBeNull();
  kit.api.db.query("DELETE FROM members WHERE id = ?").run(kit.org.owner.id);
  expect(verifyAccessToken(kit.api.db, tokens.access_token)).toBeNull();
});

test("a token is bound to its org: the same user in another org gets no access there", async () => {
  const { kit, tokens } = await flow();
  const second = kit.api.org(kit.owner, "second");
  const who = verifyAccessToken(kit.api.db, tokens.access_token);
  expect(who?.orgId).toBe(kit.org.id);
  expect(who?.orgId).not.toBe(second.id);
});

test("scopes come from the stored row on every call", async () => {
  const { kit, tokens } = await flow();
  kit.api.db.query("UPDATE oauth_tokens SET scopes = 'board'").run();
  expect(verifyAccessToken(kit.api.db, tokens.access_token)?.scopes).toEqual(["board"]);
});

test("grants list, revoke and the revoked access token is dead", async () => {
  const { kit, clientId, tokens } = await flow();
  const list = (await (await kit.api.call(kit.owner, "GET", "/api/oauth/grants")).json()) as {
    id: string;
    clientName: string;
    orgId: string;
  }[];
  expect(list).toHaveLength(1);
  expect(list[0]?.clientName).toBe("Claude");
  expect(list[0]?.orgId).toBe(kit.org.id);
  const stranger = await kit.api.user({ stepUp: true });
  const theirs = await kit.api.call(stranger, "DELETE", `/api/oauth/grants/${list[0]?.id}`);
  expect(theirs.status).toBe(404);
  expect(verifyAccessToken(kit.api.db, tokens.access_token)).not.toBeNull();
  const del = await kit.api.call(kit.owner, "DELETE", `/api/oauth/grants/${list[0]?.id}`);
  expect(del.status).toBe(200);
  expect(verifyAccessToken(kit.api.db, tokens.access_token)).toBeNull();
  const after = (await (
    await kit.api.call(kit.owner, "GET", "/api/oauth/grants")
  ).json()) as unknown[];
  expect(after).toHaveLength(0);
  const refresh = await kit.post(
    "/oauth/token",
    { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token },
    true,
  );
  expect(refresh.status).toBe(400);
});

test("the local link token is a year-long board and chat token for that member", async () => {
  const kit = await bootOauth();
  const token = mintLocalLinkToken(kit.api.db, kit.org.owner.id, kit.org.id);
  const who = verifyAccessToken(kit.api.db, token);
  expect(who?.scopes).toEqual(["board", "chat"]);
  expect(verifyAccessToken(kit.api.db, token, Date.now() + 364 * 86_400_000)).not.toBeNull();
  expect(verifyAccessToken(kit.api.db, token, Date.now() + 366 * 86_400_000)).toBeNull();
  const grants = (await (await kit.api.call(kit.owner, "GET", "/api/oauth/grants")).json()) as {
    clientName: string;
  }[];
  expect(grants[0]?.clientName).toBe("Claude Desktop (local)");
  expect(() => mintLocalLinkToken(kit.api.db, "nobody", kit.org.id)).toThrow();
});

test("revokeLocalLinkTokens kills the member's desktop tokens and leaves other members' alone", async () => {
  const kit = await bootOauth();
  const other = await kit.api.user();
  const otherMember = kit.api.join(kit.org.id, other, "member", "other");
  const mine = mintLocalLinkToken(kit.api.db, kit.org.owner.id, kit.org.id);
  const theirs = mintLocalLinkToken(kit.api.db, otherMember.id, kit.org.id);
  expect(revokeLocalLinkTokens(kit.api.db, kit.org.owner.id)).toBe(1);
  expect(verifyAccessToken(kit.api.db, mine)).toBeNull();
  expect(verifyAccessToken(kit.api.db, theirs)).not.toBeNull();
});

test("revoking a stored Desktop token preserves ordinary OAuth and independent grant families", async () => {
  const { kit, tokens } = await flow();
  const first = mintLocalLinkToken(kit.api.db, kit.org.owner.id, kit.org.id);
  const independent = mintLocalLinkToken(kit.api.db, kit.org.owner.id, kit.org.id);
  expect(revokeLocalLinkToken(kit.api.db, tokens.access_token)).toBe(0);
  expect(revokeLocalLinkToken(kit.api.db, first)).toBe(1);
  expect(verifyAccessToken(kit.api.db, first)).toBeNull();
  expect(verifyAccessToken(kit.api.db, independent)).not.toBeNull();
  expect(verifyAccessToken(kit.api.db, tokens.access_token)).not.toBeNull();
});
