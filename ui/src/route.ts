import { createSignal } from "solid-js";

const [route, setRoute] = createSignal(location.hash || "#/");
window.addEventListener("hashchange", () => setRoute(location.hash || "#/"));

export function routeParts(): string[] {
  return (route().replace(/^#\/?/, "").split("?")[0] ?? "").split("/").filter(Boolean);
}

// Deep links can carry a prefill after "?": #/o/acme/hiring?specialty=writing. Callers validate it.
export function routeQuery(): URLSearchParams {
  return new URLSearchParams(route().split("?")[1] ?? "");
}

// For a prefill that must apply once, so a remount or a reload does not apply it again.
export function clearRouteQuery(): void {
  const bare = route().split("?")[0] ?? "#/";
  history.replaceState(null, "", bare);
  setRoute(bare);
}
