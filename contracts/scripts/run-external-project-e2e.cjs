/* E2E real del onboarding externo. Crea un repositorio Git independiente en
 * /tmp, lo conecta por la API, importa el descriptor y despliega en Docker
 * sobre un puerto loopback efímero. */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createDsplHttpHandler } = require("../../services/dspl-orchestrator/dist/DsplHttpServer.js");
const workspaceRoot = path.resolve(__dirname, "../..");
const templateRoot = path.join(workspaceRoot, "examples/external-project-onboarding");
const featureModelPath = path.join(workspaceRoot, "contracts/examples/event-portal/models/feature-model.json");

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function request(base, route, body, method = "POST") {
  return fetch(`${base}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => {
    const value = await response.json();
    if (!response.ok) throw new Error(`${route}: ${value.error || JSON.stringify(value)}`);
    return value;
  });
}

function createRepository(root) {
  const repositoryPath = path.join(root, "external-event-portal");
  fs.cpSync(templateRoot, repositoryPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "dspl-e2e@variamos.local"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "VariaMos DSPL E2E"]);
  execFileSync("git", ["-C", repositoryPath, "add", "."]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-m", "external project e2e"]);
  return repositoryPath;
}

function mappingFor(featureModel, profile) {
  const assignments = {
    "feature-source-portal": ["external-event-portal.shell"],
    "feature-source-agenda": ["external-event-portal.agenda"],
    "feature-source-registration": ["external-event-portal.registration.ui", "external-event-portal.registration.confirmation"],
    "feature-source-notifications": ["external-event-portal.notifications"],
    "feature-source-presential": ["external-event-portal.presential"],
    "feature-source-venue-map": ["external-event-portal.venue-map"],
  };
  const selected = featureModel.elements.filter((element) =>
    element.properties?.some((property) => property.name === "Selected" && property.value === "Selected")
  );
  const root = {
    id: "external-mapping-root", type: "DeploymentMapping", name: profile.name,
    properties: [
      { name: "mapping_schema", value: "dspl-deployment-mapping/v1" },
      { name: "mapping_ref", value: profile.mappingRef },
      { name: "catalog_ref", value: profile.catalogRef },
      { name: "target_ref", value: profile.targetRef },
    ],
  };
  const bindings = selected.map((feature) => ({
    id: `binding-${feature.id}`, type: "FeatureBinding", name: `Binding ${feature.name}`,
    properties: [
      { name: "source_feature_id", value: feature.id },
      { name: "feature_ref", value: `feature.external.${feature.id.replace(/^feature-source-/, "")}` },
    ],
  }));
  const artifacts = profile.artifacts.map((artifact) => ({
    id: `artifact-${artifact.id.replace(/\./g, "-")}`, type: "SoftwareArtifact", name: artifact.id,
    properties: [{ name: "artifact_ref", value: artifact.id }],
  }));
  const artifactByRef = new Map(artifacts.map((artifact) => [artifact.properties[0].value, artifact]));
  const relationships = bindings.flatMap((binding) => {
    const sourceId = binding.properties[0].value;
    return (assignments[sourceId] || []).map((artifactRef) => ({
      id: `implements-${binding.id}-${artifactRef.replace(/\./g, "-")}`,
      type: "ImplementedBy", sourceId: binding.id, targetId: artifactByRef.get(artifactRef).id, properties: [],
    }));
  });
  return {
    id: "external-project-mapping", type: "DSPL Deployment Mapping v1", name: "Mapping externo",
    sourceModelIds: [featureModel.id], elements: [root, ...bindings, ...artifacts], relationships,
  };
}

(async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-external-e2e-"));
  const repositoryPath = createRepository(temporaryRoot);
  const deploymentPort = await availablePort();
  const targetFile = "docker-static.local.json";
  fs.copyFileSync(path.join(workspaceRoot, "contracts/targets", targetFile), path.join(temporaryRoot, targetFile));
  const registryPath = path.join(temporaryRoot, "resource-registry.json");
  fs.writeFileSync(registryPath, `${JSON.stringify({
    schemaVersion: "dspl-resource-registry/v1",
    catalogs: {},
    targets: {
      "variamos.target.docker.static.local": {
        path: targetFile,
        port: deploymentPort,
        releaseState: "external-static",
      },
    },
    profiles: {},
  }, null, 2)}\n`);
  const server = http.createServer(createDsplHttpHandler({
    gitRepositories: {},
    outputRoot: path.join(temporaryRoot, "products"),
    releaseStateDirectory: path.join(temporaryRoot, "releases"),
    externalProjectStateDirectory: path.join(temporaryRoot, "state"),
    projectDescriptorSchemaPath: path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
    allowLocalGitRepositories: true,
    resourceRegistryPath: registryPath,
    allowedOrigins: ["http://127.0.0.1:3000"],
  }));
  let manifestId;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const apiPort = server.address().port;
    const base = `http://127.0.0.1:${apiPort}`;
    const connectionInput = {
      id: "external-event-portal", provider: "git", repositoryUrl: repositoryPath,
      requestedRef: "main", descriptorPath: ".variamos/dspl.json",
    };
    const preview = await request(base, "/api/dspl/v1/connections/validate", connectionInput);
    const connection = await request(base, "/api/dspl/v1/connections", {
      ...connectionInput,
      expectedResolvedCommit: preview.connection.resolvedCommit,
      expectedDescriptorDigest: preview.connection.descriptorDigest,
    });
    const profile = await request(base, "/api/dspl/v1/imports", {
      connectionId: connectionInput.id,
      profileId: "external-event-portal.static",
      targetRef: "variamos.target.docker.static.local",
    });
    const featureModel = JSON.parse(fs.readFileSync(featureModelPath, "utf8"));
    const mappingModel = mappingFor(featureModel, profile);
    const derivation = async (action, expectedPlanDigest) => request(base, "/api/dspl/v1/derivations", {
      action, projectId: "external-event-project", productLineId: "external-event-portal",
      featureModel, mappingModel, expectedPlanDigest,
    });
    const plan = await derivation("plan");
    manifestId = plan.manifest.manifestId;
    const build = await derivation("build", plan.planDigest);
    const deploy = await derivation("deploy", plan.planDigest);
    const product = await fetch(deploy.deployment.url);
    const html = await product.text();
    if (!product.ok || !html.includes("Agenda") || !html.includes("Inscripción")) {
      throw new Error("La release externa no contiene las capacidades aprobadas.");
    }
    console.log(JSON.stringify({
      status: "passed",
      repositoryCommit: connection.connection.resolvedCommit,
      descriptorDigest: connection.connection.descriptorDigest,
      manifestId: deploy.manifest.manifestId,
      planDigest: plan.planDigest,
      artifactCount: deploy.manifest.artifacts.length,
      tests: build.tests.status,
      url: deploy.deployment.url,
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (manifestId) {
      const containers = execFileSync("docker", ["ps", "-aq", "--filter", `label=variamos.dspl.manifest-id=${manifestId}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      if (containers.length) execFileSync("docker", ["rm", "-f", ...containers], { stdio: "ignore" });
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
