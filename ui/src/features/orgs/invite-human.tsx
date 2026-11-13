import type { OrgDetail, Role } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, CopyButton, Help } from "../../ui/atoms";
import { Field, Notice } from "../../ui/molecules";
import { ROLES } from "./shared";

// The shared schema drops pendingEnrollment, which tells an existing account without a passkey.
const resultSchema = z.object({
  enrollmentLink: z.string().nullable(),
  pendingEnrollment: z.boolean().optional(),
});

interface Result {
  email: string;
  link: string | null;
  pending: boolean;
}

export function InviteHuman(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<Role>("member");
  const [result, setResult] = createSignal<Result | null>(null);
  const action = createAction();
  return (
    <div class="stack members-section">
      <h3 class="sub-title">Invite a person</h3>
      <Help>
        A new address gets an enrol link that works for 24 hours. Harness does not send it by email:
        copy it and send it yourself. An address that already has an account is added at once.
        Inviting an admin asks for your passkey.
      </Help>
      <form
        class="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            setResult(null);
            const sent = email();
            const res = await api(
              `/api/orgs/${props.detail.org.slug}/members/humans`,
              resultSchema,
              { method: "POST", body: { email: sent, role: role() } },
            );
            setResult({
              email: sent,
              link: res.enrollmentLink,
              pending: res.pendingEnrollment === true,
            });
            setEmail("");
            props.onChange();
          });
        }}
      >
        <Field label="Invite by email" error={action.error()}>
          {(c) => (
            <input
              {...c()}
              type="email"
              value={email()}
              required
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Role">
          {(c) => (
            <select {...c()} onChange={(e) => setRole(e.currentTarget.value as Role)}>
              <For each={ROLES}>{(r) => <option selected={r === role()}>{r}</option>}</For>
            </select>
          )}
        </Field>
        <Button type="submit" tone="primary" disabled={action.busy()}>
          Send invite
        </Button>
      </form>
      <Show when={result()}>
        {(done) => (
          <Show
            when={done().link}
            fallback={
              <Notice tone="success" title={`${done().email} was added`}>
                {done().pending
                  ? "They have no passkey yet and still need to enrol."
                  : "They can open this organization now."}
              </Notice>
            }
          >
            {(url) => (
              <Notice
                tone="success"
                title={`Invite created for ${done().email}`}
                actions={<CopyButton text={url()} label="Copy link" />}
              >
                Send them this link, valid 24 hours: <code>{url()}</code>
              </Notice>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}
