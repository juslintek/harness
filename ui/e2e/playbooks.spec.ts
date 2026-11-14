import { expect, signIn, test } from "./fixtures";

const ACME = { name: "Acme Labs", slug: "acme" };
const ADMIN = { email: "ada@example.com", name: "Ada", admin: true, orgs: [ACME] };

test.describe("playbooks", () => {
  test("shows both groups, each card with its steps and a way on", async ({ page, stack }) => {
    await signIn(page, stack, ADMIN);
    await page.goto("/#/playbooks");
    await expect(page.getByText("Guidance, not live data").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run and monitor" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Kinds of work" })).toBeVisible();
    for (const title of [
      "Follow a run live",
      "Read the logs",
      "Approve or deny a command",
      "Keep spend under control",
      "Stop everything",
      "Ship a feature",
      "Fix a bug",
      "Review code",
      "Write docs",
      "Marketing",
    ]) {
      await expect(page.getByRole("heading", { name: title, level: 3 })).toBeVisible();
    }
    const follow = page.getByRole("article", { name: "Follow a run live" });
    await expect(follow).toContainText("An agent is working and you want to watch");
    await expect(follow.getByRole("listitem")).toHaveCount(4);
    // A page that claims live data would be a lie: the word live only describes one run.
    await expect(page.getByText("Harness measures")).toHaveCount(0);
  });

  test("a card button opens its screen", async ({ page, stack }) => {
    await signIn(page, stack, ADMIN);
    await page.goto("/#/playbooks");
    await page
      .getByRole("article", { name: "Read the logs" })
      .getByRole("link", { name: "Open Logs" })
      .click();
    await expect(page).toHaveURL(/#\/o\/[^/]+\/logs$/);
    await page.goto("/#/playbooks");
    await page
      .getByRole("article", { name: "Keep spend under control" })
      .getByRole("link", { name: "Open Policies" })
      .click();
    await expect(page).toHaveURL(/#\/o\/[^/]+\/policies$/);
  });

  test("the keyboard reaches a card action and Enter follows it", async ({ page, stack }) => {
    await signIn(page, stack, ADMIN);
    await page.goto("/#/playbooks");
    const link = page
      .getByRole("article", { name: "Approve or deny a command" })
      .getByRole("link", { name: "Open Approvals" });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/approvals$/);
  });

  test("links to screens a person cannot open are left out", async ({ page, stack }) => {
    await signIn(page, stack, { email: "bo@example.com", name: "Bo", orgs: [ACME] });
    await page.goto("/#/playbooks");
    await expect(page.getByRole("link", { name: "Open Runs" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open Policies" })).toBeVisible();
  });

  test("the Marketing playbook lists what works, what does not, and outside tools", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADMIN);
    await page.goto("/#/playbooks");
    await page.getByRole("link", { name: "Open Marketing playbook" }).click();
    await expect(page).toHaveURL(/#\/playbooks\/marketing$/);
    await expect(
      page.getByRole("heading", { name: "Marketing", level: 2, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Harness cannot publish, send or measure results")).toBeVisible();
    await expect(
      page.getByRole("region", { name: /^(Content and blog|SEO|Paid ads)$/ }),
    ).toHaveCount(3);
    const seo = page.getByRole("region", { name: "SEO" });
    await expect(seo.getByText("An agent can, today")).toBeVisible();
    await expect(seo.getByText("An agent cannot")).toBeVisible();
    await expect(seo.getByText("Google Search Console")).toBeVisible();
    // Every outside tool carries the marking: 7 kinds, 3 or 2 tools each, 20 in all.
    await expect(page.getByText("not connected to Harness")).toHaveCount(20);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Playbooks / Marketing");
    await page.getByRole("heading", { level: 1 }).getByRole("link", { name: "Playbooks" }).click();
    await expect(page).toHaveURL(/#\/playbooks$/);
  });

  test("hire and task links carry a prefill, the task one only with a single project", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADMIN);
    await page.goto("/#/playbooks/marketing");
    const hire = page.getByRole("link", { name: "Hire a writing agent" });
    await expect(hire).toHaveAttribute("href", /^#\/o\/[^/]+\/hiring\?specialty=writing$/);
    const slug = (await hire.getAttribute("href"))?.split("/")[2] ?? "";
    await expect(page.getByRole("link", { name: "Open Board to add it" })).toHaveCount(7);
    await page.evaluate(async (org) => {
      const res = await fetch(`/api/orgs/${org}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "MKT", name: "Marketing" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }, slug);
    await page.reload();
    const create = page.getByRole("link", { name: "Create task from this" });
    await expect(create).toHaveCount(7);
    await create.first().click();
    await expect(page.getByRole("dialog", { name: "New task" }).getByLabel("Title")).toHaveValue(
      "Draft a 900-word post: how we review agent commands",
    );
  });

  test("both views fit a 375px screen", async ({ page, stack }) => {
    await signIn(page, stack, ADMIN);
    await page.setViewportSize({ width: 375, height: 812 });
    for (const hash of ["#/playbooks", "#/playbooks/marketing"]) {
      await page.goto(`/${hash}`);
      await expect(page.getByText("Guidance, not live data").first()).toBeVisible();
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(fits, hash).toBe(true);
    }
  });
});
