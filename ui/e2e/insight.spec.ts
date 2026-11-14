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
    await expect(page.locator(".dashboard-stack").getByText("Acme Labs")).toBeVisible();
    await expect(page.locator(".badge", { hasText: /^ok$/ })).toBeVisible();
    const meter = page.getByRole("meter", { name: "$0.00 of $50.00 (USD)" });
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
    await expect(page.getByRole("columnheader", { name: "Cost (USD)" })).toBeHidden();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-375-light.png`, fullPage: true });
  });

  test("budgets sort paused first, the top line is danger and links to Policies", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    const orgId = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me");
      const body = (await res.json()) as { orgs: { id: string; slug: string }[] };
      return body.orgs.find((o) => o.slug === "acme")?.id ?? "";
    });
    stack.sql(
      "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, org_id, member_id) VALUES ('run-spend', 'a', 'r', 'p', 'done', 1, ?, (SELECT id FROM members WHERE org_id = ? AND handle = 'ada'))",
      orgId,
      orgId,
    );
    stack.sql(
      "INSERT INTO events (id, ts, run_id, kind, reported_cost_usd) VALUES ('ev-spend', ?, 'run-spend', 'usage', 12)",
      Date.now(),
    );
    stack.sql(
      "INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at) VALUES ('b-org', ?, 'org', ?, 100, 'test', 1)",
      orgId,
      orgId,
    );
    stack.sql(
      "INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at) SELECT 'b-ada', ?, 'member', id, 10, 'test', 1 FROM members WHERE org_id = ? AND handle = 'ada'",
      orgId,
      orgId,
    );
    await page.goto("/#/o/acme/dashboard");
    const notice = page.getByRole("alert").first();
    await expect(notice).toContainText("Spend is not ok: ada is paused");
    await expect(notice.getByRole("link", { name: "Change ada's limit" })).toHaveAttribute(
      "href",
      "#/o/acme/policies",
    );
    const rows = page.locator(".dashboard-stack").first().locator("> li");
    await expect(rows.first()).toContainText("ada");
    await expect(rows.first().locator(".badge")).toHaveText("paused");
    await expect(rows.first()).toContainText("$12.00 of $10.00 (USD)");
    await expect(rows.first()).toContainText("120% this month");
    await expect(rows.first()).toContainText("new wake-ups are skipped");
    await expect(rows.first().getByRole("link", { name: "Change limit" })).toBeVisible();
    await expect(rows.nth(1).locator(".badge")).toHaveText("ok");
    await expect(rows.nth(1).getByRole("link", { name: "Change limit" })).toHaveCount(0);
  });

  test("quota rows read the window, a null reading says so, and 80% warns", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    const insert = (id: string, provider: string, window: string, pct: string): void =>
      stack.sql(
        `INSERT INTO quota_snapshots (id, provider, window, used_percent, resets_at, source, ts) VALUES ('${id}', '${provider}', '${window}', ${pct}, ${Date.now() + 3_600_000}, 'session log', ${Date.now()})`,
      );
    insert("q1", "claude", "5-hour", "85");
    insert("q2", "codex", "weekly", "NULL");
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByText("A quota is nearly used")).toBeVisible();
    await expect(page.getByText("85% of the window used")).toBeVisible();
    await expect(page.getByText("Source: session log").first()).toBeVisible();
    await expect(page.getByText("No reading yet").first()).toBeVisible();
  });

  test("a new org says spend is ok, and the tables carry units in their headers", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/acme/dashboard");
    await expect(page.getByText("Spend is ok")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Cost (USD)" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Active (min)" })).toBeVisible();
    await expect(page.getByText(/Active: time an agent worked/)).toBeVisible();
    await expect(page.getByText(/The range changes only the two tables below/)).toBeVisible();
  });
});
