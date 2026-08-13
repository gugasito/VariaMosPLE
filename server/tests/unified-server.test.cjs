const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createUnifiedServer } = require("../dist/main.js");

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body }));
    }).on("error", reject);
  });
}

test("the unified server serves React and SPL from one origin without API fallbacks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-unified-"));
  const buildDirectory = path.join(root, "build");
  fs.mkdirSync(buildDirectory, { recursive: true });
  fs.writeFileSync(path.join(buildDirectory, "index.html"), "<html>VariaMos React</html>");
  fs.writeFileSync(path.join(buildDirectory, "asset.txt"), "asset");
  const { app, splHandler } = createUnifiedServer({
    host: "127.0.0.1",
    port: 0,
    workspaceRoot: root,
    buildDirectory,
    spl: {
      outputRoot: path.join(root, "products"),
      releaseStateDirectory: path.join(root, "releases"),
      externalProjectStateDirectory: path.join(root, "imports"),
      secureStateDirectory: path.join(root, "secure"),
      auditFilePath: path.join(root, "audit", "events.jsonl"),
      auditSink: "file",
      secretBackend: "none",
      allowedOrigins: ["http://127.0.0.1"],
      resourceRegistryPath: undefined,
      authorizer: {
        async authorize() { return { userId: "owner", role: "owner", projectId: "project" }; },
        async reauthorize(actor) { return actor; },
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const health = await request(server, "/health");
    assert.equal(health.statusCode, 200);
    assert.match(health.body, /variamos-backend/);
    assert.equal((await request(server, "/asset.txt")).body, "asset");
    assert.match((await request(server, "/models/editor")).body, /VariaMos React/);
    const splUnknown = await request(server, "/api/spl/v1/not-a-route");
    assert.equal(splUnknown.statusCode, 404);
    assert.match(splUnknown.body, /SPL route not found/);
    const apiUnknown = await request(server, "/api/not-a-route");
    assert.equal(apiUnknown.statusCode, 404);
    assert.match(apiUnknown.body, /API route not found/);
  } finally {
    splHandler.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
