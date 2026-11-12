import { createSignal, type JSX, Show } from "solid-js";
import { ApiError, api } from "../api";
import { Button, Field } from "../ui/primitives";
import "./auth.css";
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

function PasskeyLogin(props: { action: Action }): JSX.Element {
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
    <Button tone="primary" class="wide" disabled={props.action.busy()} onClick={signIn}>
      Sign in with a passkey
    </Button>
  );
}

const CODE_WRONG = "That code is wrong or has expired. Request a new one.";

function EmailLogin(props: { action: Action }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const request = (e: SubmitEvent): void => {
    e.preventDefault();
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
    <>
      <form class="auth-form" onSubmit={request} aria-label="Sign in by email code">
        <Field label="Email">
          {(control) => (
            <input
              {...control()}
              type="email"
              required
              autocomplete="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" class="wide" disabled={props.action.busy()}>
          Send code
        </Button>
      </form>
      <Show when={sent()}>
        <form class="auth-form" onSubmit={verify} aria-label="Enter email code">
          <p class="auth-note" role="status">
            Code sent. It is printed in the harness console until mail is configured. It is valid
            for 10 minutes, and you can request 3 codes every 15 minutes.
          </p>
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
          <Button type="submit" class="wide" disabled={props.action.busy()}>
            Sign in with code
          </Button>
        </form>
      </Show>
    </>
  );
}

function RecoveryLogin(props: { action: Action }): JSX.Element {
  const [open, setOpen] = createSignal(false);
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
    <div class="auth-lost">
      <div class="auth-lost-row">
        <span>Lost your passkey?</span>
        <Button size="sm" tone="ghost" aria-expanded={open()} onClick={() => setOpen(!open())}>
          {open() ? "Hide" : "Use a recovery code"}
        </Button>
      </div>
      <Show when={open()}>
        <form class="auth-form" onSubmit={submit} aria-label="Sign in by recovery code">
          <Field label="Email">
            {(control) => (
              <input
                {...control()}
                type="email"
                required
                autocomplete="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
            )}
          </Field>
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
          <Button type="submit" class="wide" disabled={props.action.busy()}>
            Sign in with recovery code
          </Button>
          <p class="auth-note">
            Each recovery code works once. After signing in you can add a new passkey in Account.
          </p>
        </form>
      </Show>
    </div>
  );
}

export function LoginPage(): JSX.Element {
  const action = createAction();
  return (
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-head">
          <span class="auth-brand">Harness</span>
          <h1>Sign in</h1>
        </div>
        <ErrorLine message={action.error()} />
        <PasskeyLogin action={action} />
        <div class="auth-divider" aria-hidden="true">
          or
        </div>
        <EmailLogin action={action} />
        <RecoveryLogin action={action} />
      </div>
      <p class="auth-note">
        New here? Accounts are created from an enrollment link an admin sends you.
      </p>
    </div>
  );
}
