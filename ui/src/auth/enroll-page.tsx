import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../api";
import { Button, Field } from "../ui/primitives";
import "./auth.css";
import { createAction } from "./create-action";
import { ErrorLine } from "./error-line";
import { leaveLogin } from "./me";
import { RecoveryCodes } from "./recovery-codes";
import { type CreationChallenge, creationChallengeSchema, register } from "./webauthn";

type EnrollChallenge = CreationChallenge & { userId: string };
const optionsSchema: z.ZodType<EnrollChallenge> = z.custom<EnrollChallenge>(
  (v) =>
    creationChallengeSchema.safeParse(v).success &&
    typeof (v as { userId?: unknown }).userId === "string",
);
const enrolledSchema: z.ZodType<{ recoveryCodes: string[] }> = z.object({
  recoveryCodes: z.array(z.string()),
});

const post = (body: unknown): { method: "POST"; body: unknown } => ({ method: "POST", body });

export function EnrollPage(props: { code: string }): JSX.Element {
  const action = createAction();
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const submit = (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    return action.run(async () => {
      const path = `/api/auth/enroll/${encodeURIComponent(props.code)}`;
      const body = post({ name: name(), email: email() });
      const options = await api(`${path}/options`, optionsSchema, body);
      const response = await register(options);
      const done = await api(
        `${path}/verify`,
        enrolledSchema,
        post({
          challengeId: options.challengeId,
          userId: options.userId,
          response,
          name: "This device",
        }),
      );
      setCodes(done.recoveryCodes);
    });
  };
  return (
    <div class="auth-screen">
      <div class="auth-card">
        <Show
          when={codes()}
          fallback={
            <form class="auth-form" onSubmit={submit} aria-labelledby="enroll-h">
              <div class="auth-head">
                <span class="auth-brand">Harness</span>
                <h2 id="enroll-h">Create your account</h2>
              </div>
              <ErrorLine message={action.error()} />
              <Field label="Your name">
                {(control) => (
                  <input
                    {...control()}
                    required
                    autocomplete="name"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                  />
                )}
              </Field>
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
              <Button type="submit" tone="primary" class="wide" disabled={action.busy()}>
                Register a passkey
              </Button>
              <p class="auth-note">
                Your browser asks you to create a passkey. You will get recovery codes next.
              </p>
            </form>
          }
        >
          {(done) => (
            <>
              <div class="auth-head">
                <span class="auth-brand">Harness</span>
                <h2>You are enrolled</h2>
              </div>
              <RecoveryCodes codes={done()} onDone={() => void action.run(leaveLogin)} />
              <ErrorLine message={action.error()} />
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
