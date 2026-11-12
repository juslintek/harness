import { me } from "./auth/me";
import { routeParts } from "./route";

const KEY = "harness.org";

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// The URL wins so shared links open the right org; otherwise the last pick, then the first org.
export function selectedSlug(): string | null {
  const orgs = me()?.orgs ?? [];
  const parts = routeParts();
  const fromUrl = parts[0] === "o" ? parts[1] : undefined;
  const wanted = fromUrl ?? remembered();
  return orgs.find((o) => o.slug === wanted)?.slug ?? orgs[0]?.slug ?? null;
}

export function chooseOrg(slug: string): void {
  try {
    localStorage.setItem(KEY, slug);
  } catch {
    // Remembering the pick is a convenience; the URL still carries it.
  }
  const parts = routeParts();
  location.hash = `#/o/${slug}/${parts[0] === "o" ? (parts[2] ?? "board") : "board"}`;
}
