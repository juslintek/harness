import { enroll, expect, signIn, test } from "./fixtures";

test("an unknown visitor lands on the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Use an email code instead" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a recovery code" })).toBeVisible();
});

test("a passkey signs in and shows the empty authenticated layout", async ({ page, stack }) => {
  const email = "ada@example.com";
  await enroll(page, stack.enrollmentCode(email, "Ada"), email, "Ada");
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(email);
});

test("opening the root unauthenticated, then signing in, shows the layout", async ({
  page,
  stack,
}) => {
  const email = "edsger@example.com";
  await enroll(page, stack.enrollmentCode(email, "Edsger"), email, "Edsger");
  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(email);
  await expect(page.getByText(/Cannot load your account/)).toHaveCount(0);
});

test("a failed account load after sign-in offers a retry", async ({ page, stack }) => {
  const email = "barbara@example.com";
  await enroll(page, stack.enrollmentCode(email, "Barbara"), email, "Barbara");
  await page.goto("/#/login");
  let failed = false;
  await page.route("**/api/auth/me", (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.abort();
  });
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByText(/Cannot load your account/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(email);
});

test("a fresh enrollment link registers a passkey and signs in", async ({ page, stack }) => {
  const email = "grace@example.com";
  await page.goto(`/#/enroll/${stack.enrollmentCode(email, "Grace")}`);
  await page.getByLabel("Your name").fill("Grace");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Register a passkey" }).click();
  await expect(page.getByRole("heading", { name: "You are enrolled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel("I saved them").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(email);
});

test("an instance admin sees the grouped nav, and the current page is marked", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, {
    email: "admin@example.com",
    name: "Admin",
    admin: true,
  });
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const group of ["Now", "Work", "Monitor", "Reports", "Organisation", "Guides", "Instance"]) {
    await expect(nav.getByRole("list", { name: group })).toBeVisible();
  }
  await expect(nav.getByRole("link")).toHaveText([
    "Now",
    "Board",
    "Chat",
    "Memory",
    "Approvals",
    "Runs",
    "Logs",
    "Usage & budgets",
    "Hiring",
    "Policies",
    "Settings",
    "Playbooks",
    "Agent CLIs",
    "Integrations",
    "Search",
    "Account",
  ]);
  // "#/" is Now for everyone.
  await expect(nav.getByRole("link", { name: "Now", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Now");
  await nav.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/#\/o\/personal\/board$/);
  await expect(nav.getByRole("link", { name: "Board", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link", { name: "Now", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Board");
  await expect(page.getByRole("main").getByText("No projects yet")).toBeVisible();
  await expect(nav.getByRole("button", { name: /Personal/ })).toContainText("owner");
});

test("a pending approval puts a warning count on Approvals", async ({ page, stack }) => {
  await signIn(page, stack, { email: "count@example.com", name: "Count", admin: true });
  const approvals = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Approvals" });
  await expect(approvals).toHaveText("Approvals");
  stack.sql(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES ('ap_1', 'run_1', 'push', 'ask', 'pending', ?, ?)",
    Date.now(),
    Date.now() + 600_000,
  );
  await page.reload();
  await expect(approvals).toHaveText("Approvals1 waiting");
});

test("an unknown route shows Now", async ({ page, stack }) => {
  await signIn(page, stack, { email: "lost@example.com", name: "Lost", admin: true });
  await page.goto("/#/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Now");
});

test("an organisation owner has no stop button and no instance pages", async ({ page, stack }) => {
  await signIn(page, stack, { email: "owner@example.com", name: "Owner" });
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Now", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("list", { name: "Instance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop all agents" })).toHaveCount(0);
});

test("switching organisation keeps the section and remembers the pick", async ({ page, stack }) => {
  await signIn(page, stack, {
    email: "multi@example.com",
    name: "Multi",
    orgs: [{ name: "Northwind", slug: "northwind" }],
  });
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Hiring", exact: true }).click();
  await expect(page).toHaveURL(/#\/o\/personal\/hiring$/);
  await nav.getByRole("button", { name: /Personal/ }).click();
  await page.getByRole("menuitem", { name: /Northwind/ }).click();
  await expect(page).toHaveURL(/#\/o\/northwind\/hiring$/);
  await page.goto("/#/");
  await expect(nav.getByRole("link", { name: "Board", exact: true })).toHaveAttribute(
    "href",
    "#/o/northwind/board",
  );
});

test("stopping agents asks, needs a passkey, shows a banner, and follows the server", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "halt@example.com", name: "Halt", admin: true });
  const stop = page.getByRole("button", { name: "Stop all agents" });
  const banner = page.getByText("All agents are stopped");
  await expect(page.getByText("Agents running")).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);

  // Cancelling the passkey prompt rejects the call and the state stays where the server is.
  await stop.click();
  const confirm = page.getByRole("dialog", { name: "Stop all agents?" });
  await expect(confirm).toContainText("Every running run is stopped now");
  await confirm.getByRole("button", { name: "Stop all agents" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("POST /api/halt");
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passkey check cancelled.");
  await expect(page.getByText("Agents running")).toBeVisible();
  await expect(banner).toHaveCount(0);

  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop all agents?" })
    .getByRole("button", { name: "Stop all agents" })
    .click();
  await page
    .getByRole("dialog", { name: "Confirm it's you" })
    .getByRole("button", { name: "Use passkey" })
    .click();
  await expect(page.getByText("Agents stopped")).toBeVisible();
  await expect(banner).toBeVisible();
  await expect(
    page.getByText("No run will start until an instance admin resumes them."),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The server remembers it, so a reload shows the same, on every page.
  await page.reload();
  await expect(banner).toBeVisible();
  await page.goto("/#/o/personal/board");
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Resume agents" }).click();
  await expect(page.getByText("Agents running")).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("on a phone the nav is a drawer and the page does not scroll sideways", async ({
  page,
  stack,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, stack, {
    email: "phone@example.com",
    name: "Phone",
    admin: true,
  });
  const open = page.getByRole("button", { name: "Open navigation" });
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeHidden();
  await expect(open).toHaveAttribute("aria-expanded", "false");
  // The bar keeps only the dot and the short word; the button waits in the drawer.
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop all agents" })).toBeHidden();
  await expect(page.getByText("Live", { exact: true })).toBeHidden();

  await open.click();
  await expect(nav).toBeVisible();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("button", { name: "Stop all agents" })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(open).toBeFocused();

  await open.click();
  await page.mouse.click(360, 400);
  await expect(nav).toBeHidden();

  await open.click();
  await nav.getByRole("link", { name: "Board", exact: true }).click();
  await expect(nav).toBeHidden();
  await expect(page).toHaveURL(/#\/o\/personal\/board$/);
  await expect(open).toBeFocused();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("the keyboard reaches the skip link, the nav and the stop button in that order", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "keys@example.com", name: "Keys", admin: true });
  const seen: string[] = [];
  for (let i = 0; i < 30 && !seen.includes("Stop all agents"); i++) {
    await page.keyboard.press("Tab");
    seen.push(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.textContent?.trim() ??
          "",
      ),
    );
  }
  expect(seen[0]).toBe("Skip to content");
  expect(seen.indexOf("Board")).toBeGreaterThan(0);
  expect(seen.indexOf("Board")).toBeLessThan(seen.indexOf("Stop all agents"));
  expect(seen.at(-1)).toBe("Stop all agents");
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#content")).toBeFocused();
  await expect(page).toHaveURL(/#\/$/);
});
