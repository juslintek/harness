import { createEffect, createSignal, type JSX, Match, Switch } from "solid-js";
import { ApiError } from "./api";
import { EnrollPage } from "./auth/enroll-page";
import { LoginPage } from "./auth/login-page";
import { me, refreshMe } from "./auth/me";
import { StepUpDialog } from "./auth/step-up-dialog";
import { AccountPage } from "./features/auth/account-page";
import { BoardPage } from "./features/board/board-page";
import { ChatPage } from "./features/chat/chat-page";
import { DashboardPage } from "./features/dashboard/dashboard-page";
import { DeployPage } from "./features/deploy/deploy-page";
import { FederationPage } from "./features/federation/federation-page";
import { HiringPage } from "./features/hiring/hiring-page";
import { IntegrationsPage } from "./features/integrations/integrations-page";
import { LogsPage } from "./features/logs/logs-page";
import { MemoryPage } from "./features/memory/memory-page";
import { NowPage } from "./features/now/now";
import { ConsentPage } from "./features/oauth/consent-page";
import { SettingsPage } from "./features/orgs/settings-page";
import { PlaybooksPage } from "./features/playbooks/playbooks";
import { PoliciesPage } from "./features/policies/policies-page";
import { runsRoute } from "./features/runs/routes";
import { UpdatesPage } from "./features/updates/updates-page";
import { errorText } from "./format";
import { routeParts } from "./route";
import { Button } from "./ui/atoms";
import { State } from "./ui/molecules";
import { AppShell } from "./ui/organisms";

export function App(): JSX.Element {
  const first = (): string | undefined => routeParts()[0];
  const enrollCode = (): string | undefined => (first() === "enroll" ? routeParts()[1] : undefined);
  const orgPage = (name: string): string | undefined => {
    const [head, slug, page] = routeParts();
    return head === "o" && page === name ? slug : undefined;
  };
  const boardSlug = (): string | undefined => {
    const [head, slug, page] = routeParts();
    return head === "o" && (page === undefined || page === "board") ? slug : undefined;
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
            <Switch fallback={<NowPage />}>
              <Match when={first() === "playbooks"}>
                <PlaybooksPage />
              </Match>
              <Match when={first() === "account"}>
                <AccountPage />
              </Match>
              <Match when={first() === "integrations"}>
                <IntegrationsPage />
              </Match>
              <Match when={first() === "federation"}>
                <FederationPage />
              </Match>
              <Match when={first() === "deploy"}>
                <DeployPage />
              </Match>
              <Match when={first() === "updates"}>
                <UpdatesPage />
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
