import { type Signal, signal } from "@preact/signals";

const route: Signal<string> = signal(location.hash || "#/");
window.addEventListener("hashchange", () => {
  route.value = location.hash || "#/";
});

export function routeParts(): string[] {
  return route.value.replace(/^#\/?/, "").split("/").filter(Boolean);
}
