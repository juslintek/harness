export function OrgPage({ slug }: { slug: string }): preact.JSX.Element {
  return (
    <h2>
      Organisation settings <span class="muted">{slug}</span>
    </h2>
  );
}
