import { useState } from "preact/hooks";
import type { SelfCard } from "../../../shared/profiles";
import { ApiError, api } from "../../api";
import { errorText } from "../../format";
import { ignored } from "../auth/me";

function issuesOf(err: unknown): string[] {
  if (err instanceof ApiError && err.issues.length > 0) return err.issues;
  return [errorText(err)];
}

export function CardEditor({
  url,
  card,
  onSaved,
}: {
  url: string;
  card: SelfCard | null;
  onSaved: () => void;
}): preact.JSX.Element {
  const [text, setText] = useState(card ? JSON.stringify(card, null, 2) : "");
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      setIssues([`not valid JSON: ${errorText(err)}`]);
      return;
    }
    setBusy(true);
    try {
      await api(url, ignored, { method: "PUT", body: raw });
      setIssues([]);
      onSaved();
    } catch (err) {
      setIssues(issuesOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <label>
        Self card (JSON)
        <textarea
          class="json"
          rows={10}
          value={text}
          aria-describedby="card-issues"
          aria-invalid={issues.length > 0}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <ul id="card-issues" class="plain error" role="alert">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
      <button type="button" disabled={busy} onClick={() => void save()}>
        Save card
      </button>
    </div>
  );
}
