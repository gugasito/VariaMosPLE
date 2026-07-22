const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  NodeContainerDeployer,
} = require("../dist/adapters/deployers/NodeContainerDeployer.js");

class DockerDouble {
  constructor() {
    this.calls = [];
  }

  run(args) {
    this.calls.push(args);
    if (args[0] === "container" && args[1] === "inspect") throw new Error("not found");
    if (args[0] === "inspect") return "false";
    return "candidate-container";
  }
}

function fixtureManifest(id) {
  return {
    schemaVersion: "derivation-manifest/v1",
    manifestId: id,
    product: { id: "event-portal", configurationId: "event-portal.configuration.test" },
    target: { id: "event-portal.target.monolith.local", adapter: "node-container-v1", capabilities: [] },
    artifacts: [],
    features: [],
    operations: [{ id: "deploy", type: "deploy", adapter: "node-container-v1" }],
    verification: [{ type: "http-health-check", path: "/health" }],
  };
}

test("node-container-v1 deja una release trazable y exige el health del manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-node-deployer-"));
  const distribution = path.join(root, "distribution");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(distribution, "dist", "runtime"), { recursive: true });
  fs.writeFileSync(path.join(distribution, "dist", "runtime", "server.js"), "// runtime\n");
  const manifest = fixtureManifest("manifest.event-portal.node-deployer-test");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", manifestId: manifest.manifestId }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const docker = new DockerDouble();

  try {
    const result = await new NodeContainerDeployer(docker).deploy({
      manifest,
      distributionDirectory: distribution,
      stateDirectory: state,
      dataDirectory: data,
      hostPort: port,
      image: "node:test",
    });
    assert.equal(result.status, "deployed");
    assert.equal(result.release.endpoint.url, `http://127.0.0.1:${port}/health`);
    assert.equal(fs.existsSync(result.statePath), true);
    assert.equal(docker.calls.some((args) => args[0] === "run" && args.includes("--read-only")), true);
    assert.equal(docker.calls.some((args) => args.includes(`DSPL_MANIFEST_ID=${manifest.manifestId}`)), true);
    assert.equal(docker.calls.some((args) => args.includes(`variamos.dspl.target-id=${manifest.target.id}`)), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
