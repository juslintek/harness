import { useState } from "preact/hooks";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "./error-line";
import { leaveLogin } from "./me";
import { RecoveryCodes } from "./recovery-codes";
import { useAction } from "./use-action";
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

export function EnrollPage({ code }: { code: string }): preact.JSX.Element {
  const action = useAction();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const submit = (e: Event): Promise<void> => {
    e.preventDefault();
    return action.run(async () => {
      const path = `/api/auth/enroll/${encodeURIComponent(code)}`;
      const options = await api(`${path}/options`, optionsSchema, post({ name, email }));
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
  if (codes) {
    return (
      <div class="auth-page">
        <h2>You are enrolled</h2>
        <RecoveryCodes codes={codes} onDone={() => void action.run(leaveLogin)} />
        <ErrorLine message={action.error} />
      </div>
    );
  }
  return (
    <form class="auth-page" onSubmit={submit} aria-labelledby="enroll-h">
      <h2 id="enroll-h">Create your account</h2>
      <ErrorLine message={action.error} />
      <label>
        Your name
        <input
          required
          autocomplete="name"
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label>
        Email
        <input
          type="email"
          required
          autocomplete="email"
          value={email}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Register a passkey
      </button>
    </form>
  );
}
