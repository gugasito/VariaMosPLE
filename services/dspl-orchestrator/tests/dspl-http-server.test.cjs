const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDsplHttpHandler } = require("../dist/DsplHttpServer.js");

const eventPortalRoot = path.resolve(__dirname, "../../../contracts/examples/event-portal");
const workspaceRoot = path.resolve(__dirname, "../../..");
const externalTemplateRoot = path.join(workspaceRoot, "examples/external-project-onboarding");

function startEventPortalServer() {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-event-portal-http-test-"));
  const server = http.createServer(
    createDsplHttpHandler({
      catalogPath: path.join(eventPortalRoot, "catalogs/static.local.json"),
      targetPath: path.join(eventPortalRoot, "targets/static.local.json"),
      gitRepositories: {},
      outputRoot: "/tmp/variamos-dspl-event-portal-http-products",
      releaseStateDirectory: "/tmp/variamos-dspl-event-portal-http-releases",
      deploymentPort: 18089,
      modelVersion: "event-portal-feature-model.v1",
      resourceRegistryPath: path.join(eventPortalRoot, "registry.local.json"),
      externalProjectStateDirectory: path.join(stateDirectory, "external"),
      allowedOrigins: ["http://127.0.0.1:3000"],
    })
  );
  server.testStateDirectory = stateDirectory;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function createExternalGitRepository() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-external-project-test-"));
  const repositoryPath = path.join(temporaryRoot, "project");
  fs.cpSync(externalTemplateRoot, repositoryPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "dspl-test@variamos.local"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "VariaMos DSPL tests"]);
  execFileSync("git", ["-C", repositoryPath, "add", "."]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-m", "external project fixture"]);
  return { temporaryRoot, repositoryPath };
}

function startExternalProjectServer(stateDirectory) {
  const server = http.createServer(
    createDsplHttpHandler({
      catalogPath: path.join(eventPortalRoot, "catalogs/static.local.json"),
      targetPath: path.join(eventPortalRoot, "targets/static.local.json"),
      gitRepositories: {},
      outputRoot: path.join(stateDirectory, "products"),
      releaseStateDirectory: path.join(stateDirectory, "releases"),
      externalProjectStateDirectory: path.join(stateDirectory, "external"),
      projectDescriptorSchemaPath: path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
      allowLocalGitRepositories: true,
      deploymentPort: 18092,
      modelVersion: "event-portal-feature-model.v1",
      resourceRegistryPath: path.join(workspaceRoot, "contracts/resource-registry.local.json"),
      allowedOrigins: ["http://127.0.0.1:3000"],
    })
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function externalMapping(featureModel, importedProfile) {
  const assignments = {
    "feature-source-portal": ["external-event-portal.shell"],
    "feature-source-agenda": ["external-event-portal.agenda"],
    "feature-source-registration": ["external-event-portal.registration.ui", "external-event-portal.registration.confirmation"],
    "feature-source-notifications": ["external-event-portal.notifications"],
    "feature-source-presential": ["external-event-portal.presential"],
    "feature-source-venue-map": ["external-event-portal.venue-map"],
  };
  const selectedFeatures = featureModel.elements.filter((element) =>
    element.properties?.some((property) => property.name === "Selected" && property.value === "Selected")
  );
  const root = {
    id: "external-mapping-root",
    type: "DeploymentMapping",
    name: importedProfile.name,
    properties: [
      { name: "mapping_schema", value: "dspl-deployment-mapping/v1" },
      { name: "mapping_ref", value: importedProfile.mappingRef },
      { name: "catalog_ref", value: importedProfile.catalogRef },
      { name: "target_ref", value: importedProfile.targetRef },
    ],
  };
  const bindings = selectedFeatures.map((feature) => ({
    id: `binding-${feature.id}`,
    type: "FeatureBinding",
    name: `Binding ${feature.name}`,
    properties: [
      { name: "source_feature_id", value: feature.id },
      { name: "feature_ref", value: `feature.external.${feature.id.replace(/^feature-source-/, "")}` },
    ],
  }));
  const artifacts = importedProfile.artifacts.map((artifact) => ({
    id: `artifact-${artifact.id.replace(/\./g, "-")}`,
    type: "SoftwareArtifact",
    name: artifact.id,
    properties: [{ name: "artifact_ref", value: artifact.id }],
  }));
  const artifactByRef = new Map(artifacts.map((artifact) => [artifact.properties[0].value, artifact]));
  const relationships = bindings.flatMap((binding) => {
    const featureId = binding.properties.find((property) => property.name === "source_feature_id").value;
    return (assignments[featureId] || []).map((artifactRef) => ({
      id: `implements-${binding.id}-${artifactRef.replace(/\./g, "-")}`,
      type: "ImplementedBy",
      sourceId: binding.id,
      targetId: artifactByRef.get(artifactRef).id,
      properties: [],
    }));
  });
  return {
    id: "external-project-mapping",
    type: "DSPL Deployment Mapping v1",
    name: "Mapping externo",
    sourceModelIds: [featureModel.id],
    elements: [root, ...bindings, ...artifacts],
    relationships,
  };
}

function request(server, options) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = options.body ? JSON.stringify(options.body) : undefined;
    const request = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method || "POST",
        path: options.path || "/api/dspl/v1/derivations",
        headers: {
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...(options.headers || {}),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: raw ? JSON.parse(raw) : undefined,
          });
        });
      }
    );
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => server.close((error) => {
    if (server.testStateDirectory) {
      fs.rmSync(server.testStateDirectory, { recursive: true, force: true });
    }
    error ? reject(error) : resolve();
  }));
}

test("rechaza orígenes que no estén permitidos", async () => {
  const server = await startEventPortalServer();
  try {
    const response = await request(server, {
      headers: { origin: "https://untrusted.example" },
      body: {},
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /origen no está autorizado/i);
  } finally {
    await stopServer(server);
  }
});

test("planifica y construye Portal de Eventos desde feature model y mapping separados", async () => {
  const server = await startEventPortalServer();
  try {
    const featureModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/feature-model.json"), "utf8"));
    const mappingModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/mapping.static.json"), "utf8"));
    const plan = await request(server, {
      body: { action: "plan", projectId: "event-portal-project", productLineId: "event-portal", configurationRef: { id: "conference-presential", name: "Conferencia presencial" }, featureModel, mappingModel },
    });
    assert.equal(plan.statusCode, 200);
    assert.match(plan.body.planDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(plan.body.profile.mappingRef, "mapping.event-portal.static.v1");
    assert.equal(plan.body.manifest.artifacts.some((artifact) => artifact.id === "event-portal.static.virtual"), false);

    const build = await request(server, {
      body: { action: "build", projectId: "event-portal-project", productLineId: "event-portal", featureModel, mappingModel, expectedPlanDigest: plan.body.planDigest },
    });
    assert.equal(build.statusCode, 200);
    assert.equal(build.body.tests.status, "passed");
  } finally {
    await stopServer(server);
  }
});

test("publica perfiles DSPL sin filtrar rutas, puertos ni secretos del registro", async () => {
  const server = await startEventPortalServer();
  try {
    const response = await request(server, { method: "GET", path: "/api/dspl/v1/profiles" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.schemaVersion, "dspl-profile-index/v1");
    assert.deepEqual(response.body.profiles.map((profile) => profile.id).sort(), [
      "event-portal.monolith.local",
      "event-portal.static.local",
    ]);
    assert.equal(response.body.profiles[0].artifacts.every((artifact) => Object.keys(artifact).every((key) => ["id", "kind", "version"].includes(key))), true);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("sourceLocation"), false);
    assert.equal(serialized.includes("releaseState"), false);
    assert.equal(serialized.includes(":8089"), false);
    assert.equal(serialized.includes(":8091"), false);
  } finally {
    await stopServer(server);
  }
});

test("rechaza una configuración de features que viola el grupo XOR antes de planificar", async () => {
  const server = await startEventPortalServer();
  try {
    const featureModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/feature-model.json"), "utf8"));
    featureModel.elements.find((element) => element.id === "feature-source-presential").properties[0].value = "Unselected";
    const mappingModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/mapping.static.json"), "utf8"));
    const response = await request(server, {
      body: { action: "plan", projectId: "event-portal-project", productLineId: "event-portal", featureModel, mappingModel },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.body.error, /grupo XOR/i);
  } finally {
    await stopServer(server);
  }
});

test("conecta, importa y construye un repositorio Git externo con descriptor v1", async () => {
  const fixture = createExternalGitRepository();
  const server = await startExternalProjectServer(fixture.temporaryRoot);
  try {
    const providers = await request(server, { method: "GET", path: "/api/dspl/v1/providers" });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.body.providers[0].id, "git");

    const draft = await request(server, {
      path: "/api/dspl/v1/descriptors/draft",
      body: {
        projectId: "conference-platform",
        projectName: "Conference Platform",
        features: [{ id: "feature.registration", name: "Inscripción" }],
      },
    });
    assert.equal(draft.statusCode, 200);
    assert.equal(draft.body.validation.valid, true);
    assert.equal(draft.body.descriptor.artifacts.length, 0);
    assert.equal(draft.body.descriptor.artifactProposals.length, 1);
    assert.equal(draft.body.descriptor.artifactProposals[0].featureId, "feature.registration");
    assert.equal(JSON.stringify(draft.body.descriptor.artifactProposals).includes("path"), false);
    assert.equal(draft.body.descriptor.pending.some((item) => item.kind === "path"), true);

    const connectionBody = {
      id: "external-event-portal",
      provider: "git",
      repositoryUrl: fixture.repositoryPath,
      requestedRef: "main",
      descriptorPath: ".variamos/dspl.json",
    };
    const validation = await request(server, { path: "/api/dspl/v1/connections/validate", body: connectionBody });
    assert.equal(validation.statusCode, 200);
    assert.match(validation.body.connection.resolvedCommit, /^[a-f0-9]{40}$/);
    assert.equal(validation.body.descriptor.project.id, "external-event-portal");
    assert.equal(JSON.stringify(validation.body).includes("checkoutPath"), false);

    const staleConnection = await request(server, {
      path: "/api/dspl/v1/connections",
      body: {
        ...connectionBody,
        expectedResolvedCommit: "0".repeat(40),
        expectedDescriptorDigest: validation.body.connection.descriptorDigest,
      },
    });
    assert.equal(staleConnection.statusCode, 422);

    const connection = await request(server, {
      path: "/api/dspl/v1/connections",
      body: {
        ...connectionBody,
        expectedResolvedCommit: validation.body.connection.resolvedCommit,
        expectedDescriptorDigest: validation.body.connection.descriptorDigest,
      },
    });
    assert.equal(connection.statusCode, 200);
    const imported = await request(server, {
      path: "/api/dspl/v1/imports",
      body: { connectionId: connectionBody.id, profileId: "external-event-portal.static" },
    });
    assert.equal(imported.statusCode, 201);
    assert.equal(imported.body.artifacts.length, 7);
    assert.equal(imported.body.provenance.resolvedCommit, connection.body.connection.resolvedCommit);

    const featureModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/feature-model.json"), "utf8"));
    const mappingModel = externalMapping(featureModel, imported.body);
    const plan = await request(server, {
      body: { action: "plan", projectId: "external-event-project", productLineId: "external-event-portal", featureModel, mappingModel },
    });
    assert.equal(plan.statusCode, 200);
    assert.equal(plan.body.manifest.artifacts.length, 7);
    const build = await request(server, {
      body: { action: "build", projectId: "external-event-project", productLineId: "external-event-portal", featureModel, mappingModel, expectedPlanDigest: plan.body.planDigest },
    });
    assert.equal(build.statusCode, 200);
    assert.equal(build.body.tests.status, "passed");
  } finally {
    await stopServer(server);
    fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
