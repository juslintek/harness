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

export default defineConfig({
  plugins: [solid()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { target: "es2022", cssCodeSplit: false },
});
