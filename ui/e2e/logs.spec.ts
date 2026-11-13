import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";
import type { Stack } from "./stack";

const SHOTS = process.env.SHOTS_DIR;
const ACME = { name: "Acme Labs", slug: "acme" };
const NOW = 1_800_000_000_000;

async function orgId(page: Page, slug: string): Promise<string> {
  return page.evaluate(async (s) => {
    const res = await fetch("/api/auth/me");
    const body = (await res.json()) as { orgs: { id: string; slug: string }[] };
    return body.orgs.find((o) => o.slug === s)?.id ?? "";
  }, slug);
}

// One run of ada's with `count` events whose bodies all contain "deploy". No project, so only an
// org admin or owner can see them, which is what ada is.
function seedEvents(stack: Stack, org: string, count: number): void {
  stack.sql(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, org_id, member_id) VALUES ('run-logs', 'a', 'r', 'p', 'done', 1, ?, (SELECT id FROM members WHERE org_id = ? AND handle = 'ada'))",
    org,
    org,
  );
  stack.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
     INSERT INTO events (id, ts, run_id, kind) SELECT 'ev-' || i, ${NOW} + i * 1000, 'run-logs', CASE WHEN i = 1 THEN 'error' ELSE 'tool_call' END FROM n`,
  );
  stack.sql(
    "INSERT INTO pending_payloads (event_rowid, run_id, body) SELECT rowid, run_id, 'deploy step ' || substr(id, 4) FROM events",
  );
  stack.sql("INSERT INTO events_fts (rowid, body) SELECT rowid, body FROM pending_payloads");
}

async function search(page: Page, q: string): Promise<void> {
  await page.getByRole("searchbox", { name: "Search events" }).fill(q);
  await page.getByRole("button", { name: "Search logs" }).click();
}

test.describe("logs", () => {
  test("a search lists the matching events, filters by kind and pages with Older", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", admin: true, orgs: [ACME] });
    seedEvents(stack, await orgId(page, "acme"), 55);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/#/o/acme/logs");
    await expect(page.getByRole("list", { name: "Suggested searches" })).toBeVisible();
    await search(page, "deploy");
    const rows = page.getByRole("region", { name: "Log events" }).locator("tbody tr");
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText("deploy step 55");
    await expect(rows.first()).toContainText("ada");
    await expect(rows.first().getByRole("link", { name: "run-logs" })).toHaveAttribute(
      "href",
      "#/runs/run-logs",
    );
    await expect(page.getByText('50 events for "deploy", newest first')).toBeVisible();
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/logs-1440-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/logs-1440-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.getByRole("button", { name: "Older" }).click();
    await expect(rows).toHaveCount(55);
    await expect(page.getByRole("button", { name: "Older" })).toHaveCount(0);
    await page.getByLabel("Kind").selectOption("error");
    await page.getByRole("button", { name: "Search logs" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(".badge")).toHaveText("error");
    await expect(rows.first().locator(".badge")).toHaveAttribute("data-tone", "danger");
  });

  test("a task's event links to its board card, and the Member filter narrows to one member", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", admin: true, orgs: [ACME] });
    const org = await orgId(page, "acme");
    const { projectId, taskId } = await page.evaluate(async () => {
      const post = async (path: string, body: object) =>
        (await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json())) as { id: string };
      const project = await post("/api/orgs/acme/projects", { key: "LOG", name: "Logs" });
      const task = await post(`/api/projects/${project.id}/tasks`, { title: "Ship it" });
      return { projectId: project.id, taskId: task.id };
    });
    seedEvents(stack, org, 2);
    stack.sql(
      "INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('m-bot', ?, 'agent', 'bot-agent', 'bot', 'Bot', 'member', 1)",
      org,
    );
    stack.sql(
      "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, org_id, member_id, task_id) VALUES ('run-bot', 'a', 'r', 'p', 'done', 1, ?, 'm-bot', ?)",
      org,
      taskId,
    );
    stack.sql(
      "INSERT INTO events (id, ts, run_id, kind) VALUES ('ev-bot', ?, 'run-bot', 'tool_call')",
      NOW,
    );
    stack.sql(
      "INSERT INTO pending_payloads (event_rowid, run_id, body) SELECT rowid, run_id, 'deploy by bot' FROM events WHERE id = 'ev-bot'",
    );
    stack.sql(
      "INSERT INTO events_fts (rowid, body) SELECT rowid, body FROM pending_payloads WHERE run_id = 'run-bot'",
    );
    await page.goto("/#/o/acme/logs");
    await search(page, "deploy");
    const rows = page.getByRole("region", { name: "Log events" }).locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "bot" }).getByRole("link", { name: "#1" })).toHaveAttribute(
      "href",
      `#/o/acme/board/${projectId}/1`,
    );
    await page.getByLabel("Member").selectOption({ label: "bot" });
    await page.getByRole("button", { name: "Search logs" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("deploy by bot");
    await page.getByLabel("Member").selectOption({ label: "ada" });
    await page.getByRole("button", { name: "Search logs" }).click();
    await expect(rows).toHaveCount(2);
  });

  test("no match shows the empty message", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/acme/logs");
    await search(page, "nothing");
    await expect(page.getByRole("heading", { name: 'No events match "nothing"' })).toBeVisible();
  });

  test("the search works from the keyboard", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    seedEvents(stack, await orgId(page, "acme"), 3);
    await page.goto("/#/o/acme/logs");
    await page.getByRole("searchbox", { name: "Search events" }).focus();
    await page.keyboard.type("deploy");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Log events" }).locator("tbody tr")).toHaveCount(
      3,
    );
  });

  test("a server refusal is shown as the error", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    const id = await orgId(page, "acme");
    await page.goto("/#/o/acme/logs");
    await expect(page.getByRole("searchbox", { name: "Search events" })).toBeVisible();
    // The page still thinks ada is an owner; the server now says 403.
    stack.sql("UPDATE members SET role = 'viewer' WHERE org_id = ? AND handle = 'ada'", id);
    await search(page, "deploy");
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("a viewer gets the not-available message instead of the form", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    stack.sql(
      "UPDATE members SET role = 'viewer' WHERE org_id = ? AND handle = 'ada'",
      await orgId(page, "acme"),
    );
    await page.goto("/#/o/acme/logs");
    await page.reload();
    await expect(page.getByText("Logs are not available for viewers.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search logs" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Logs" })).toHaveCount(0);
  });

  test("an org the person is not in is not found", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/nope/logs");
    await expect(page.getByText("Org not found")).toBeVisible();
  });

  test("fits a 375px screen", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    seedEvents(stack, await orgId(page, "acme"), 5);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#/o/acme/logs");
    await search(page, "deploy");
    await expect(page.getByRole("region", { name: "Log events" })).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    await expect(page.getByRole("columnheader", { name: "Kind" })).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/logs-375-light.png` });
  });

  test("a suggested search fills the field and runs, an empty query is never sent", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", admin: true, orgs: [ACME] });
    seedEvents(stack, await orgId(page, "acme"), 3);
    let sent = 0;
    await page.route("**/logs/search*", (route) => {
      sent += 1;
      return route.continue();
    });
    await page.goto("/#/o/acme/logs");
    await page.getByRole("button", { name: "Search logs" }).click();
    await page.getByRole("searchbox", { name: "Search events" }).fill("   ");
    await page.getByRole("searchbox", { name: "Search events" }).press("Enter");
    expect(sent).toBe(0);
    await page
      .getByRole("list", { name: "Suggested searches" })
      .getByRole("button", { name: "deploy" })
      .click();
    await expect(page.getByRole("searchbox", { name: "Search events" })).toHaveValue("deploy");
    await expect(page.getByRole("region", { name: "Log events" }).locator("tbody tr")).toHaveCount(
      3,
    );
    expect(sent).toBe(1);
    await page.getByRole("button", { name: "Search logs" }).click();
    await expect.poll(() => sent).toBe(2);
  });

  test("a search with no match explains what matches and offers chips", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/acme/logs");
    await search(page, "nothing");
    await expect(page.getByText(/with 3 or more characters/)).toBeVisible();
    await expect(page.getByRole("list", { name: "Suggested searches" })).toBeVisible();
  });

  test("the live panel lists running runs for an admin, with a link to follow each", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", admin: true, orgs: [ACME] });
    const org = await orgId(page, "acme");
    await page.goto("/#/o/acme/logs");
    await expect(page.getByRole("heading", { name: /Want to watch live/ })).toBeVisible();
    await expect(page.getByText("No run is running now.")).toBeVisible();
    stack.sql(
      "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, org_id, member_id) VALUES ('run-live', 'a', 'r', 'fix the build', 'running', 1, ?, (SELECT id FROM members WHERE org_id = ? AND handle = 'ada'))",
      org,
      org,
    );
    await page.reload();
    await expect(
      page.getByRole("list", { name: "Running runs" }).getByRole("link", { name: "Follow live" }),
    ).toHaveAttribute("href", "#/runs/run-live");
    await expect(page.getByRole("heading", { name: /Live tail/i })).toHaveCount(0);
  });

  test("a non-admin sees the live help line without the run list", async ({ page, stack }) => {
    await signIn(page, stack, { email: "ada@example.com", name: "Ada", orgs: [ACME] });
    await page.goto("/#/o/acme/logs");
    await expect(page.getByRole("heading", { name: /Want to watch live/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Running runs" })).toHaveCount(0);
    await expect(page.getByText("No run is running now.")).toHaveCount(0);
  });
});
