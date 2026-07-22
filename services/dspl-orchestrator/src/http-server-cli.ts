import http from "http";
import {
  createDsplHttpHandler,
  createLocalDsplHttpServerConfig,
} from "./DsplHttpServer";

const port = Number(process.env.DSPL_ORCHESTRATOR_PORT || "8090");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("DSPL_ORCHESTRATOR_PORT debe ser un puerto entre 1024 y 65535.");
}

const server = http.createServer(createDsplHttpHandler(createLocalDsplHttpServerConfig()));
server.listen(port, "127.0.0.1", () => {
  console.log(`DSPL Orchestrator disponible en http://127.0.0.1:${port}`);
});
