const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  NginxContainerDeployer,
  NginxContainerDeploymentError,
} = require("../dist/adapters/deployers/NginxContainerDeployer.js");

class FakeDocker {
  constructor() {
    this.calls = [];
    this.containers = new Map();
    this.failNextRun = false;
  }

  run(args) {
    this.calls.push(args);
    const command = args[0];

    if (command === "version") {
      return "27.0.0";
    }
    if (command === "inspect") {
      const name = args[args.length - 1];
      const container = this.containers.get(name);
      if (!container) {
        throw new Error(`container '${name}' not found`);
      }
      return args.includes("{{.State.Running}}") ? String(container.running) : container.id;
    }
    if (command === "run") {
      if (this.failNextRun) {
        this.failNextRun = false;
        throw new Error("simulated docker run failure");
      }
      const name = args[args.indexOf("--name") + 1];
      this.containers.set(name, { id: `container-${name}`, running: true });
      return `container-${name}`;
    }
    if (command === "stop") {
      const name = args[1];
      const container = this.containers.get(name);
      if (!container) {
        throw new Error(`container '${name}' not found`);
      }
      container.running = false;
      return name;
    }
    if (command === "start") {
      const name = args[1];
      const container = this.containers.get(name);
      if (!container) {
        throw new Error(`container '${name}' not found`);
      }
      container.running = true;
      return name;
    }
    if (command === "rm") {
      this.containers.delete(args[args.length - 1]);
      return args[args.length - 1];
    }
    if (command === "image" && args[1] === "inspect") {
      return "sha256:nginx-fixture-image";
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  }
}

function createManifest(suffix = "001") {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: "spl-deployment-manifest/v1",
    manifestId: `manifest.external-project.configuration-${suffix}`,
    product: { id: "external-project", configurationId: `configuration-${suffix}` },
    sourceModel: {
      projectId: "project.external",
      modelId: "model.external",
      version: "1",
    },
    features: [{ id: "feature.card", selected: true }],
    artifacts: [{ id: "artifact.card", version: "1.0.0", digest }],
    operations: [
      { type: "generate", adapter: "static-site-v1" },
      { type: "build", adapter: "static-site-v1" },
      { type: "test", adapter: "html-validation-v1" },
      { type: "deploy", adapter: "nginx-container-v1" },
      { type: "verify", adapter: "http-health-check-v1" },
    ],
    target: { id: "lab-local", credentialsRef: "secret://deployment/lab-local/docker" },
    verification: [{ type: "http-health-check", path: "/" }],
    rollback: { strategy: "previous-successful-release" },
  };
}

function writeDistribution(directory, manifest) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "index.html"),
    `<main data-manifest-id="${manifest.manifestId}">External project</main>\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(directory, "build-metadata.json"),
    JSON.stringify(
      {
        manifestId: manifest.manifestId,
        productId: manifest.product.id,
        artifactCount: manifest.artifacts.length,
        artifacts: manifest.artifacts.map((artifact) => ({
          id: artifact.id,
          digest: artifact.digest,
          bytes: 1,
          provider: "fixture",
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-spl-nginx-"));
  const dist = path.join(root, "dist");
  const state = path.join(root, "state");
  const docker = new FakeDocker();
  const healthRequests = [];
  const deployer = new NginxContainerDeployer({
    docker,
    healthChecker: async (request) => {
      healthRequests.push(request);
    },
  });

  return { root, dist, state, docker, healthRequests, deployer };
}

function deploymentRequest(fixture, manifest, port = 18088) {
  return {
    manifest,
    distributionDirectory: fixture.dist,
    stateDirectory: fixture.state,
    hostPort: port,
    healthCheckTimeoutMs: 100,
    healthCheckIntervalMs: 1,
  };
}

test("nginx-container-v1 publishes only on loopback and creates a traceable idempotent release", async () => {
  const fixture = createFixture();
  const manifest = createManifest();
  writeDistribution(fixture.dist, manifest);

  const first = await fixture.deployer.deploy(deploymentRequest(fixture, manifest));
  const second = await fixture.deployer.deploy(deploymentRequest(fixture, manifest));

  assert.equal(first.status, "deployed");
  assert.equal(second.status, "already-active");
  assert.equal(first.release.endpoint.url, "http://127.0.0.1:18088/");
  assert.equal(first.release.imageId, "sha256:nginx-fixture-image");
  assert.match(first.release.distribution.directory, /releases[\\/]release-[a-f0-9]{12}[\\/]site$/);
  assert.equal(
    fs.readFileSync(path.join(first.release.distribution.directory, "index.html"), "utf8"),
    fs.readFileSync(path.join(fixture.dist, "index.html"), "utf8")
  );
  assert.equal(fs.existsSync(first.statePath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.statePath, "utf8")).manifestId, manifest.manifestId);
  assert.equal(fixture.docker.calls.filter((args) => args[0] === "run").length, 1);

  const dockerRun = fixture.docker.calls.find((args) => args[0] === "run");
  assert.equal(dockerRun.includes("127.0.0.1:18088:80"), true);
  assert.equal(dockerRun.includes("--read-only"), true);
  assert.equal(dockerRun.includes("--privileged"), false);
  assert.equal(dockerRun.join(" ").includes("secret://"), false);
  assert.deepEqual(
    fixture.healthRequests.map((request) => request.expectedManifestId),
    [manifest.manifestId, manifest.manifestId]
  );
});

test("nginx-container-v1 restores the previous release when the candidate does not start", async () => {
  const fixture = createFixture();
  const firstManifest = createManifest("001");
  writeDistribution(fixture.dist, firstManifest);
  const first = await fixture.deployer.deploy(deploymentRequest(fixture, firstManifest));

  const candidateManifest = createManifest("002");
  writeDistribution(fixture.dist, candidateManifest);
  fixture.docker.failNextRun = true;

  await assert.rejects(
    () => fixture.deployer.deploy(deploymentRequest(fixture, candidateManifest)),
    (error) => {
      assert.equal(error instanceof NginxContainerDeploymentError, true);
      assert.match(error.message, /simulated docker run failure/);
      assert.match(error.message, /restored the previous successful release/);
      return true;
    }
  );

  const active = JSON.parse(fs.readFileSync(first.statePath, "utf8"));
  assert.equal(active.manifestId, firstManifest.manifestId);
  assert.equal(fixture.docker.containers.get(first.release.containerName).running, true);
  assert.equal(
    fixture.docker.calls.some(
      (args) => args[0] === "start" && args[1] === first.release.containerName
    ),
    true
  );
});

test("nginx-container-v1 can explicitly restore the previous successful release", async () => {
  const fixture = createFixture();
  const firstManifest = createManifest("001");
  writeDistribution(fixture.dist, firstManifest);
  const first = await fixture.deployer.deploy(deploymentRequest(fixture, firstManifest));

  const secondManifest = createManifest("002");
  writeDistribution(fixture.dist, secondManifest);
  const second = await fixture.deployer.deploy(deploymentRequest(fixture, secondManifest));
  assert.match(
    fs.readFileSync(path.join(first.release.distribution.directory, "index.html"), "utf8"),
    new RegExp(firstManifest.manifestId)
  );
  const rollback = await fixture.deployer.rollback({
    targetId: "lab-local",
    stateDirectory: fixture.state,
    hostPort: 18088,
    healthCheckTimeoutMs: 100,
    healthCheckIntervalMs: 1,
  });

  assert.equal(rollback.status, "rolled-back");
  assert.equal(rollback.activeRelease.releaseId, first.release.releaseId);
  assert.equal(rollback.replacedRelease.releaseId, second.release.releaseId);
  assert.equal(JSON.parse(fs.readFileSync(rollback.statePath, "utf8")).manifestId, firstManifest.manifestId);
  assert.equal(fixture.docker.containers.get(first.release.containerName).running, true);
  assert.equal(fixture.docker.containers.get(second.release.containerName).running, false);
});

test("nginx-container-v1 rejects a directory that does not come from the specified manifest", async () => {
  const fixture = createFixture();
  const builtManifest = createManifest("001");
  const requestedManifest = createManifest("002");
  writeDistribution(fixture.dist, builtManifest);

  await assert.rejects(
    () => fixture.deployer.deploy(deploymentRequest(fixture, requestedManifest)),
    /build-metadata\.json does not match/
  );
  assert.equal(fixture.docker.calls.length, 0);
});
