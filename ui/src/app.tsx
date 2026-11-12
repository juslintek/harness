import { createEffect, createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { ApiError } from "./api";
import { EnrollPage } from "./auth/enroll-page";
import { LoginPage } from "./auth/login-page";
import { me, refreshMe } from "./auth/me";
import { StepUpDialog } from "./auth/step-up-dialog";
import { AccountPage } from "./features/auth/account-page";
import { BoardPage } from "./features/board/board-page";
import { ChatPage } from "./features/chat/chat-page";
import { DashboardPage } from "./features/dashboard/dashboard-page";
import { HiringPage } from "./features/hiring/hiring-page";
import { IntegrationsPage } from "./features/integrations/integrations-page";
import { LogsPage } from "./features/logs/logs-page";
import { MemoryPage } from "./features/memory/memory-page";
import { ConsentPage } from "./features/oauth/consent-page";
import { SettingsPage } from "./features/orgs/settings-page";
import { PoliciesPage } from "./features/policies/policies-page";
import { runsRoute } from "./features/runs/routes";
import { errorText } from "./format";
import { selectedSlug } from "./orgs";
import { routeParts } from "./route";
import { pageTitle } from "./shell/nav";
import { AppShell } from "./shell/shell";
import { Button, State } from "./ui/primitives";

export function App(): JSX.Element {
  const first = (): string | undefined => routeParts()[0];
  const enrollCode = (): string | undefined => (first() === "enroll" ? routeParts()[1] : undefined);
  const orgPage = (name: string): string | undefined => {
    const [head, slug, page] = routeParts();
    return head === "o" && page === name ? slug : undefined;
  };
  // "#/" is the runs list for an instance admin and the board for everyone else.
  const boardSlug = (): string | undefined => {
    const [head, slug, page] = routeParts();
    if (head === "o") return page === undefined || page === "board" ? slug : undefined;
    return head === undefined && !me()?.user.instanceAdmin
      ? (selectedSlug() ?? undefined)
      : undefined;
  };
  const [loadError, setLoadError] = createSignal<string | null>(null);
  // A 401 sends the visitor to the sign-in page from inside api(); anything else is shown here.
  const load = (): void => {
    setLoadError(null);
    refreshMe().catch((err: unknown) => {
      if (!(err instanceof ApiError && err.status === 401)) setLoadError(errorText(err));
    });
  };
  createEffect(() => {
    if (!me() && first() !== "login" && first() !== "enroll") load();
  });
  createEffect(() => {
    if (me()) setLoadError(null);
  });
  return (
    <>
      <Switch>
        <Match when={first() === "login"}>
          <main>
            <LoginPage />
          </main>
        </Match>
        <Match when={enrollCode()} keyed>
          {(code) => (
            <main>
              <EnrollPage code={code} />
            </main>
          )}
        </Match>
        <Match when={me() ? null : loadError()}>
          {(message) => (
            <main>
              <div class="auth-page">
                <p class="error" role="alert">
                  Cannot load your account: {message()}
                </p>
                <Button onClick={load}>Retry</Button>
              </div>
            </main>
          )}
        </Match>
        <Match when={!me()}>
          <main>
            <State kind="loading" />
          </main>
        </Match>
        <Match when={first() === "oauth" && routeParts()[1]?.startsWith("consent")}>
          <ConsentPage />
        </Match>
        <Match when={true}>
          <AppShell>
            <Switch
              fallback={
                <Show
                  when={selectedSlug()}
                  keyed
                  fallback={
                    <State kind="empty" title={pageTitle()} message="No organisation yet." />
                  }
                >
                  {(slug) => <BoardPage slug={slug} />}
                </Show>
              }
            >
              <Match when={first() === "account"}>
                <AccountPage />
              </Match>
              <Match when={first() === "integrations"}>
                <IntegrationsPage />
              </Match>
              <Match when={orgPage("dashboard")} keyed>
                {(slug) => <DashboardPage slug={slug} />}
              </Match>
              <Match when={orgPage("logs")} keyed>
                {(slug) => <LogsPage slug={slug} />}
              </Match>
              <Match when={orgPage("memory")} keyed>
                {(slug) => <MemoryPage slug={slug} />}
              </Match>
              <Match when={orgPage("chat")} keyed>
                {(slug) => <ChatPage slug={slug} />}
              </Match>
              <Match when={boardSlug()} keyed>
                {(slug) => <BoardPage slug={slug} />}
              </Match>
              <Match when={orgPage("policies")} keyed>
                {(slug) => <PoliciesPage slug={slug} />}
              </Match>
              <Match when={orgPage("hiring")} keyed>
                {(slug) => (
                  <HiringPage slug={slug} {...(routeParts()[3] && { id: routeParts()[3] })} />
                )}
              </Match>
              <Match when={orgPage("settings")} keyed>
                {(slug) => <SettingsPage slug={slug} />}
              </Match>
              <Match when={runsRoute()} keyed>
                {(Page) => <Page />}
              </Match>
            </Switch>
          </AppShell>
        </Match>
      </Switch>
      <StepUpDialog />
    </>
  );
}
