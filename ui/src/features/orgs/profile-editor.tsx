import type { MemberView } from "@shared/orgs";
import { type ProfileInput, profileViewSchema, type SelfCard } from "@shared/profiles";
import { agentRowSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { ApiError, api } from "../../api";
import { ignored } from "../../auth/me";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button } from "../../ui/atoms";
import { Field, State } from "../../ui/molecules";
import { FormError } from "./shared";

const MAX_FALLBACKS = 3;
const RUNTIME_LIST = "profile-runtime-ids";

function issuesOf(err: unknown): string[] {
  if (err instanceof ApiError && err.issues.length > 0) return err.issues;
  return [errorText(err)];
}

function CardEditor(props: {
  url: string;
  card: SelfCard | null;
  onSaved: () => void;
}): JSX.Element {
  const [text, setText] = createSignal(props.card ? JSON.stringify(props.card, null, 2) : "");
  const [issues, setIssues] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const save = async (): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(text());
    } catch (err) {
      setIssues([`not valid JSON: ${errorText(err)}`]);
      return;
    }
    setBusy(true);
    try {
      await api(props.url, ignored, { method: "PUT", body: raw });
      setIssues([]);
      props.onSaved();
    } catch (err) {
      setIssues(issuesOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack">
      <div class="field">
        <label for="self-card">Self card (JSON)</label>
        <textarea
          id="self-card"
          class="json"
          rows={10}
          value={text()}
          aria-describedby="card-issues"
          aria-invalid={issues().length > 0}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </div>
      <ul id="card-issues" class="chips form-error" role="alert">
        <For each={issues()}>{(issue) => <li>{issue}</li>}</For>
      </ul>
      <div>
        <Button disabled={busy()} onClick={() => void save()}>
          Save card
        </Button>
      </div>
    </div>
  );
}

function ProfileForm(props: {
  url: string;
  profile: ProfileInput;
  runtimes: { id: string; name: string }[];
  onSaved: () => void;
}): JSX.Element {
  const [form, setForm] = createSignal<ProfileInput>(props.profile);
  const [skills, setSkills] = createSignal(props.profile.skills.join(", "));
  const action = createAction();
  const patch = (next: Partial<ProfileInput>): void => {
    setForm((cur) => ({ ...cur, ...next }));
  };
  const setFallback = (i: number, next: Partial<ProfileInput["fallbacks"][number]>): void =>
    patch({ fallbacks: form().fallbacks.map((f, j) => (j === i ? { ...f, ...next } : f)) });
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const list = skills()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        void action.run(async () => {
          await api(props.url, profileViewSchema, {
            method: "PUT",
            body: { ...form(), skills: list },
          });
          props.onSaved();
        });
      }}
    >
      <datalist id={RUNTIME_LIST}>
        <For each={props.runtimes}>{(a) => <option value={a.id} label={a.name} />}</For>
      </datalist>
      <div class="form-row">
        <Field label="Runtime">
          {(c) => (
            <input
              {...c()}
              value={form().runtime}
              required
              list={RUNTIME_LIST}
              onInput={(e) => patch({ runtime: e.currentTarget.value })}
            />
          )}
        </Field>
        <Field label="Model">
          {(c) => (
            <input
              {...c()}
              value={form().model ?? ""}
              onInput={(e) => patch({ model: e.currentTarget.value || null })}
            />
          )}
        </Field>
      </div>
      <Field label="Persona">
        {(c) => (
          <textarea
            {...c()}
            rows={4}
            maxLength={2000}
            value={form().persona}
            onInput={(e) => patch({ persona: e.currentTarget.value })}
          />
        )}
      </Field>
      <label class="check">
        <input
          type="checkbox"
          checked={form().scope.readOnly}
          onChange={(e) => patch({ scope: { readOnly: e.currentTarget.checked } })}
        />
        Read-only scope (the agent cannot write to the repository)
      </label>
      <Field label="Skills (comma separated)">
        {(c) => (
          <input {...c()} value={skills()} onInput={(e) => setSkills(e.currentTarget.value)} />
        )}
      </Field>
      <fieldset class="stack">
        <legend class="sub-title">Fallback engines (tried in order)</legend>
        <For each={form().fallbacks}>
          {(f, i) => (
            <div class="form-row">
              <Field label={`Fallback ${i() + 1} runtime`}>
                {(c) => (
                  <input
                    {...c()}
                    value={f.runtime}
                    required
                    list={RUNTIME_LIST}
                    onInput={(e) => setFallback(i(), { runtime: e.currentTarget.value })}
                  />
                )}
              </Field>
              <Field label={`Fallback ${i() + 1} model`}>
                {(c) => (
                  <input
                    {...c()}
                    value={f.model ?? ""}
                    onInput={(e) => setFallback(i(), { model: e.currentTarget.value || null })}
                  />
                )}
              </Field>
              <Button
                size="sm"
                onClick={() => patch({ fallbacks: form().fallbacks.filter((_, j) => j !== i()) })}
              >
                Remove fallback {i() + 1}
              </Button>
            </div>
          )}
        </For>
        <Show when={form().fallbacks.length < MAX_FALLBACKS}>
          <div>
            <Button
              size="sm"
              onClick={() =>
                patch({ fallbacks: [...form().fallbacks, { runtime: "", model: null }] })
              }
            >
              Add fallback
            </Button>
          </div>
        </Show>
      </fieldset>
      <div>
        <Button type="submit" tone="primary" disabled={action.busy()}>
          Save profile
        </Button>
      </div>
      <FormError message={action.error()} />
    </form>
  );
}

export function ProfileEditor(props: { slug: string; member: MemberView }): JSX.Element {
  const url = (): string => `/api/orgs/${props.slug}/members/${props.member.id}/profile`;
  const loaded = createLoad(url, profileViewSchema);
  // The runtime list is instance-admin only; without it the field is still a plain text input.
  const agents = createLoad("/api/agents", z.array(agentRowSchema));
  const runtimes = (): { id: string; name: string }[] =>
    agents.data()?.filter((a) => a.installed && a.enabled) ?? [];
  const missing = (): boolean => loaded.error()?.endsWith("not_found") === true;
  const profile = (): ProfileInput | undefined =>
    loaded.data() ??
    (missing()
      ? {
          runtime: props.member.agentId ?? "",
          model: props.member.model,
          persona: "",
          skills: [],
          scope: { readOnly: false },
          fallbacks: [],
        }
      : undefined);
  // The inner Show is keyed by the saved version so a reload after saving resets the forms.
  return (
    <Show
      when={profile()}
      fallback={
        <State
          kind={loaded.error() ? "error" : "loading"}
          {...(loaded.error() ? { message: loaded.error() as string } : {})}
        />
      }
    >
      <Show when={`${loaded.data()?.id ?? "new"}:${loaded.data()?.cardAt ?? "none"}`} keyed>
        {(_version) => (
          <div class="stack">
            <ProfileForm
              url={url()}
              profile={profile() as ProfileInput}
              runtimes={runtimes()}
              onSaved={() => void loaded.reload()}
            />
            <CardEditor
              url={`${url()}/card`}
              card={loaded.data()?.card ?? null}
              onSaved={() => void loaded.reload()}
            />
          </div>
        )}
      </Show>
    </Show>
  );
}
