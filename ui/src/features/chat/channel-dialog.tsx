import { type ChannelView, type ChatMember, channelViewSchema } from "@shared/chat";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { errorText } from "../../format";
import { Button } from "../../ui/atoms";
import { Dialog, Field } from "../../ui/molecules";

export type DialogKind = "group" | "dm";

export function ChannelDialog(props: {
  kind: DialogKind;
  slug: string;
  members: ChatMember[];
  onClose: () => void;
  onCreated: (c: ChannelView) => void;
}): JSX.Element {
  const formId = createUniqueId();
  const [name, setName] = createSignal("");
  const [picked, setPicked] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const isGroup = props.kind === "group";
  const submit = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const [path, body] = isGroup
        ? ["groups", { name: name(), memberIds: picked() }]
        : ["dms", { memberId: picked()[0] ?? "" }];
      props.onCreated(
        await api(`/api/orgs/${props.slug}/${path}`, channelViewSchema, { method: "POST", body }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string, on: boolean): void => {
    const rest = picked().filter((p) => p !== id);
    setPicked(on ? (isGroup ? [...rest, id] : [id]) : rest);
  };
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={isGroup ? "New group" : "New direct message"}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            tone="primary"
            disabled={busy() || (!isGroup && picked().length === 0)}
          >
            Create
          </Button>
        </>
      }
    >
      <form id={formId} class="channel-form" onSubmit={(e) => void submit(e)}>
        <Show when={isGroup}>
          <Field label="Name">
            {(control) => (
              <input
                {...control()}
                value={name()}
                required
                maxLength={80}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            )}
          </Field>
        </Show>
        <fieldset>
          <legend>{isGroup ? "Members" : "Member"}</legend>
          <For each={props.members}>
            {(m) => (
              <label class="member">
                <input
                  type={isGroup ? "checkbox" : "radio"}
                  name="member"
                  checked={picked().includes(m.id)}
                  onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                />
                {m.displayName} <span class="muted mono">@{m.handle}</span>
              </label>
            )}
          </For>
        </fieldset>
        <Show when={error()}>
          {(message) => (
            <p class="error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </form>
    </Dialog>
  );
}
