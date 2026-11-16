import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const SHOTS = process.env.SHOTS_DIR;
const ADA = { email: "ada@example.com", name: "Ada", admin: true };

// The passkey sign-in does not count as a step-up, so the first protected action asks for one.
async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("integrations", () => {
  test("a person who is not an instance admin sees nothing to manage", async ({ page, stack }) => {
    await signIn(page, stack, { email: "bob@example.com", name: "Bob" });
    await page.goto("/#/integrations");
    await expect(page.getByText("Not available.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Email (SMTP)" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Integrations" })).toHaveCount(0);
  });

  test("an admin sees the three integrations with their real state", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: "Integrations" }).click();
    await expect(page).toHaveURL(/#\/integrations$/);
    await expect(page.getByRole("heading", { name: "Email (SMTP)" })).toBeVisible();
    const tunnel = page.getByRole("region", { name: "Remote access (tunnel)" });
    await expect(tunnel.locator(".badge", { hasText: /^stopped$/ })).toBeVisible();
    await expect(tunnel).toContainText("Nothing saved yet.");
    await expect(tunnel.getByRole("list", { name: "Remote access steps" })).toBeVisible();
    await expect(tunnel.getByRole("button", { name: "Stop tunnel" })).toBeDisabled();
    const desktop = page.getByRole("region", { name: "Claude Desktop" });
    await expect(desktop.locator(".badge", { hasText: /^not linked$/ })).toBeVisible();
    await expect(desktop.getByRole("list", { name: "Claude Desktop steps" })).toBeVisible();
    await expect(desktop.getByRole("button", { name: "Unlink" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Other connections" })).toContainText(
      "Remote MCP",
    );
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/integrations-1440-light.png`, fullPage: true });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/integrations-1440-dark.png`, fullPage: true });
    }
  });

  test("a test mail without saved settings shows the server's answer", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await page.goto("/#/integrations");
    await expect(page.locator(".badge", { hasText: /^not tested$/ })).toBeVisible();
    await page.getByRole("button", { name: "Send a test mail to me" }).click();
    await expect(page.getByRole("alert")).toContainText("not configured");
    await expect(page.locator(".badge", { hasText: /^test failed$/ })).toBeVisible();
  });

  test("SMTP settings save with step-up and the password field is cleared", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    await page.goto("/#/integrations");
    // Native validation stops an empty form before any request is sent.
    await page.getByRole("button", { name: "Save SMTP settings" }).click();
    await expect(page.getByLabel("Host", { exact: true })).toBeFocused();
    await page.getByLabel("Host", { exact: true }).fill("smtp.example.test");
    await page.getByLabel("User").fill("mailer");
    await page.getByLabel("Password", { exact: true }).fill("s3cret");
    await page.getByLabel("From address").fill("harness@example.test");
    await page.getByLabel("Security").selectOption("tls");
    await page.getByLabel("Password", { exact: true }).press("Enter");
    await usePasskey(page);
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toContainText(
      "never shown again",
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  });

  test("one button saves the choice and starts it, public options need the box", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    // Nothing may really start a tunnel on the machine that runs the test.
    await page.route("**/api/tunnel/start", (route) =>
      route.fulfill({ status: 500, json: { error: "tailscale is not installed" } }),
    );
    await page.goto("/#/integrations");
    const tunnel = page.getByRole("region", { name: "Remote access (tunnel)" });
    const start = tunnel.getByRole("button", { name: "Start with Tailscale Serve" });
    // This machine may already name itself, which pre-fills the field.
    await tunnel.getByLabel("Hostname (required for Tailscale)").fill("");
    await expect(start).toBeDisabled();
    await tunnel.getByLabel("Hostname (required for Tailscale)").fill("not a host");
    await expect(start).toBeEnabled();
    await start.click();
    await page
      .getByRole("dialog", { name: "Confirm tunnel start" })
      .getByRole("button", { name: "Yes, start the tunnel" })
      .click();
    await usePasskey(page);
    await expect(tunnel.getByRole("alert")).toBeVisible();
    await tunnel.getByLabel("Hostname (required for Tailscale)").fill("box.tailnet.ts.net");
    await start.click();
    await page
      .getByRole("dialog", { name: "Confirm tunnel start" })
      .getByRole("button", { name: "Yes, start the tunnel" })
      .click();
    await expect(tunnel).toContainText(
      "Saved choice: Tailscale Serve at https://box.tailnet.ts.net.",
    );
    await expect(tunnel.getByRole("alert")).toContainText("tailscale is not installed");
    // Serve is tailnet only: no warning, no box.
    await expect(tunnel.getByText("Anyone who has the address")).toHaveCount(2);
    await expect(tunnel.getByLabel(/reachable from the internet/)).toHaveCount(0);

    await tunnel.getByLabel(/Cloudflare quick tunnel/).check();
    await expect(tunnel.getByLabel("Hostname (optional)")).toBeVisible();
    const cloudflare = tunnel.getByRole("button", { name: "Start with Cloudflare" });
    await expect(cloudflare).toBeDisabled();
    await tunnel.getByLabel(/reachable from the internet/).check();
    await expect(cloudflare).toBeEnabled();
    await cloudflare.click();
    const confirm = page.getByRole("dialog", { name: "Confirm tunnel start" });
    await expect(confirm).toContainText("This runs cloudflared");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
  });

  test("the keyboard reaches Start and the confirm dialog closes with Escape", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    await page.goto("/#/integrations");
    const tunnel = page.getByRole("region", { name: "Remote access (tunnel)" });
    await tunnel.getByLabel("Hostname (required for Tailscale)").fill("kbd.tailnet.ts.net");
    const start = tunnel.getByRole("button", { name: "Start with Tailscale Serve" });
    await start.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("dialog", { name: "Confirm tunnel start" });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
  });

  test("a failed Claude Desktop load shows the error", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await page.route("**/api/integrations/claude-desktop", (route) =>
      route.fulfill({ status: 500, json: { error: "config unreadable" } }),
    );
    await page.goto("/#/integrations");
    await expect(
      page.getByRole("region", { name: "Claude Desktop" }).getByRole("alert"),
    ).toContainText("config unreadable");
  });

  test("fits a 375px screen", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#/integrations");
    await expect(page.getByRole("heading", { name: "Claude Desktop" })).toBeVisible();
    await expect(page.locator(".badge", { hasText: /^stopped$/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (SHOTS)
      await page.screenshot({ path: `${SHOTS}/integrations-375-light.png`, fullPage: true });
  });
});
