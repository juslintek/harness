export function LogsPage({ slug }: { slug: string }): preact.JSX.Element {
  return (
    <section data-org={slug}>
      <h2>Logs</h2>
    </section>
  );
}
