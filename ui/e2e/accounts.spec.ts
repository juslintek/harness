import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const ADA = { email: "ada@example.com", name: "Ada", admin: true };
const SHOTS_DIR = resolve(import.meta.dirname, "../../screenshots");
const FAKE_BIN = resolve(import.meta.dirname, "../../code/src/server/test-support/fake-bin");

const savedPath = process.env.PATH;
let staleDir = "";
test.beforeAll(() => {
  process.env.PATH = `${FAKE_BIN}:${savedPath ?? ""}`;
  staleDir = mkdtempSync(join(tmpdir(), "harness-e2e-stale-"));
});
test.afterAll(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (staleDir) rmSync(staleDir, { recursive: true, force: true });
});

async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  const btn = dialog.getByRole("button", { name: "Use passkey" });
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
}

test.describe("multi-account management and pool panel", () => {
  test("admin inspects pool health, quota ages, unknown quota, and exercises keyboard add/disable/remove", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    const now = Date.now();
    const staleHome = join(staleDir, "codex-stale");
    stack.sql(
      `INSERT INTO agent_accounts
         (id, runtime, kind, label, home, state, identity_hint, max_concurrent, priority, created_at, updated_at)
       VALUES ('acct-work', 'codex', 'login', 'work', '/tmp/codex-work', 'active', 'ChatGPT Plus', 1, 0, 1, 1),
              ('acct-backup', 'codex', 'login', 'backup', '/tmp/codex-backup', 'active', 'ChatGPT Team', 1, 1, 2, 2),
              ('acct-stale', 'codex', 'login', 'stale', ?, 'logged_out', NULL, 1, 2, 3, 3),
              ('default:claude', 'claude', 'login', 'default', NULL, 'unknown', NULL, 2, 0, 1, 1)`,
      staleHome,
    );
    stack.sql(
      `INSERT INTO quota_snapshots (id, provider, account_id, window, used_percent, resets_at, source, ts)
       VALUES ('q-work', 'codex', 'acct-work', 'primary', 65, ?, 'probe', ?),
              ('q-backup', 'codex', 'acct-backup', 'primary', 20, ?, 'probe', ?)`,
      now + 3_600_000,
      now - 4 * 60_000,
      now + 3_600_000,
      now - 2 * 60_000,
    );
    stack.sql(
      `INSERT INTO route_decisions (id, run_id, ts, policy, candidates_json, chosen_account)
       VALUES ('dec-1', NULL, ?, 'spread', '{"total":2,"candidates":[{"account":"acct-backup","runtime":"codex","model":null,"score":0.9,"rejectedBy":null}]}', 'acct-backup')`,
      now,
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#/agents");

    const pool = page.getByRole("region", { name: "Account pool health" });
    await expect(pool).toBeVisible();
    await expect(pool.getByText("2 / 3")).toBeVisible();
    await expect(pool.getByText("backup", { exact: true })).toBeVisible();
    await expect(pool.getByText("Recent route decisions (1)")).toBeVisible();

    const codexPanel = page.getByRole("region", { name: "codex accounts" });
    await expect(codexPanel).toBeVisible();
    await expect(codexPanel.getByText("ChatGPT Plus")).toBeVisible();
    await expect(codexPanel.getByText(/65% \(4m ago\)/)).toBeVisible();
    await expect(codexPanel.getByText(/20% \(2m ago\)/)).toBeVisible();

    const claudePanel = page.getByRole("region", { name: "claude accounts" });
    await expect(claudePanel.getByText("unknown", { exact: true }).first()).toBeVisible();

    if (process.env.CAPTURE_MULTI_ACCOUNT_SHOTS === "1") {
      await page.screenshot({ path: resolve(SHOTS_DIR, "multi-account-1280.png"), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(pool).toBeVisible();
      await page.screenshot({ path: resolve(SHOTS_DIR, "multi-account-375.png"), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    // Keyboard-only flow: disable an account, retry login on a logged_out row, then add an account.
    const backupRow = codexPanel.locator("tr", { hasText: "backup" });
    const disableBtn = backupRow.getByRole("button", { name: "Disable" });
    await disableBtn.focus();
    await page.keyboard.press("Enter");
    await usePasskey(page);
    await expect(backupRow.getByRole("button", { name: "Enable" })).toBeVisible();

    const staleRow = codexPanel.locator("tr", { hasText: "stale" });
    await staleRow.getByRole("button", { name: "Log in" }).click();
    await expect(staleRow.getByText(/Finish login:/)).toContainText(
      `CODEX_HOME=${staleHome} codex login`,
    );

    const input = codexPanel.getByLabel("Add codex account");
    await input.focus();
    await page.keyboard.type("team-c");
    await page.keyboard.press("Enter");
    await expect(codexPanel.getByRole("rowheader", { name: "team-c" })).toBeVisible();
    await expect(codexPanel.locator("form").getByText(/Finish login:/)).toContainText(
      "CODEX_HOME=",
    );
    await expect(codexPanel.locator("form").getByText(/Finish login:/)).toContainText(
      "codex login",
    );

    // Remove the newly added account through the keyboard-accessible ConfirmButton dialog.
    const teamRow = codexPanel.locator("tr", { hasText: "team-c" });
    const removeBtn = teamRow.getByRole("button", { name: "Remove" });
    await removeBtn.focus();
    await page.keyboard.press("Enter");
    const confirmDialog = page.getByRole("dialog", { name: "Remove team-c?" });
    await expect(confirmDialog).toBeVisible();
    const confirmBtn = confirmDialog.getByRole("button", { name: "Remove account" });
    await confirmBtn.focus();
    await page.keyboard.press("Enter");
    await expect(confirmDialog).toBeHidden();
    await expect(codexPanel.locator("tr", { hasText: "team-c" })).toHaveCount(0);
  });
});
