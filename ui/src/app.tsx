import { createEffect, createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { ApiError } from "./api";
import { EnrollPage } from "./auth/enroll-page";
import { LoginPage } from "./auth/login-page";
import { me, refreshMe } from "./auth/me";
import { errorText } from "./format";
import { routeParts } from "./route";

function Header(): JSX.Element {
  return (
    <header>
      <h1>Harness</h1>
      <Show when={me()}>
        {(current) => (
          <nav aria-label="Main">
            <span class="muted">{current().user.name}</span>
          </nav>
        )}
      </Show>
    </header>
  );
}

function Layout(): JSX.Element {
  return <Show when={me()}>{(current) => <p>Signed in as {current().user.email}</p>}</Show>;
}

export function App(): JSX.Element {
  const first = (): string | undefined => routeParts()[0];
  const enrollCode = (): string | undefined => (first() === "enroll" ? routeParts()[1] : undefined);
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
      <Header />
      <main>
        <Switch fallback={<Layout />}>
          <Match when={first() === "login"}>
            <LoginPage />
          </Match>
          <Match when={enrollCode()} keyed>
            {(code) => <EnrollPage code={code} />}
          </Match>
          <Match when={me() ? null : loadError()}>
            {(message) => (
              <div class="auth-page">
                <p class="error" role="alert">
                  Cannot load your account: {message()}
                </p>
                <button type="button" onClick={load}>
                  Retry
                </button>
              </div>
            )}
          </Match>
          <Match when={!me()}>
            <p class="muted">Loading…</p>
          </Match>
        </Switch>
      </main>
    </>
  );
}
