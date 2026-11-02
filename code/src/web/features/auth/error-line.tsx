export function ErrorLine({ message }: { message: string | null }): preact.JSX.Element | null {
  return message ? (
    <p class="error" role="alert">
      {message}
    </p>
  ) : null;
}
