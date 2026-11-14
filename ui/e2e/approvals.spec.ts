import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";
import type { Stack } from "./stack";

const ADMIN = { email: "ada@acme.example", name: "Ada", admin: true };

async function noPageScroll(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
}

function seed(
  stack: Stack,
  id: string,
  command: string,
  expiresIn: number,
  decided?: { status: string; by: string; ago: number },
): void {
  const now = Date.now();
  stack.sql(
    "INSERT INTO approvals (id, run_id, action, l1, status, decided_by, created_at, expires_at, decided_at) VALUES (?, 'run_x', ?, ?, ?, ?, ?, ?, ?)",
    id,
    JSON.stringify({ command }),
    id === "ap_late" ? JSON.stringify({ reason: "Pushes to a remote." }) : "{}",
    decided?.status ?? "pending",
    decided?.by ?? "",
    now - 1000,
    now + expiresIn,
    decided ? now - decided.ago : 0,
  );
}

async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(dialog).toBeHidden();
}

test("waiting approvals are sorted by expiry and decided with the keyboard", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  seed(stack, "ap_late", "git push origin harness/fix-rate-limit now", 600_000);
  seed(stack, "ap_soon", "rm -rf build", 90_000);
  await page.goto("/#/approvals");

  const waiting = page.getByRole("list", { name: "Waiting approvals" });
  await expect(page.getByRole("link", { name: "Waiting 2" })).toBeVisible();
  const titles = waiting.getByRole("heading", { level: 3 });
  await expect(titles).toHaveText(["rm -rf build", "git push origin …"]);
  const soon = page.getByRole("region", { name: "rm -rf build" });
  await expect(soon.getByRole("timer")).toContainText("Expires in 1:");
  const late = page.getByRole("region", { name: "git push origin …" });
  await expect(late).toContainText("Pushes to a remote.");
  await expect(late).toContainText("git push origin harness/fix-rate-limit now");
  await expect(soon).toContainText("No reason given.");
  await noPageScroll(page);

  stack.expireStepUp();
  await soon.getByRole("button", { name: "Deny" }).focus();
  await page.keyboard.press("Enter");
  await usePasskey(page);
  await expect(soon).toContainText("Denied rm -rf build. The command will not run.");
  await expect(soon.getByRole("button", { name: "Deny" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Waiting 1" })).toBeVisible();

  await late.getByRole("button", { name: "Approve command" }).focus();
  await page.keyboard.press("Enter");
  await expect(late).toContainText("Approved git push origin ….");
  await expect(late).toContainText("can run this command now. Approved by you at");
  await expect(late.getByRole("button", { name: "Open run" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Waiting/ })).toHaveText("Waiting");
});

test("the Decided tab lists decided and expired approvals, newest first", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  seed(stack, "ap_old", "ls -la", 600_000, { status: "denied", by: "user:someone", ago: 120_000 });
  seed(stack, "ap_new", "bun test", 600_000, {
    status: "approved",
    by: "user:someone",
    ago: 5_000,
  });
  seed(stack, "ap_exp", "curl example.test", -60_000);
  await page.goto("/#/approvals");
  await expect(page.getByText("Nothing waiting for a decision")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Policies" })).toBeVisible();

  await page.getByRole("button", { name: "See decided approvals" }).click();
  await expect(page).toHaveURL(/#\/approvals\/decided$/);
  await expect(page.getByRole("link", { name: "Decided" })).toHaveAttribute("aria-current", "page");
  const decided = page.getByRole("list", { name: "Decided approvals" });
  await expect(decided.getByRole("heading", { level: 3 })).toHaveText([
    "bun test",
    "ls -la",
    "curl example.test",
  ]);
  await expect(decided).toContainText("approved");
  await expect(decided).toContainText("denied");
  await expect(decided).toContainText("No decision before it expired.");
  await expect(decided).toContainText("by someone at");
  await expect(decided.getByRole("button", { name: "Approve command" })).toHaveCount(0);
  await noPageScroll(page);
});
