import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import { FormError } from "../orgs/shared";
import type { Candidate } from "./score-table";

const CRITERIA = [
  { name: "fit", hint: "Matches the must-haves and the role." },
  { name: "depth", hint: "Shows how it would do the work, not only what." },
  { name: "honesty", hint: "Says what it cannot do." },
] as const;
const SCALE = [1, 2, 3, 4, 5];

type Marks = Partial<Record<(typeof CRITERIA)[number]["name"], number>>;

export function ScoreForm(props: {
  base: string;
  candidate: Candidate;
  onSaved: () => void;
}): JSX.Element {
  const [marks, setMarks] = createSignal<Marks>({});
  const [notes, setNotes] = createSignal("");
  const action = createAction();
  // The server wants all three, and a pre-filled 3 would be a score nobody gave.
  const complete = (): boolean => CRITERIA.every((c) => marks()[c.name] !== undefined);
  const submit = (e: Event): void => {
    e.preventDefault();
    if (!complete()) return;
    void action.run(async () => {
      await api(`${props.base}/score/${props.candidate.id}`, ignored, {
        method: "POST",
        body: { ...marks(), notes: notes() },
      });
      setMarks({});
      setNotes("");
      props.onSaved();
    });
  };
  return (
    <form class="stack score-form" onSubmit={submit}>
      <h3 class="sub-title">Your scorecard</h3>
      <div class="form-row">
        <For each={CRITERIA}>
          {(item) => (
            <div class="score-pick">
              <Field label={`${item.name} (1 to 5)`}>
                {(c) => (
                  <select
                    {...c()}
                    onChange={(e) =>
                      setMarks({
                        ...marks(),
                        [item.name]: Number(e.currentTarget.value) || undefined,
                      })
                    }
                  >
                    <option value="" selected={marks()[item.name] === undefined}>
                      Pick 1 to 5
                    </option>
                    <For each={SCALE}>
                      {(n) => (
                        <option value={n} selected={n === marks()[item.name]}>
                          {n}
                        </option>
                      )}
                    </For>
                  </select>
                )}
              </Field>
              <Help>{item.hint}</Help>
            </div>
          )}
        </For>
      </div>
      <Field label="Notes (optional)">
        {(c) => (
          <textarea
            {...c()}
            value={notes()}
            maxLength={1000}
            rows={2}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        )}
      </Field>
      <div class="form-row form-submit">
        <Button type="submit" disabled={action.busy() || !complete()}>
          Save scorecard
        </Button>
        <Show when={!complete()}>
          <Help>Pick a score for fit, depth and honesty to save.</Help>
        </Show>
      </div>
      <FormError message={action.error()} />
    </form>
  );
}
