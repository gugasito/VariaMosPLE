import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { enabledFeatures, portalModules } from "./generated/registry";

const manifestId = process.env.SPL_MANIFEST_ID || "unknown-manifest";
const dataDirectory = process.env.SPL_DATA_DIRECTORY || "/data";
const port = Number(process.env.PORT || "3000");

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error("Payload is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_error) {
        reject(new Error("Invalid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function persistRegistration(registration: Record<string, unknown>): void {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const fileName = path.join(dataDirectory, "registrations.json");
  const current = fs.existsSync(fileName) ? JSON.parse(fs.readFileSync(fileName, "utf8")) : [];
  fs.writeFileSync(fileName, `${JSON.stringify([...current, registration], null, 2)}\n`, "utf8");
}

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://localhost");
  if (method === "GET" && url.pathname === "/health") {
    send(response, 200, { status: "ok", manifestId, featureCount: enabledFeatures.length });
    return;
  }
  if (method === "GET" && url.pathname === "/api/features") {
    send(response, 200, { manifestId, features: enabledFeatures });
    return;
  }
  if (method === "GET" && url.pathname === "/") {
    const sections = portalModules.map((module) => module.render()).join("\n");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><body><main><h1>Event Portal</h1><p data-manifest-id="${manifestId}">Derived modular monolith.</p>${sections}</main></body></html>`);
    return;
  }
  if (method === "POST") {
    try {
      const body = await readBody(request);
      for (const module of portalModules) {
        const result = await module.handle?.(request, body);
        if (result) {
          if (url.pathname === "/api/registrations" && result.status === 201) persistRegistration(result.body);
          send(response, result.status, result.body);
          return;
        }
      }
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
      return;
    }
  }
  send(response, 404, { error: "Route is not enabled for this configuration." });
});

server.listen(port, "0.0.0.0", () => console.log(`Event Portal ready on ${port}`));
