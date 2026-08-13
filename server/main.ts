import express from "express";
import http from "http";
import path from "path";
import { loadUnifiedServerConfig, UnifiedServerConfig } from "./config";
import { createSplHttpHandler, SplHttpHandler } from "./spl/SplHttpServer";

export function createUnifiedServer(config: UnifiedServerConfig): {
  app: express.Express;
  splHandler: SplHttpHandler;
} {
  const app = express();
  const splHandler = createSplHttpHandler(config.spl);
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "variamos-backend", spl: "ok" }));
  app.use((request, response, next) => {
    if (request.path === "/api/spl/v1" || request.path.startsWith("/api/spl/v1/")) {
      void splHandler(request, response);
      return;
    }
    next();
  });
  app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found." }));
  app.use(express.static(config.buildDirectory));
  app.get("*", (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.status(404).json({ error: "Route not found." });
      return;
    }
    response.sendFile(path.join(config.buildDirectory, "index.html"));
  });
  return { app, splHandler };
}

export function startUnifiedServer(config = loadUnifiedServerConfig()): http.Server {
  const { app, splHandler } = createUnifiedServer(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`VariaMos backend listening on http://${config.host}:${config.port}`);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    splHandler.shutdown();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (require.main === module) startUnifiedServer();
