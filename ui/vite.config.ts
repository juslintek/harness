import { fileURLToPath } from "node:url";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const upstream = process.env.HARNESS_UPSTREAM ?? "http://localhost:4100";

// The server's host and origin guards compare against the browser-facing host, so the proxy must
// forward the incoming Host header instead of rewriting it to the upstream's.
const forward: ProxyOptions = {
  target: upstream,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq, req) => {
      if (req.headers.host) proxyReq.setHeader("host", req.headers.host);
    });
    proxy.on("proxyReqWs", (proxyReq, req) => {
      if (req.headers.host) proxyReq.setHeader("host", req.headers.host);
    });
  },
};

const proxy = {
  "/api": forward,
  // The MCP endpoint checks the host against the backend's own port, not the browser origin.
  "/mcp": { target: upstream, changeOrigin: true },
  "/ws": { ...forward, ws: true },
};

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      // The shared schemas live in code/ and import "zod" from there; one copy keeps the bundle small
      // and the schema types identical.
      "@shared": here("../code/src/shared"),
      zod: here("node_modules/zod"),
    },
  },
  // The design tokens and the shared schemas sit outside ui/.
  server: { port: 5173, proxy, fs: { allow: [here("..")] } },
  preview: { port: 4173, proxy },
  build: { target: "es2022", cssCodeSplit: false },
});
