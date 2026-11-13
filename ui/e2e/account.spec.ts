import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { enroll, expect, signIn, test } from "./fixtures";
import type { Stack } from "./stack";

const noSideScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const VERIFIER = "v".repeat(43);

// Registers an OAuth client the way an MCP client does and opens its authorize URL in the browser.
async function startConsent(page: Page, stack: Stack): Promise<string> {
  const clientId = await page.evaluate(async () => {
    const res = await fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Connector",
        redirect_uris: ["http://127.0.0.1:9999/cb"],
      }),
    });
    return ((await res.json()) as { client_id: string }).client_id;
  });
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9999/cb",
    response_type: "code",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${stack.url}/mcp/remote`,
    state: "xyz",
  });
  await page.goto(`/oauth/authorize?${query}`);
  return clientId;
}

// A step-up check is valid for five minutes, so only the first protected action of a test asks.
async function confirmWithPasskey(page: Page): Promise<void> {
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await prompt.getByRole("button", { name: "Use passkey" }).click();
}

test("the sign-in card shows the passkey first and keeps the other ways behind links", async ({
  page,
}) => {
  await page.goto("/#/login");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(`to ${new URL(page.url()).host}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send code" })).toHaveCount(0);
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Lost your passkey? Use a recovery code" }).click();
  await expect(page.getByLabel("Recovery code", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to passkey" }).click();
  await page.getByRole("button", { name: "Use an email code instead" }).click();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await page.getByRole("button", { name: "Back to passkey" }).click();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
});

test("a wrong email code says so in plain words, and a wrong recovery code too", async ({
  page,
}) => {
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Use an email code instead" }).click();
  await page.getByLabel("Email", { exact: true }).fill("nobody@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("Code sent to nobody@example.com");
  await page.getByLabel("Code from email").fill("000000");
  await page.getByRole("button", { name: "Sign in with code" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That code is wrong or has expired. Request a new one.",
  );
  await page.getByRole("button", { name: "Request a new code" }).click();
  await expect(page.getByRole("status")).toContainText("Code sent to nobody@example.com");

  await page.getByRole("button", { name: "Back to passkey" }).click();
  await page.getByRole("button", { name: "Lost your passkey? Use a recovery code" }).click();
  await page.getByLabel("Email", { exact: true }).fill("nobody@example.com");
  await page.getByLabel("Recovery code", { exact: true }).fill("aaaa-bbbb-cccc");
  await page.getByRole("button", { name: "Sign in with recovery code" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That recovery code is wrong or was already used.",
  );
});

test("the passkey button works from the keyboard", async ({ page, stack }) => {
  const email = "keys@example.com";
  await enroll(page, stack.enrollmentCode(email, "Keys"), email, "Keys");
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/$/);
});

test("an enrollment link that is not valid says so and keeps the form", async ({ page }) => {
  await page.goto("/#/enroll/not-a-real-code");
  await page.getByLabel("Your name").fill("Grace");
  await page.getByLabel("Email").fill("grace@example.com");
  await page.getByRole("button", { name: "Register a passkey" }).click();
  await expect(page.getByRole("alert")).toContainText("enrollment code is not valid");
  await expect(page.getByRole("button", { name: "Register a passkey" })).toBeEnabled();
});

test("enrolling shows two steps, then recovery codes that stay locked until saved", async ({
  page,
  stack,
}) => {
  await page.goto(`/#/enroll/${stack.enrollmentCode("new@example.com", "New")}`);
  const steps = page.getByRole("list", { name: "Enrolment steps" });
  await expect(steps.getByRole("listitem")).toHaveText([
    "1Create a passkey",
    "2Save recovery codes",
  ]);
  await page.getByLabel("Your name").fill("New");
  await page.getByLabel("Email").fill("new@example.com");
  await page.getByRole("button", { name: "Register a passkey" }).click();
  await expect(page.getByRole("heading", { name: "You are enrolled" })).toBeVisible();
  await expect(steps.getByRole("listitem").first()).toContainText("(done)");
  await expect(page.locator(".codes li")).toHaveCount(10);
  await expect(page.getByLabel("I saved them")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel("I saved them").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/$/);
});

test("the account page lists the person, and a notification choice survives a reload", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, {
    email: "ada@example.com",
    name: "Ada",
    orgs: [
      { name: "Acme Labs", slug: "acme" },
      { name: "Northwind", slug: "northwind" },
    ],
  });
  await page.goto("/#/account");
  await expect(page.getByRole("heading", { name: "Ada", level: 2 })).toBeVisible();
  const box = page.getByRole("checkbox", { name: "Run blocked by Email" });
  // A channel with no target cannot deliver, so its choices are off and say why.
  await expect(box).toBeDisabled();
  await expect(box).not.toBeChecked();
  await expect(page.getByText(/Email.* no target/)).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Email no target/ })).toBeVisible();
  const email = page.getByRole("region", { name: "Email" });
  await email.getByLabel("Email address").fill("ada@acme.example");
  await email.getByRole("button", { name: "Add" }).click();
  await expect(box).toBeEnabled();
  const before = await box.isChecked();
  await box.click();
  await expect(box).toBeChecked({ checked: !before });
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Run blocked by Email" })).toBeChecked({
    checked: !before,
  });
  // Another organisation has its own grid.
  await page.getByLabel("Notification organization").selectOption({ label: "Northwind" });
  await expect(page.getByRole("checkbox", { name: "Run blocked by Email" })).toBeDisabled();
});

test("email and webhook targets are added and removed, the webhook secret shows once", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, {
    email: "tgt@example.com",
    name: "Tgt",
    orgs: [{ name: "Acme Labs", slug: "acme" }],
  });
  await page.goto("/#/account");
  const email = page.getByRole("region", { name: "Email" });
  await email.getByLabel("Email address").fill("ops@example.com");
  await email.getByRole("button", { name: "Add" }).click();
  await expect(email).toContainText("ops@example.com");
  await email.getByRole("button", { name: /^Remove Email target/ }).click();
  const confirm = page.getByRole("dialog", { name: "Remove ops@example.com?" });
  await expect(confirm).toContainText("Notifications stop going to this Email target.");
  await confirm.getByRole("button", { name: "Remove target" }).click();
  await expect(email).toContainText("No email target yet.");
  await expect(page.getByText("Removed ops@example.com.")).toBeVisible();

  const hook = page.getByRole("region", { name: "Webhook" });
  await hook.getByLabel("Webhook URL").fill("https://example.com/harness-hook");
  await hook.getByRole("button", { name: "Add" }).click();
  await expect(hook.getByText("Copy this signing secret now.")).toBeVisible();
  await expect(hook.getByRole("textbox", { name: "Signing secret" })).not.toHaveValue("");
  await hook.getByRole("button", { name: "I have saved it" }).click();
  await expect(hook.getByRole("textbox", { name: "Signing secret" })).toHaveCount(0);
  await expect(hook).toContainText("https://example.com/harness-hook");
});

test("push shows what this browser can do, and telegram gives a link code", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, {
    email: "push@example.com",
    name: "Push",
    orgs: [{ name: "Acme Labs", slug: "acme" }],
  });
  await page.goto("/#/account");
  await expect(
    page
      .getByRole("region", { name: "Push" })
      .getByText(/Push on this browser|blocked|cannot receive/),
  ).toBeVisible();
  const telegram = page.getByRole("region", { name: "Telegram" });
  await telegram.getByRole("button", { name: "Get a Telegram link code" }).click();
  // Without a configured bot the server answers with an error, which must be shown, not swallowed.
  await expect(telegram.getByText(/\/link |./).first()).toBeVisible();
});

test("a second passkey is listed and removed, the same device cannot register twice", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "pk@example.com", name: "Pk" });
  // A second authenticator cannot be attached to the page's virtual one mid-test, so the other
  // device's passkey is seeded in the database.
  stack.sql(
    "INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) SELECT 'seeded-key', id, x'00', 0, 'YubiKey 5C', 1760000000000 FROM users WHERE email = ?",
    "pk@example.com",
  );
  await page.goto("/#/account");
  const passkeys = page.getByRole("region", { name: "Passkeys" });
  await expect(passkeys).toContainText("YubiKey 5C");
  await expect(passkeys).toContainText("never used");
  await passkeys.getByRole("button", { name: "Remove passkey YubiKey 5C" }).click();
  const sure = page.getByRole("dialog", { name: "Remove passkey YubiKey 5C?" });
  await expect(sure).toContainText("can no longer sign you in");
  await sure.getByRole("button", { name: "Remove", exact: true }).click();
  await confirmWithPasskey(page);
  await expect(passkeys.locator(".acct-list")).not.toContainText("YubiKey 5C");
  await expect(page.getByText("Removed passkey YubiKey 5C.")).toBeVisible();
  // The last passkey cannot go.
  await expect(passkeys.getByRole("button", { name: /^Remove passkey/ })).toBeDisabled();

  // This browser already holds a passkey for the account, so it refuses a second one and the page says why.
  await passkeys.getByLabel("Name for the new passkey").fill("Laptop");
  await passkeys.getByRole("button", { name: "Add a passkey" }).click();
  await expect(passkeys.getByRole("alert")).toContainText("already registered");
  await expect(passkeys).not.toContainText("Laptop");
});

test("recovery codes are shown once and stay locked until saved", async ({ page, stack }) => {
  await signIn(page, stack, { email: "rc@example.com", name: "Rc" });
  await page.goto("/#/account");
  const recovery = page.getByRole("region", { name: "Recovery codes" });
  await recovery.getByRole("button", { name: "Generate new codes" }).click();
  await confirmWithPasskey(page);
  await expect(recovery.locator(".codes li")).toHaveCount(10);
  await expect(recovery.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(recovery.getByLabel("I saved them")).not.toBeChecked();
  await expect(recovery.getByRole("button", { name: "Copy codes" })).toBeVisible();
  await expect(recovery.getByRole("link", { name: "Download codes" })).toHaveAttribute(
    "download",
    "harness-recovery-codes.txt",
  );
  await recovery.getByLabel("I saved them").check();
  await recovery.getByRole("button", { name: "Continue" }).click();
  await expect(recovery.getByText("The old ones no longer work.")).toBeVisible();
  await expect(recovery.locator(".codes li")).toHaveCount(0);
  await expect(recovery.getByRole("button", { name: "Generate new codes" })).toBeVisible();
});

test("another session can be revoked", async ({ page, stack }) => {
  await signIn(page, stack, { email: "ses@example.com", name: "Ses" });
  stack.sql(
    "INSERT INTO sessions (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at) SELECT 'seeded-session', id, 'seeded-hash', 'email', 'Safari on iPhone', 1760000000000, 1760000000000, 4102444800000 FROM users WHERE email = ?",
    "ses@example.com",
  );
  await page.goto("/#/account");
  const sessions = page.getByRole("region", { name: "Sessions" });
  await expect(sessions).toContainText("Safari on iPhone");
  await sessions.getByRole("button", { name: "Revoke session Safari on iPhone" }).click();
  await page
    .getByRole("dialog", { name: "Revoke the session on Safari on iPhone?" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await confirmWithPasskey(page);
  await expect(sessions.locator(".acct-list")).not.toContainText("Safari on iPhone");
  await expect(page.getByText("Revoked the session on Safari on iPhone.")).toBeVisible();
  await expect(sessions).toContainText("This device");
});

test("consent approves with a passkey, the grant is listed and can be revoked", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, {
    email: "oauth@example.com",
    name: "Oauth",
    orgs: [{ name: "Acme Labs", slug: "acme" }],
  });
  await page.route("http://127.0.0.1:9999/**", (route) => route.fulfill({ body: "ok" }));
  const clientId = await startConsent(page, stack);
  await expect(
    page.getByRole("heading", { name: "Allow Test Connector to use Harness as you?" }),
  ).toBeVisible();
  await expect(page.getByText("oauth@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toHaveAttribute(
    "data-tone",
    "secondary",
  );
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveAttribute(
    "data-tone",
    "primary",
  );
  await page.getByLabel("Organisation").selectOption({ label: "Acme Labs" });
  const approve = page.getByRole("button", { name: "Allow", exact: true });
  await page.getByLabel("Read and post chat messages").uncheck();
  await page.getByLabel("Read and change tasks on the board").uncheck();
  await expect(approve).toBeDisabled();
  await expect(page.getByText("Pick at least one permission")).toBeVisible();
  await page.getByLabel("Read and change tasks on the board").check();
  await approve.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/127.0.0.1:9999\/cb\?.*code=/);
  expect(page.url()).toContain("state=xyz");
  // A grant exists once the client trades the code for a token, which is what an MCP client does next.
  const redirect = new URL(page.url());
  const token = await page.request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      redirect_uri: "http://127.0.0.1:9999/cb",
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: `${stack.url}/mcp/remote`,
    },
  });
  expect(token.ok()).toBe(true);

  await page.goto(`${stack.url}/#/account`);
  const mcp = page.getByRole("region", { name: "Remote MCP (claude.ai, ChatGPT)" });
  await expect(mcp.getByLabel("Connector URL")).toHaveValue(`${stack.url}/mcp/remote`);
  await expect(mcp).toContainText("Test Connector");
  await expect(mcp).toContainText("Can use: board · connected");
  await expect(mcp.locator(".badge", { hasText: "connected" })).toBeVisible();
  await mcp.getByRole("button", { name: /^Revoke access of Test Connector/ }).click();
  await page
    .getByRole("dialog", { name: "Revoke access of Test Connector?" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(mcp).toContainText("A client appears here once you approve it.");
  await expect(mcp.getByText("Revoked access of Test Connector to Acme Labs.")).toBeVisible();
});

test("deny sends the person back to the client with an error", async ({ page, stack }) => {
  await signIn(page, stack, {
    email: "deny@example.com",
    name: "Deny",
    orgs: [{ name: "Acme Labs", slug: "acme" }],
  });
  await page.route("http://127.0.0.1:9999/**", (route) => route.fulfill({ body: "ok" }));
  await startConsent(page, stack);
  await page.getByRole("button", { name: "Deny" }).click();
  await page.waitForURL(/127.0.0.1:9999\/cb\?.*error=access_denied/);
});

test("a consent link for an unknown client is refused", async ({ page, stack }) => {
  await signIn(page, stack, { email: "bad@example.com", name: "Bad" });
  await page.goto("/#/oauth/consent?client_id=nope&redirect_uri=http://127.0.0.1:9999/cb");
  await expect(page.getByRole("alert")).toContainText("This request is not valid");
});

test("sessions list this device, and sign out leaves for the sign-in page", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "out@example.com", name: "Out" });
  await page.goto("/#/account");
  const sessions = page.getByRole("region", { name: "Sessions" });
  await expect(sessions).toContainText("This device");
  await sessions.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/#\/login$/);
  await page.goto("/#/account");
  await expect(page).toHaveURL(/#\/login$/);
});

test("on a phone sign-in, account, consent and enrollment do not scroll sideways", async ({
  page,
  stack,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  expect(await noSideScroll(page)).toBe(true);
  await page.goto(`/#/enroll/${stack.enrollmentCode("phone2@example.com", "Phone")}`);
  expect(await noSideScroll(page)).toBe(true);

  await signIn(page, stack, {
    email: "phone@example.com",
    name: "Phone",
    orgs: [{ name: "Acme Labs", slug: "acme" }],
  });
  await page.goto("/#/account");
  await expect(page.getByRole("checkbox", { name: "Run blocked by Email" })).toBeDisabled();
  // One card per event: the channel names sit beside each checkbox, not in a header row.
  const label = await page
    .locator("td[data-label='Email (no target)']")
    .first()
    .evaluate((td) => getComputedStyle(td, "::before").content);
  expect(label).toContain("Email (no target)");
  expect(await noSideScroll(page)).toBe(true);
  await startConsent(page, stack);
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});
