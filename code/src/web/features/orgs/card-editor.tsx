import { useState } from "preact/hooks";
import { z } from "zod";
import type { SelfCard } from "../../../shared/profiles";

const failureSchema = z.object({ error: z.string(), issues: z.array(z.string()).optional() });

// The shared api() helper keeps only the error name; the card route's per-field issues are the point here.
async function putCard(url: string, raw: unknown): Promise<string[]> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(raw),
    credentials: "same-origin",
  });
  if (res.ok) return [];
  const parsed = failureSchema.safeParse(await res.json().catch(() => null));
  if (parsed.success) return parsed.data.issues ?? [parsed.data.error];
  return [`HTTP ${res.status}`];
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
      setIssues([`not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
      return;
    }
    setBusy(true);
    try {
      const found = await putCard(url, raw);
      setIssues(found);
      if (found.length === 0) onSaved();
    } catch (err) {
      setIssues([err instanceof Error ? err.message : String(err)]);
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
