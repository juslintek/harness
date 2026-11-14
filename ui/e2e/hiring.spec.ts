import { expect as baseExpect, type Page } from "@playwright/test";
import { enroll, expect, signIn, test } from "./fixtures";
import { seedHires } from "./hiring-seed";

const usePasskey = (page: Page) => page.getByRole("button", { name: "Use passkey" }).click();

const ADMIN = {
  email: "ada@acme.example",
  name: "Ada",
  admin: true,
  orgs: [{ name: "Acme Labs", slug: "acme" }],
};

test("the list shows each request with its status word and opens the detail", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await seedHires(page, stack);
  await page.goto("/#/o/acme/hiring");
  await expect(page.getByRole("heading", { name: "Requests", level: 2 })).toBeVisible();
  const row = (title: string) => page.getByRole("row").filter({ hasText: title });
  await expect(row("Backend engineer")).toContainText("scoring");
  await expect(row("Backend engineer")).toContainText("Scoring, step 3 of 5");
  await expect(row("Release reviewer")).toContainText("needs your decision");
  await expect(row("Release reviewer")).toContainText("Decision, step 4 of 5");
  await expect(row("Release reviewer").getByRole("link", { name: "Decide" })).toBeVisible();
  await expect(row("Mobile engineer")).toContainText("hired");
  await expect(row("Mobile engineer")).toContainText("Closed");
  await expect(row("Backend engineer")).toContainText("Platform");
  await expect(page.getByText(/^Updated \d+ s ago/)).toBeVisible();
  await expect(page.getByText("How hiring works")).toBeVisible();

  // Waiting for you first, then open requests, then closed ones.
  const titles = await page.locator("tbody td:first-child a").allTextContents();
  expect(titles.indexOf("Release reviewer")).toBe(0);
  expect(titles.indexOf("Backend engineer")).toBeLessThan(titles.indexOf("Mobile engineer"));
  await expect(page.getByText("2 requests need your decision")).toBeVisible();
  await page.getByRole("button", { name: "New hire" }).click();
  await expect(page.getByRole("button", { name: "File request" })).toBeVisible();

  await page.getByRole("link", { name: "Backend engineer" }).click();
  await expect(page).toHaveURL(/#\/o\/acme\/hiring\/hr-scoring$/);
  await expect(page.locator(".hiring-title", { hasText: "Backend engineer" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Hiring steps" })).toContainText("Scoring");
  await expect(page.locator(".step[aria-current='step']")).toHaveText("3Scoring");
  await expect(page.getByText("Now, scoring.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Candidates side by side" })).toBeVisible();
  await page.getByRole("link", { name: "Back to requests" }).click();
  await expect(page).toHaveURL(/#\/o\/acme\/hiring$/);
});

test("an empty org says there are no requests", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/hiring");
  await expect(page.getByText("No hiring requests yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "File request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New hire" })).toHaveCount(0);
});

test("a request the server refuses shows its error and keeps the form", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.evaluate(async () => {
    await fetch("/api/orgs/acme/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Platform" }),
    });
  });
  await page.goto("/#/o/acme/hiring");
  await page.getByLabel("Role title").fill("Backend engineer");
  await page.getByLabel("What the role does").fill("Owns the job queue.");
  await page.getByLabel("Must-haves, one per line, up to 6").fill(`Postgres\n${"x".repeat(81)}`);
  await page.getByRole("button", { name: "File request" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Role title")).toHaveValue("Backend engineer");
});

test("keyboard: Enter in the title field files the request", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.evaluate(async () => {
    await fetch("/api/orgs/acme/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Platform" }),
    });
  });
  await page.goto("/#/o/acme/hiring");
  await page.getByLabel("What the role does").fill("Owns the job queue.");
  // An 81 character line is over the server's limit, so nothing real is filed or interviewed.
  await page.getByLabel("Must-haves, one per line, up to 6").fill("x".repeat(81));
  await page.getByLabel("Role title").focus();
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/orgs/acme/hires"),
  );
  await page.keyboard.type("Backend engineer");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON();
  expect(body.spec.title).toBe("Backend engineer");
  expect(body.spec.taskTypes).toEqual(["feature"]);
  expect(body.maxCandidates).toBe(2);
});

test("task types stop at four and at least one is required", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.evaluate(async () => {
    await fetch("/api/orgs/acme/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Platform" }),
    });
  });
  await page.goto("/#/o/acme/hiring");
  for (const t of ["bugfix", "refactor", "test"]) await page.getByLabel(t, { exact: true }).check();
  await expect(page.getByLabel("docs", { exact: true })).toBeDisabled();
  await page.getByLabel("feature", { exact: true }).uncheck();
  await page.getByLabel("bugfix", { exact: true }).uncheck();
  await page.getByLabel("refactor", { exact: true }).uncheck();
  await page.getByLabel("test", { exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "File request" })).toBeDisabled();
});

test("an admin scores a candidate while the request is scoring", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const seeded = await seedHires(page, stack);
  await page.goto(`/#/o/acme/hiring/${seeded.ids.scoring}`);
  await expect(page.getByText("The retry policy.")).toBeVisible();
  await expect(page.getByText("no answer yet")).toBeVisible();
  await expect(page.getByText("No self card submitted.")).toBeVisible();
  await expect(page.getByText(/fit 4, depth 3, honesty 5/)).toContainText("clear about limits");
  await expect(page.getByText(/fit 4, depth 3, honesty 5/)).toContainText(/^@/);
  await expect(page.getByRole("button", { name: "Decision" })).toHaveCount(0);

  const first = page.getByRole("region", { name: "claude / opus" });
  const save = first.getByRole("button", { name: "Save scorecard" });
  // No score is pre-filled, so nothing can be saved until all three are picked.
  await expect(first.getByLabel("fit (1 to 5)")).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(first.getByText("Pick a score for fit, depth and honesty to save.")).toBeVisible();
  await first.getByLabel("fit (1 to 5)").selectOption("5");
  await first.getByLabel("depth (1 to 5)").selectOption("2");
  await expect(save).toBeDisabled();
  await first.getByLabel("honesty (1 to 5)").selectOption("3");
  await expect(save).toBeEnabled();
  await first.getByLabel("Notes (optional)").fill("Strong on queues");
  await save.click();
  await expect(first.getByText(/fit 5, depth 2, honesty 3/)).toContainText("Strong on queues");
});

test("deciding asks for a passkey and hires the chosen candidate", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const seeded = await seedHires(page, stack);
  await page.goto(`/#/o/acme/hiring/${seeded.ids.deciding}`);
  await expect(page.getByRole("button", { name: "Save scorecard" })).toHaveCount(0);
  await expect(page.getByText("If you hire a candidate")).toBeVisible();
  await expect(page.getByText(/^Joins\. team Platform as a member/)).toBeVisible();
  await expect(page.getByText("Autonomy. full (default)")).toBeVisible();
  await page.getByLabel("Reason (optional, shown on the request)").fill("Best answers");
  await page.getByRole("button", { name: "Hire claude / sonnet" }).click();
  await usePasskey(page);
  await expect(page.getByText(/Reason: Best answers/)).toBeVisible();
  await expect(page.locator(".hiring-title")).toContainText("hired");
  await expect(page.getByText("Request closed.")).toBeVisible();
  await expect(page.getByRole("link", { name: "See its rules in Policies" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Hire / })).toHaveCount(0);
});

test("reject all asks first, then rejects", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const seeded = await seedHires(page, stack);
  await page.goto(`/#/o/acme/hiring/${seeded.ids.rejecting}`);
  await page.getByRole("button", { name: "Reject all candidates" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".hiring-title")).toContainText("needs your decision");

  await page.getByRole("button", { name: "Reject all candidates" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject all candidates" }).click();
  await usePasskey(page);
  await expect(page.locator(".hiring-title")).toContainText("rejected");
  await expect(page.getByText("Request closed, nobody hired")).toBeVisible();
});

test("an unknown request shows the server's error", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/hiring/nope");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to requests" })).toBeVisible();
});

test("a viewer sees requests but no form and no scoring or decision", async ({
  page,
  stack,
  browser,
}) => {
  await signIn(page, stack, ADMIN);
  const seeded = await seedHires(page, stack);
  const link = await page.evaluate(async () => {
    const res = await fetch("/api/orgs/acme/members/humans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "view@acme.example", role: "viewer" }),
    });
    return ((await res.json()) as { enrollmentLink: string }).enrollmentLink;
  });
  const code = link.split("/#/enroll/")[1] as string;

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
  await other.goto("/#/o/acme/hiring");
  await baseExpect(other.getByRole("link", { name: "Backend engineer" })).toBeVisible();
  await baseExpect(other.getByRole("button", { name: "File request" })).toHaveCount(0);
  await other.goto(`/#/o/acme/hiring/${seeded.ids.scoring}`);
  await baseExpect(other.getByText("The retry policy.")).toBeVisible();
  await baseExpect(other.getByRole("button", { name: "Save scorecard" })).toHaveCount(0);
  await other.goto(`/#/o/acme/hiring/${seeded.ids.deciding}`);
  await baseExpect(other.locator(".hiring-title")).toContainText("needs your decision");
  await baseExpect(other.getByRole("button", { name: "Reject all candidates" })).toHaveCount(0);
  await context.close();
});

test("an unknown org says so", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/nope/hiring");
  await expect(page.getByText("Org not found")).toBeVisible();
});

test("no horizontal page scroll at phone width", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const seeded = await seedHires(page, stack);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const route of [
    "/#/o/acme/hiring",
    `/#/o/acme/hiring/${seeded.ids.scoring}`,
    `/#/o/acme/hiring/${seeded.ids.deciding}`,
  ]) {
    await page.goto(route);
    await page.reload();
    await expect(page.locator(".hiring-title, .panel-title").first()).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    const small = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>(".hiring .btn")].filter(
          (b) => b.offsetParent !== null && b.getBoundingClientRect().height < 32,
        ).length,
    );
    expect(small).toBe(0);
  }
});

test("a deep link opens the form with the specialty chosen, and ignores a bad one", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await seedHires(page, stack);
  await page.goto("/#/o/acme/hiring?specialty=writing");
  await expect(page.getByLabel("Specialty")).toHaveValue("writing");
  await page.goto("/#/o/acme/hiring?specialty=nonsense");
  await page.reload();
  await expect(page.getByRole("button", { name: "New hire" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
