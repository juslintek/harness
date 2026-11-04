export function FacetGroup({
  label,
  counts,
  active,
  onToggle,
}: {
  label: string;
  counts: Record<string, number>;
  active: string;
  onToggle: (value: string) => void;
}): preact.JSX.Element | null {
  const names = Object.keys(counts).sort();
  if (names.length === 0) return null;
  return (
    <fieldset class="facet">
      <legend>{label}</legend>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          class="chip"
          aria-pressed={active === name}
          onClick={() => onToggle(active === name ? "" : name)}
        >
          {name} <span class="count">{counts[name]}</span>
        </button>
      ))}
    </fieldset>
  );
}
