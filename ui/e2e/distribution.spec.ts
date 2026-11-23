import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const ADA = { email: "ada@example.com", name: "Ada", admin: true };

async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("distribution pages", () => {
  test("non-admins see Not available on federation, deploy, and updates", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "bob@example.com", name: "Bob" });
    for (const hash of ["#/federation", "#/deploy", "#/updates"]) {
      await page.goto(`/${hash}`);
      await expect(page.getByText("Not available.")).toBeVisible();
    }
  });

  test("admin can navigate from Integrations and create a federation invite with step-up", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    await page.goto("/#/integrations");
    const other = page.getByRole("region", { name: "Other connections" });
    await expect(other.getByRole("link", { name: "Manage federation" })).toBeVisible();
    await expect(other.getByRole("link", { name: "Manage deploy" })).toBeVisible();
    await expect(other.getByRole("link", { name: "Manage updates" })).toBeVisible();

    await other.getByRole("link", { name: "Manage federation" }).click();
    await expect(page).toHaveURL(/#\/federation$/);
    await expect(
      page.locator("#content").getByRole("heading", { level: 1, name: "Federation" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "This instance" })).toBeVisible();

    await page.getByRole("button", { name: "Create invite" }).click();
    await usePasskey(page);
    await expect(page.getByRole("button", { name: "Copy invite token" })).toBeVisible();

    await page.goto("/#/deploy");
    await expect(
      page.locator("#content").getByRole("heading", { level: 1, name: "Deploy" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Targets" })).toBeVisible();
    await expect(page.getByText("No deploy requests yet.")).toBeVisible();

    await page.goto("/#/updates");
    await expect(
      page.locator("#content").getByRole("heading", { level: 1, name: "Updates" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Request update" })).toBeVisible();
    await expect(page.getByText("No update requests from this browser yet.")).toBeVisible();
  });
});
