import { test as base, expect, type Page } from "@playwright/test";
import { type Stack, startStack } from "./stack";

interface Fixtures {
  // A virtual platform authenticator that remembers its passkeys for the life of the test's page.
  passkeys: undefined;
  // One server per test: auth endpoints are rate limited per address, and each test enrolls and
  // signs in, so a shared server would run out of attempts.
  stack: Stack;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from the first parameter's pattern
  stack: async ({}, use) => {
    const stack = await startStack();
    await use(stack);
    await stack.stop();
  },
  baseURL: async ({ stack }, use) => use(stack.url),
  passkeys: [
    async ({ context, page }, use) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await use(undefined);
    },
    { auto: true },
  ],
});

// Registers a passkey through the enrollment API. The enrollment page is ported in a later chunk,
// so the ceremony is driven from the page context, which is where the virtual authenticator lives.
export async function enroll(page: Page, code: string, email: string, name: string): Promise<void> {
  await page.goto("/#/login");
  await page.evaluate(
    async ({ code: c, email: e, name: n }) => {
      const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
        const res = await fetch(`/api/auth/enroll/${encodeURIComponent(c)}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      };
      const options = await post("options", { name: n, email: e });
      const credential = await navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
          options as unknown as PublicKeyCredentialCreationOptionsJSON,
        ),
      });
      if (!(credential instanceof PublicKeyCredential)) throw new Error("no credential");
      await post("verify", {
        challengeId: options.challengeId,
        userId: options.userId,
        response: credential.toJSON(),
        name: "This device",
      });
    },
    { code, email, name },
  );
  await page.context().clearCookies();
}

// Enrolls, then signs in with the passkey and waits for the shell. With `orgs`, the person also
// creates those organisations (and becomes their owner) before the page is loaded again.
export async function signIn(
  page: Page,
  stack: Stack,
  who: { email: string; name: string; admin?: boolean; orgs?: { name: string; slug: string }[] },
): Promise<void> {
  await enroll(page, stack.enrollmentCode(who.email, who.name), who.email, who.name);
  if (who.admin) stack.makeInstanceAdmin(who.email);
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator("#content")).toBeVisible();
  for (const org of who.orgs ?? []) {
    await page.evaluate(async (body) => {
      const res = await fetch("/api/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`create org: HTTP ${res.status}`);
    }, org);
  }
  if (who.orgs?.length) await page.reload();
}

export { expect };
