import { useState } from "preact/hooks";

// The codes are shown once and never again, so the way on stays locked until the user confirms.
export function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}): preact.JSX.Element {
  const [saved, setSaved] = useState(false);
  return (
    <section aria-labelledby="codes-h">
      <h4 id="codes-h">Your codes</h4>
      <p>Each code signs you in once if you lose your passkey. They are not shown again.</p>
      <ul class="codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <label class="inline">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.currentTarget.checked)}
        />
        I saved them
      </label>
      <button type="button" disabled={!saved} onClick={onDone}>
        Continue
      </button>
    </section>
  );
}
