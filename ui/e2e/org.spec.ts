import { expect as baseExpect, type Page } from "@playwright/test";
import { enroll, expect, signIn, test } from "./fixtures";

const usePasskey = (page: Page) => page.getByRole("button", { name: "Use passkey" }).click();

const ADMIN = {
  email: "ada@acme.example",
  name: "Ada",
  admin: true,
  orgs: [{ name: "Acme Labs", slug: "acme" }],
};

test("settings shows the org, creates a team and invites a member", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await expect(page.getByRole("heading", { name: "Acme Labs" })).toBeVisible();
  for (const title of ["Teams", "Members", "Positions", "Projects", "Slack and Telegram bridges"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }

  await page.getByLabel("New team").fill("Platform");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("list").getByText("Platform")).toBeVisible();

  await page.getByLabel("Invite by email").fill("dev@acme.example");
  await page.getByLabel("Role", { exact: true }).selectOption("viewer");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Send this enrollment link")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the enrollment link" })).toBeVisible();
});

test("an admin changes a role, pauses nothing for humans and removes a member after confirming", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await page.getByLabel("Invite by email").fill("ravi@acme.example");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Send this enrollment link")).toBeVisible();
  const handle = page.getByRole("row").filter({ hasText: "ravi" });
  await expect(handle).toBeVisible();
  const role = page.getByRole("combobox", { name: /^Role of @/ }).last();
  // The select shows the new role before the server has it, so a reload must wait for the saved PATCH.
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.ok());
  await role.selectOption("admin");
  await usePasskey(page);
  await saved;
  await expect(role).toHaveValue("admin");
  await page.reload();
  await expect(page.getByRole("combobox", { name: /^Role of @/ }).last()).toHaveValue("admin");

  await page
    .getByRole("button", { name: /^Remove @/ })
    .last()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("loses access");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("row").filter({ hasText: "ravi" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Remove @/ })
    .last()
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();

  await expect(page.getByRole("row").filter({ hasText: "ravi" })).toHaveCount(0);
});

test("a new position and a project can be added", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await expect(page.getByText("No positions yet.")).toBeVisible();
  await page.getByLabel("Title").fill("Engineering lead");
  await page.getByRole("button", { name: "Add position" }).click();
  await expect(page.locator(".position", { hasText: "Engineering lead" })).toBeVisible();
  await expect(page.locator(".position .muted", { hasText: "vacant" })).toBeVisible();

  await page.getByLabel("Key", { exact: true }).fill("HRN");
  await page.getByLabel("Name", { exact: true }).fill("Harness");
  await page.getByLabel("Repo path (instance admin only)").fill("/tmp/harness-repo");
  await page.getByRole("button", { name: "Create project" }).click();
  await usePasskey(page);
  await expect(page.locator(".field-error")).toContainText("not a git repo");
  await page.getByLabel("Repo path (instance admin only)").fill("");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("link", { name: /HRN Harness/ })).toBeVisible();
});

test("a refused request shows its error next to the form", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await page.getByLabel("Invite by email").fill(ADMIN.email);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.locator(".field-error")).toHaveText("conflict");
  await expect(page.getByText("Send this enrollment link")).toHaveCount(0);
});

test("an unknown org says so", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/nope/settings");
  await expect(page.getByText("Org not found")).toBeVisible();
});

test("a bridge is added with step-up and removed after confirming", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await expect(page.getByText("No channel is bridged.")).toBeVisible();
  await page.getByLabel("Harness channel").selectOption({ index: 1 });
  await page.getByLabel("Slack channel id (starts with C)").fill("C04F9K2LM");
  await page.getByRole("button", { name: "Bridge channel" }).click();
  await usePasskey(page);
  await expect(page.getByRole("cell", { name: "C04F9K2LM" })).toBeVisible();

  await page.getByRole("button", { name: /^Remove the Slack bridge/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove bridge" }).click();
  await expect(page.getByText("No channel is bridged.")).toBeVisible();
});

test("a Slack link code is shown with its command", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await page.getByRole("button", { name: "Get a Slack link code" }).click();
  await expect(page.getByText(/\/link [A-Z0-9]+/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the Slack link command" })).toBeVisible();
});

test("keyboard: the team form submits with Enter", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await page.getByLabel("New team").focus();
  await page.keyboard.type("Reach");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list").getByText("Reach")).toBeVisible();
});

test("a viewer sees the lists without any form or action", async ({ page, stack, browser }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await page.getByLabel("Invite by email").fill("view@acme.example");
  await page.getByLabel("Role", { exact: true }).selectOption("viewer");
  await page.getByRole("button", { name: "Invite" }).click();
  const link = await page.locator(".notice code").textContent();
  const code = (link ?? "").split("/#/enroll/")[1] as string;

  const context = await browser.newContext({ baseURL: stack.url });
  const other = await context.newPage();
  const cdp = await context.newCDPSession(other);
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
  await enroll(other, code, "view@acme.example", "Vera");
  await other.goto("/#/login");
  await other.getByRole("button", { name: "Sign in with a passkey" }).click();
  await baseExpect(other).toHaveURL(/#\/$/);
  await other.goto("/#/o/acme/settings");
  await baseExpect(other.getByRole("heading", { name: "Members" })).toBeVisible();
  await baseExpect(other.getByRole("button", { name: "Create team" })).toHaveCount(0);
  await baseExpect(other.getByRole("button", { name: "Invite" })).toHaveCount(0);
  await baseExpect(other.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await baseExpect(other.getByRole("heading", { name: "Slack and Telegram bridges" })).toHaveCount(
    0,
  );
  await context.close();
});

test("no horizontal page scroll at phone width", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#/o/acme/settings");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
});
