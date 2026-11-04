import { type Signal, signal } from "@preact/signals";

const route: Signal<string> = signal(location.hash || "#/");
window.addEventListener("hashchange", () => {
  route.value = location.hash || "#/";
});

export function routeParts(): string[] {
  return route.value.replace(/^#\/?/, "").split("/").filter(Boolean);
}

// A 401 sends the visitor to the login page; the hash they came for is replayed after sign-in so a
// notification deep link survives it.
let returnHash: string | null = null;

export function rememberReturn(hash: string): void {
  returnHash = hash;
}

export function takeReturn(): string {
  const hash = returnHash || "#/";
  returnHash = null;
  return hash;
}
