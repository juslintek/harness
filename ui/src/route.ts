import { createSignal } from "solid-js";

const [route, setRoute] = createSignal(location.hash || "#/");
window.addEventListener("hashchange", () => setRoute(location.hash || "#/"));

export function routeParts(): string[] {
  return route().replace(/^#\/?/, "").split("/").filter(Boolean);
}
