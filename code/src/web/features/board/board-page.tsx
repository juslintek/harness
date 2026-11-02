export function BoardPage({ slug }: { slug: string }): preact.JSX.Element {
  return (
    <h2>
      Board <span class="muted">{slug}</span>
    </h2>
  );
}
