import { useEffect, useRef, useState } from "preact/hooks";
import { type ChannelView, type ChatMember, channelViewSchema } from "../../../shared/chat";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";

export type DialogKind = "group" | "dm";

function Shell(props: {
  title: string;
  onClose: () => void;
  children: preact.ComponentChildren;
}): preact.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onClose={props.onClose} aria-labelledby="dialog-title">
      <h3 id="dialog-title">{props.title}</h3>
      {props.children}
    </dialog>
  );
}

export function ChannelDialog(props: {
  kind: DialogKind;
  slug: string;
  members: ChatMember[];
  onClose: () => void;
  onCreated: (c: ChannelView) => void;
}): preact.JSX.Element {
  const action = useAction();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const isGroup = props.kind === "group";
  const submit = (e: Event): void => {
    e.preventDefault();
    void action.run(async () => {
      const [path, body] = isGroup
        ? ["groups", { name, memberIds: picked }]
        : ["dms", { memberId: picked[0] ?? "" }];
      const created = await api(`/api/orgs/${props.slug}/${path}`, channelViewSchema, {
        method: "POST",
        body,
      });
      props.onCreated(created);
    });
  };
  const toggle = (id: string, on: boolean): void =>
    setPicked(isGroup ? (on ? [...picked, id] : picked.filter((p) => p !== id)) : on ? [id] : []);
  return (
    <Shell title={isGroup ? "New group" : "New direct message"} onClose={props.onClose}>
      <form onSubmit={submit}>
        {isGroup && (
          <label>
            Name
            <input
              value={name}
              required
              maxLength={80}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>
        )}
        <fieldset>
          <legend>{isGroup ? "Members" : "Member"}</legend>
          {props.members.map((m) => (
            <label class="inline" key={m.id}>
              <input
                type={isGroup ? "checkbox" : "radio"}
                name="member"
                checked={picked.includes(m.id)}
                onChange={(e) => toggle(m.id, e.currentTarget.checked)}
              />
              {m.displayName} <span class="muted">@{m.handle}</span>
            </label>
          ))}
        </fieldset>
        <ErrorLine message={action.error} />
        <div class="row">
          <button type="submit" disabled={action.busy || (!isGroup && picked.length === 0)}>
            Create
          </button>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Shell>
  );
}
