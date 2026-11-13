import { useRef } from "preact/hooks";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { reviewSchema, type UpdateRequestView, updateRequestSchema } from "./selfupdate-data";

interface Props {
  request: UpdateRequestView;
  onChange: (message: string) => void;
}

export function ReviewPanel({ request, onChange }: Props): preact.JSX.Element {
  const action = useAction();
  const heading = useRef<HTMLHeadingElement>(null);
  const base = `/api/selfupdate/requests/${encodeURIComponent(request.id)}`;
  const review = useLoad(() => api(`${base}/review`, reviewSchema), [request.id]);
  const decide = (verb: "approve" | "deny"): Promise<void> =>
    action.run(async () => {
      await api(`${base}/${verb}`, updateRequestSchema, { method: "POST" });
      onChange(verb === "approve" ? "Update approved, pipeline started" : "Update denied");
      heading.current?.focus();
    });
  const data = review.data;
  return (
    <section class="review" aria-labelledby={`review-${request.id}`}>
      <h4 id={`review-${request.id}`} ref={heading} tabIndex={-1}>
        Review before approval
      </h4>
      <ErrorLine message={review.error} />
      {data && (
        <>
          <p>
            Pinned commit <code>{data.commitSha}</code>. An approval covers only this commit.
          </p>
          <h5>Flagged paths</h5>
          {data.flagged.length === 0 ? (
            <p class="muted">None</p>
          ) : (
            <ul>
              {data.flagged.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          )}
          <h5>Diff stat</h5>
          <pre>{data.stat || "(not available)"}</pre>
          <div class="row-buttons">
            <button type="button" disabled={action.busy} onClick={() => decide("approve")}>
              Approve (passkey)
            </button>
            <button type="button" disabled={action.busy} onClick={() => decide("deny")}>
              Deny
            </button>
          </div>
        </>
      )}
      <ErrorLine message={action.error} />
    </section>
  );
}
