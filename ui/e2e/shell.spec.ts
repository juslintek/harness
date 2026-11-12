import { enroll, expect, signIn, test } from "./fixtures";

test("an unknown visitor lands on the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
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
  for (const group of ["Work", "Oversight", "Organisation", "Instance"]) {
    await expect(nav.getByRole("list", { name: group })).toBeVisible();
  }
  await expect(nav.getByRole("link")).toHaveText([
    "Board",
    "Chat",
    "Memory",
    "Approvals",
    "Dashboard",
    "Logs",
    "Hiring",
    "Policies",
    "Settings",
    "Runs",
    "Agents",
    "Search",
    "Integrations",
    "Account",
  ]);
  // "#/" is the runs list for an instance admin.
  await expect(nav.getByRole("link", { name: "Runs", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await nav.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/#\/o\/personal\/board$/);
  await expect(nav.getByRole("link", { name: "Board", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link", { name: "Runs", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Board");
  await expect(page.getByRole("main").getByText("No projects yet")).toBeVisible();
  await expect(nav.getByRole("button", { name: /Personal/ })).toContainText("owner");
});

test("an unknown route shows the board of the selected organisation", async ({ page, stack }) => {
  await signIn(page, stack, { email: "lost@example.com", name: "Lost", admin: true });
  await page.goto("/#/no-such-page");
  await expect(page.getByRole("main").getByText("No projects yet")).toBeVisible();
});

test("an organisation owner has no halt switch and no instance pages", async ({ page, stack }) => {
  await signIn(page, stack, { email: "owner@example.com", name: "Owner" });
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Board", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("list", { name: "Instance" })).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
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

test("the halt switch asks, needs a passkey, and follows the server", async ({ page, stack }) => {
  await signIn(page, stack, { email: "halt@example.com", name: "Halt", admin: true });
  const halt = page.getByRole("switch", { name: "Halt all agent runs" });
  await expect(halt).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Agents running")).toBeVisible();

  // Cancelling the passkey prompt rejects the call and the switch stays where the server is.
  await halt.click();
  await page.getByRole("button", { name: "Halt", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("POST /api/halt");
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passkey check cancelled.");
  await expect(halt).toHaveAttribute("aria-checked", "false");

  await halt.click();
  await page.getByRole("button", { name: "Halt", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Confirm it's you" })
    .getByRole("button", { name: "Use passkey" })
    .click();
  await expect(halt).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("group", { name: "Halt all agent runs" })).toContainText("Halted");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The server remembers it, so a reload shows the same.
  await page.reload();
  await expect(halt).toHaveAttribute("aria-checked", "true");
  await halt.click();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(halt).toHaveAttribute("aria-checked", "false");
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
  // The halt switch stays in the bar at every width, with the short label.
  await expect(page.getByRole("switch", { name: "Halt all agent runs" })).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();

  await open.click();
  await expect(nav).toBeVisible();
  await expect(open).toHaveAttribute("aria-expanded", "true");
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

test("the keyboard reaches the skip link, the nav and the halt switch in that order", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "keys@example.com", name: "Keys", admin: true });
  const seen: string[] = [];
  for (let i = 0; i < 30 && !seen.includes("Halt all agent runs"); i++) {
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
  expect(seen.indexOf("Board")).toBeLessThan(seen.indexOf("Halt all agent runs"));
  expect(seen.at(-1)).toBe("Halt all agent runs");
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#content")).toBeFocused();
  await expect(page).toHaveURL(/#\/$/);
});
