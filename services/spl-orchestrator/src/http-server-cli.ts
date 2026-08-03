import http from "http";
import {
  createSplHttpHandler,
  createLocalSplHttpServerConfig,
} from "./SplHttpServer";

const port = Number(process.env.SPL_ORCHESTRATOR_PORT || "8090");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("SPL_ORCHESTRATOR_PORT must be a port between 1024 and 65535.");
}

const server = http.createServer(createSplHttpHandler(createLocalSplHttpServerConfig()));
server.listen(port, "127.0.0.1", () => {
  console.log(`SPL Orchestrator available at http://127.0.0.1:${port}`);
});
