import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

/** Development-only same-origin proxy. The browser never receives the runtime token. */
export function runtimeProxy(): Plugin {
  return {
    name: "todocue-isolated-runtime",
    configureServer(server) {
      server.middlewares.use("/__runtime", (req, res) => {
        const unavailable = (message: string) => {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "UNAVAILABLE", message } }));
        };
        try {
          const home =
            process.env.TODOCUE_HOME ??
            path.join(os.tmpdir(), "todocue-desktop-development");
          const connection = JSON.parse(
            fs.readFileSync(path.join(home, "connection.json"), "utf8"),
          );
          const base = new URL(connection.baseUrl);
          if (
            base.protocol !== "http:" ||
            base.hostname !== "127.0.0.1" ||
            base.pathname !== "/" ||
            !base.port ||
            base.username ||
            base.password
          )
            throw new Error("Invalid local runtime connection");
          if (
            req.headers.origin &&
            req.headers.origin !== "http://127.0.0.1:5173" &&
            req.headers.origin !== "http://localhost:5173"
          ) {
            res.statusCode = 403;
            res.end("Invalid development origin");
            return;
          }
          const raw = req.url ?? "";
          const apiPath = raw.split("?")[0]!;
          if (
            !/^\/v1\//.test(raw) ||
            raw.includes("\\") ||
            apiPath.includes("..") ||
            apiPath.includes("%") ||
            raw.includes("#")
          )
            throw new Error("Invalid API path");
          const upstream = http.request(
            {
              hostname: "127.0.0.1",
              port: base.port,
              path: raw,
              method: req.method,
              headers: {
                authorization: `Bearer ${connection.token}`,
                accept: req.headers.accept ?? "application/json",
                ...(req.headers["content-type"]
                  ? { "content-type": req.headers["content-type"] }
                  : {}),
                // Node does not add chunked framing to DELETE automatically.
                // Preserve the browser's body length for versioned delete actions.
                ...(req.headers["content-length"]
                  ? { "content-length": req.headers["content-length"] }
                  : req.headers["transfer-encoding"]
                    ? { "transfer-encoding": req.headers["transfer-encoding"] }
                    : {}),
                ...(req.headers["last-event-id"]
                  ? { "last-event-id": req.headers["last-event-id"] }
                  : {}),
                ...(req.headers["idempotency-key"]
                  ? { "idempotency-key": req.headers["idempotency-key"] }
                  : {}),
              },
            },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", (error) => {
            if (!res.headersSent) unavailable(error.message);
            else res.end();
          });
          res.on("close", () => upstream.destroy());
          req.pipe(upstream);
        } catch (error) {
          unavailable(error instanceof Error ? error.message : String(error));
        }
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), tailwindcss(), runtimeProxy()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: {
    target: "es2023",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom/client"],
          motion: ["motion/react"],
          contracts: ["@todocue/shared", "@todocue/client"],
        },
      },
    },
  },
});
