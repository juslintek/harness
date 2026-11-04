import { enroll, expect, test } from "./fixtures";

test("an unknown visitor lands on the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Harness" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Email me a code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with the code" })).toBeVisible();
});

test("a passkey signs in and shows the empty authenticated layout", async ({ page, stack }) => {
  const email = "ada@example.com";
  await enroll(page, stack.enrollmentCode(email, "Ada"), email, "Ada");
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText("Ada");
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
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
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
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
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
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
});
