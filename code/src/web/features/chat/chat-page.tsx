export function ChatPage({ slug }: { slug: string }): preact.JSX.Element {
  return (
    <h2>
      Chat <span class="muted">{slug}</span>
    </h2>
  );
}
