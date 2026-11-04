export function MemoryPage({ slug }: { slug: string }): preact.JSX.Element {
  return (
    <section class="memory-page" data-org={slug}>
      <h2>Memory</h2>
    </section>
  );
}
