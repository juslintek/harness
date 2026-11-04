import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../api";
import { type Action, createAction } from "./create-action";
import { ErrorLine } from "./error-line";
import { ignored, leaveLogin } from "./me";
import { authenticate, requestChallengeSchema } from "./webauthn";

const post = (body: unknown): { method: "POST"; body: unknown } => ({ method: "POST", body });

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
    <section aria-labelledby="passkey-h">
      <h3 id="passkey-h">Passkey</h3>
      <button type="button" disabled={props.action.busy()} onClick={signIn}>
        Sign in with a passkey
      </button>
    </section>
  );
}

function EmailLogin(props: { action: Action }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const submit = (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    return props.action.run(async () => {
      if (!sent()) {
        await api("/api/auth/email/request", ignored, post({ email: email() }));
        setSent(true);
        return;
      }
      await api("/api/auth/email/verify", ignored, post({ email: email(), code: code() }));
      await leaveLogin();
    });
  };
  return (
    <form onSubmit={submit} aria-labelledby="email-h">
      <h3 id="email-h">Email me a code</h3>
      <label>
        Email
        <input
          type="email"
          required
          autocomplete="email"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
      </label>
      <Show when={sent()}>
        <p class="muted" role="status">
          Code sent. It is printed in the harness console until mail is configured.
        </p>
        <label>
          Code from the email
          <input
            required
            autocomplete="one-time-code"
            inputMode="numeric"
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
          />
        </label>
      </Show>
      <button type="submit" disabled={props.action.busy()}>
        {sent() ? "Sign in" : "Email me a code"}
      </button>
    </form>
  );
}

function RecoveryLogin(props: { action: Action }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const submit = (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    return props.action.run(async () => {
      await api("/api/auth/recovery", ignored, post({ email: email(), code: code() }));
      await leaveLogin();
    });
  };
  return (
    <form onSubmit={submit} aria-labelledby="recovery-h">
      <h3 id="recovery-h">Use a recovery code</h3>
      <label>
        Email
        <input
          type="email"
          required
          autocomplete="email"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
      </label>
      <label>
        Recovery code
        <input
          required
          autocomplete="off"
          value={code()}
          onInput={(e) => setCode(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={props.action.busy()}>
        Sign in with the code
      </button>
    </form>
  );
}

export function LoginPage(): JSX.Element {
  const action = createAction();
  return (
    <div class="auth-page">
      <h2>Sign in to Harness</h2>
      <ErrorLine message={action.error()} />
      <PasskeyLogin action={action} />
      <EmailLogin action={action} />
      <RecoveryLogin action={action} />
    </div>
  );
}
