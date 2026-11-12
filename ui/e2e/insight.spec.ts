import { expect, signIn, test } from "./fixtures";

const SHOTS = process.env.SHOTS_DIR;
const ACME = { name: "Acme Labs", slug: "acme" };

test.describe("dashboard", () => {
  test("shows the members, empty budgets and empty tasks of a new org", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Usage per member" })).toContainText("ada");
    await expect(page.getByText("No budgets set.")).toBeVisible();
    await expect(page.getByText("No tasks changed in this range.")).toBeVisible();
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/dashboard-1440-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/dashboard-1440-dark.png` });
    }
  });

  test("a budget shows its state word and a meter with its real limit", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    const orgId = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me");
      const body = (await res.json()) as { orgs: { id: string; slug: string }[] };
      return body.orgs.find((o) => o.slug === "acme")?.id ?? "";
    });
    stack.sql(
      "INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at) VALUES (?, ?, 'org', ?, 50, 'test', 1)",
      "b1",
      orgId,
      orgId,
    );
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByText("Whole org")).toBeVisible();
    await expect(page.locator(".badge", { hasText: /^ok$/ })).toBeVisible();
    const meter = page.getByRole("meter", { name: "$0.00 of $50.00" });
    await expect(meter).toHaveAttribute("aria-valuenow", "0");
  });

  test("the range select refetches, with the keyboard too", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    const since = (): Promise<string> =>
      page
        .waitForRequest((r) => r.url().includes("/dashboard?since="))
        .then((r) => new URL(r.url()).searchParams.get("since") ?? "");
    const first = since();
    await page.getByLabel("Range").selectOption("week");
    const weekSince = Number(await first);
    expect(Date.now() - weekSince).toBeGreaterThan(6.9 * 86_400_000);
    const second = since();
    await page.getByLabel("Range").focus();
    await expect(page.getByLabel("Range")).toBeFocused();
    await page.getByLabel("Range").selectOption("today");
    expect(Number(await second)).toBeGreaterThan(weekSince);
  });

  test("a failed load shows the error and Retry loads it", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    let broken = true;
    await page.route("**/api/orgs/acme/dashboard*", (route) => {
      if (!broken) return route.continue();
      return route.fulfill({ status: 500, json: { error: "database is locked" } });
    });
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByRole("alert")).toContainText("database is locked");
    broken = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  });

  test("an org the person is not in is not found", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/nope/dashboard");
    await expect(page.getByText("Org not found")).toBeVisible();
  });

  test("fits a 375px screen", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-375-light.png`, fullPage: true });
  });
});
