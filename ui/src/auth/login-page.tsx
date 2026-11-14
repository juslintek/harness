import { createSignal, type JSX, Match, Show, Switch } from "solid-js";
import { ApiError, api } from "../api";
import { Button } from "../ui/atoms";
import { Field, Notice } from "../ui/molecules";
import "./auth.css";
import { AuthHead } from "./auth-head";
import { type Action, createAction } from "./create-action";
import { ErrorLine } from "./error-line";
import { ignored, leaveLogin } from "./me";
import { authenticate, requestChallengeSchema } from "./webauthn";

const post = (body: unknown): { method: "POST"; body: unknown } => ({ method: "POST", body });

// A wrong, used or expired code all answer 401 "unauthorized", which says nothing useful on screen.
async function codeCall(action: Action, wrong: string, call: () => Promise<void>): Promise<void> {
  await action.run(async () => {
    try {
      await call();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw new Error(wrong);
      throw err;
    }
  });
}

type View = "passkey" | "email" | "recovery";

function PasskeyLogin(props: { action: Action; go: (view: View) => void }): JSX.Element {
  const signIn = (): Promise<void> =>
    props.action.run(async () => {
      const options = await api("/api/auth/login/options", requestChallengeSchema, post({}));
      const response = await authenticate(options);
      await api(
        "/api/auth/login/verify",
        ignored,
        post({ challengeId: options.challengeId, response }),
      );
      await leaveLogin();
    });
  return (
    <>
      <Button tone="primary" class="wide" disabled={props.action.busy()} onClick={signIn}>
        Sign in with a passkey
      </Button>
      <div class="auth-links">
        <p class="auth-note">No passkey on this device?</p>
        <Button size="sm" tone="ghost" onClick={() => props.go("email")}>
          Use an email code instead
        </Button>
        <Button size="sm" tone="ghost" onClick={() => props.go("recovery")}>
          Lost your passkey? Use a recovery code
        </Button>
      </div>
    </>
  );
}

const CODE_WRONG = "That code is wrong or has expired. Request a new one.";

function EmailField(props: { value: string; onInput: (v: string) => void }): JSX.Element {
  return (
    <Field label="Email">
      {(control) => (
        <input
          {...control()}
          type="email"
          required
          autocomplete="email"
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      )}
    </Field>
  );
}

function EmailLogin(props: { action: Action }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const request = (e?: SubmitEvent): void => {
    e?.preventDefault();
    void props.action.run(async () => {
      await api("/api/auth/email/request", ignored, post({ email: email() }));
      setCode("");
      setSent(true);
    });
  };
  const verify = (e: SubmitEvent): void => {
    e.preventDefault();
    void codeCall(props.action, CODE_WRONG, async () => {
      await api("/api/auth/email/verify", ignored, post({ email: email(), code: code() }));
      await leaveLogin();
    });
  };
  return (
    <Show
      when={sent()}
      fallback={
        <form class="auth-form" onSubmit={request} aria-label="Sign in by email code">
          <EmailField value={email()} onInput={setEmail} />
          <Button type="submit" tone="primary" class="wide" disabled={props.action.busy()}>
            Send code
          </Button>
        </form>
      }
    >
      <form class="auth-form" onSubmit={verify} aria-label="Enter email code">
        <Notice tone="info" title={`Code sent to ${email()}`}>
          Check spam if it is not there in a minute. The code is valid for 10 minutes. Until mail is
          set up, the code is printed in the harness console.
        </Notice>
        <Field label="Code from email">
          {(control) => (
            <input
              {...control()}
              class="mono"
              required
              autocomplete="one-time-code"
              inputMode="numeric"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" tone="primary" class="wide" disabled={props.action.busy()}>
          Sign in with code
        </Button>
        <Button
          tone="secondary"
          class="wide"
          disabled={props.action.busy()}
          onClick={() => request()}
        >
          Request a new code
        </Button>
      </form>
    </Show>
  );
}

function RecoveryLogin(props: { action: Action }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void codeCall(props.action, "That recovery code is wrong or was already used.", async () => {
      await api("/api/auth/recovery", ignored, post({ email: email(), code: code() }));
      await leaveLogin();
    });
  };
  return (
    <form class="auth-form" onSubmit={submit} aria-label="Sign in by recovery code">
      <EmailField value={email()} onInput={setEmail} />
      <Field label="Recovery code">
        {(control) => (
          <input
            {...control()}
            class="mono"
            required
            autocomplete="off"
            placeholder="xxxx-xxxx-xxxx"
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
          />
        )}
      </Field>
      <Button type="submit" tone="primary" class="wide" disabled={props.action.busy()}>
        Sign in with recovery code
      </Button>
      <p class="auth-note">
        Each recovery code works once. After signing in you can add a new passkey in Account.
      </p>
    </form>
  );
}

export function LoginPage(): JSX.Element {
  const action = createAction();
  const [view, setView] = createSignal<View>("passkey");
  return (
    <div class="auth-screen">
      <div class="auth-card">
        <AuthHead
          title="Sign in"
          sub={
            <>
              to <code>{location.host}</code>
            </>
          }
        />
        <ErrorLine message={action.error()} />
        <Switch>
          <Match when={view() === "passkey"}>
            <PasskeyLogin action={action} go={setView} />
          </Match>
          <Match when={view() === "email"}>
            <EmailLogin action={action} />
          </Match>
          <Match when={view() === "recovery"}>
            <RecoveryLogin action={action} />
          </Match>
        </Switch>
        <Show when={view() !== "passkey"}>
          <Button size="sm" tone="ghost" onClick={() => setView("passkey")}>
            Back to passkey
          </Button>
        </Show>
      </div>
      <p class="auth-note">
        New here? An admin sends you an enrolment link. Open it to create your account.
      </p>
    </div>
  );
}
