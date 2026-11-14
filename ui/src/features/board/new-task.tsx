import { taskViewSchema } from "@shared/board";
import { createSignal, createUniqueId, type JSX } from "solid-js";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { clearRouteQuery, routeQuery } from "../../route";
import { Button } from "../../ui/atoms";
import { Dialog, Field } from "../../ui/molecules";

// A deep link (#/o/acme/board/<project>?new=1&title=...) opens the dialog with the title filled in.
// The query stays until the dialog closes: the board swaps this component for its empty-state copy
// while it loads, and the copy must still see it.
function fromLink(): { open: boolean; title: string } {
  const query = routeQuery();
  if (query.get("new") !== "1") return { open: false, title: "" };
  return { open: true, title: (query.get("title") ?? "").trim().slice(0, 200) };
}

export function NewTask(props: { projectId: string; onCreated: () => void }): JSX.Element {
  const linked = fromLink();
  const [open, setOpen] = createSignal(linked.open);
  const [title, setTitle] = createSignal(linked.title);
  const action = createAction();
  const formId = createUniqueId();
  const close = (): void => {
    setOpen(false);
    if (routeQuery().get("new") === "1") clearRouteQuery();
  };
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      await api(`/api/projects/${props.projectId}/tasks`, taskViewSchema, {
        method: "POST",
        body: { title: title() },
      });
      setTitle("");
      close();
      props.onCreated();
    });
  };
  return (
    <>
      <Button tone="primary" onClick={() => setOpen(true)}>
        New task
      </Button>
      <Dialog
        open={open()}
        onClose={close}
        title="New task"
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              type="submit"
              form={formId}
              tone="primary"
              disabled={action.busy() || title().trim() === ""}
            >
              Add
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit}>
          <Field label="Title">
            {(control) => (
              <input
                {...control()}
                value={title()}
                required
                maxLength={200}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            )}
          </Field>
          <ErrorLine message={action.error()} />
        </form>
      </Dialog>
    </>
  );
}
