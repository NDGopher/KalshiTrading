import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/** Defaults so `pnpm dev` works without env (Windows .bat still sets these explicitly). */
const rawPort = process.env.PORT?.trim() || "5173";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

let basePath = process.env.BASE_PATH?.trim() || "/";
if (!basePath.startsWith("/")) basePath = `/${basePath}`;
if (basePath !== "/" && !basePath.endsWith("/")) basePath = `${basePath}/`;

const dashboardRoot = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(dashboardRoot, "..", "..");

export default defineConfig({
  base: basePath,
  /** Linked workspace package uses `export *` from a large orval file; pre-bundle can omit some named exports. */
  optimizeDeps: {
    exclude: ["@workspace/api-client-react"],
  },
  plugins: [
    react(),
    tailwindcss(),
    // Replit overlay uses inline styles; breaks under strict CSP (e.g. embedded preview browsers).
    ...(process.env.REPL_ID !== undefined ? [runtimeErrorOverlay()] : []),
    {
      name: "kalshi-dev-log",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          const a = server.httpServer?.address();
          if (a && typeof a === "object") {
            const host =
              a.address === "::" || a.address === "0.0.0.0" ? "localhost" : a.address === "::1" ? "localhost" : a.address;
            const origin = `http://${host}:${a.port}`;
            const href = basePath === "/" ? `${origin}/` : new URL(basePath.replace(/^\//, ""), `${origin}/`).href;
            console.info(`[dashboard] Vite ready → open ${href}`);
          }
        });
      },
    },
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    /** Fail if PORT is taken so we never silently jump to 5174 while .bat and API redirect expect 5173. */
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      // @workspace/* packages live under repo root (e.g. lib/api-client-react), outside this package.
      allow: [dashboardRoot, repoRoot],
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
