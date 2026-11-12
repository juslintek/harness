import "../../design/theme.css";
import { render } from "solid-js/web";
import { App } from "./app";
import "./styles.css";
import "./ui.css";

// The dark tokens are a design system block in theme.css, switched on by the mark on <html>.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyScheme = (): void => {
  if (dark.matches) document.documentElement.setAttribute("data-design-system", "dark");
  else document.documentElement.removeAttribute("data-design-system");
};
applyScheme();
dark.addEventListener("change", applyScheme);

const root = document.getElementById("app");
if (root) render(() => <App />, root);

// Dev URLs like /src/main.tsx are stable, and the worker serves cache-first, so it would pin stale code.
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err: unknown) => {
      console.warn("service worker not registered", err);
    });
  } else {
    void navigator.serviceWorker.getRegistrations().then((all) => {
      for (const registration of all) void registration.unregister();
    });
  }
}
