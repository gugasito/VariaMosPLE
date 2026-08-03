const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSplHttpHandler } = require("../dist/SplHttpServer.js");

const eventPortalRoot = path.resolve(__dirname, "../../../contracts/examples/event-portal");
const workspaceRoot = path.resolve(__dirname, "../../..");
const externalTemplateRoot = path.join(workspaceRoot, "examples/external-project-onboarding");

function startEventPortalServer() {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-event-portal-http-test-"));
  const server = http.createServer(
    createSplHttpHandler({
      catalogPath: path.join(eventPortalRoot, "catalogs/static.local.json"),
      targetPath: path.join(eventPortalRoot, "targets/static.local.json"),
      gitRepositories: {},
      outputRoot: "/tmp/variamos-spl-event-portal-http-products",
      releaseStateDirectory: "/tmp/variamos-spl-event-portal-http-releases",
      deploymentPort: 18089,
      modelVersion: "event-portal-feature-model.v1",
      resourceRegistryPath: path.join(eventPortalRoot, "registry.local.json"),
      externalProjectStateDirectory: path.join(stateDirectory, "external"),
      projectDescriptorSchemaPath: path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
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
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "spl-test@variamos.local"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "VariaMos SPL tests"]);
  execFileSync("git", ["-C", repositoryPath, "add", "."]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-m", "external project fixture"]);
  return { temporaryRoot, repositoryPath };
}

function startExternalProjectServer(stateDirectory) {
  const server = http.createServer(
    createSplHttpHandler({
      catalogPath: path.join(eventPortalRoot, "catalogs/static.local.json"),
      targetPath: path.join(eventPortalRoot, "targets/static.local.json"),
      gitRepositories: {},
      outputRoot: path.join(stateDirectory, "products"),
      releaseStateDirectory: path.join(stateDirectory, "releases"),
      externalProjectStateDirectory: path.join(stateDirectory, "external"),
      projectDescriptorSchemaPath: path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
      allowLocalGitRepositories: true,
      allowLocalDirectories: true,
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
      { name: "mapping_schema", value: "spl-deployment-mapping/v1" },
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
    type: "SPL Deployment Mapping v1",
    name: "External mapping",
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
        path: options.path || "/api/spl/v1/derivations",
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

test("rejects origins that are not allowed", async () => {
  const server = await startEventPortalServer();
  try {
    const response = await request(server, {
      headers: { origin: "https://untrusted.example" },
      body: {},
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /origin is not authorized/i);
  } finally {
    await stopServer(server);
  }
});

test("plans and builds the Event Portal from separate feature and mapping models", async () => {
  const server = await startEventPortalServer();
  try {
    const featureModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/feature-model.json"), "utf8"));
    const mappingModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/mapping.static.json"), "utf8"));
    const plan = await request(server, {
      body: { action: "plan", projectId: "event-portal-project", productLineId: "event-portal", configurationRef: { id: "conference-presential", name: "In-person conference" }, featureModel, mappingModel },
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

test("publishes SPL profiles without leaking registry paths, ports, or secrets", async () => {
  const server = await startEventPortalServer();
  try {
    const response = await request(server, { method: "GET", path: "/api/spl/v1/profiles" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.schemaVersion, "spl-profile-index/v1");
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

test("rejects a feature configuration that violates the XOR group before planning", async () => {
  const server = await startEventPortalServer();
  try {
    const featureModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/feature-model.json"), "utf8"));
    featureModel.elements.find((element) => element.id === "feature-source-presential").properties[0].value = "Unselected";
    const mappingModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/mapping.static.json"), "utf8"));
    const response = await request(server, {
      body: { action: "plan", projectId: "event-portal-project", productLineId: "event-portal", featureModel, mappingModel },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.body.error, /XOR group/i);
  } finally {
    await stopServer(server);
  }
});

test("connects, imports, and builds an external Git repository with a v1 descriptor", async () => {
  const fixture = createExternalGitRepository();
  const server = await startExternalProjectServer(fixture.temporaryRoot);
  try {
    const providers = await request(server, { method: "GET", path: "/api/spl/v1/providers" });
    assert.equal(providers.statusCode, 200);
    assert.deepEqual(providers.body.providers.map((provider) => provider.id), [
      "git-remote",
      "git-local",
      "local-directory",
    ]);
    assert.equal(providers.body.providers.find((provider) => provider.id === "git-remote").availability, "available");
    assert.equal(providers.body.providers.find((provider) => provider.id === "git-local").availability, "available");
    assert.equal(providers.body.providers.find((provider) => provider.id === "local-directory").availability, "available");
    assert.equal(providers.body.providers.filter((provider) => provider.availability === "development").length, 0);

    const template = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "public/templates/spl.json"), "utf8"));
    const templateCheck = await request(server, {
      path: "/api/spl/v1/descriptors/validate",
      body: { descriptor: template, requireReady: true },
    });
    assert.equal(templateCheck.statusCode, 200);
    assert.deepEqual(templateCheck.body, { valid: true, errors: [] });

    const retiredGenerator = await request(server, {
      path: "/api/spl/v1/descriptors/draft",
      body: { featureModel: { id: "no-longer-used" } },
    });
    assert.equal(retiredGenerator.statusCode, 404);

    const incompatibleCheck = await request(server, {
      path: "/api/spl/v1/descriptors/validate",
      body: {
        descriptor: {
          ...template,
          profiles: [{
            ...template.profiles[0],
            testAdapter: "node-test-v1",
          }],
        },
        requireReady: true,
      },
    });
    assert.equal(incompatibleCheck.statusCode, 422);
    assert.match(incompatibleCheck.body.errors.join("\n"), /requires test adapter 'html-validation-v1'/);

    const incompleteProfileCheck = await request(server, {
      path: "/api/spl/v1/descriptors/validate",
      body: {
        descriptor: {
          ...template,
          profiles: [{
            ...template.profiles[0],
            artifactIds: ["external-event-portal.agenda"],
          }],
        },
        requireReady: true,
      },
    });
    assert.equal(incompleteProfileCheck.statusCode, 422);
    assert.match(incompleteProfileCheck.body.errors.join("\n"), /not its dependency 'external-event-portal\.shell'/);

    const incompatibleArtifactCheck = await request(server, {
      path: "/api/spl/v1/descriptors/validate",
      body: {
        descriptor: {
          ...template,
          artifacts: template.artifacts.map((artifact, index) =>
            index === 0 ? { ...artifact, kind: "container-image" } : artifact
          ),
        },
        requireReady: true,
      },
    });
    assert.equal(incompatibleArtifactCheck.statusCode, 422);
    assert.match(incompatibleArtifactCheck.body.errors.join("\n"), /does not support type 'container-image'/);

    const connectionBody = {
      id: "external-event-portal",
      provider: "git",
      repositoryUrl: fixture.repositoryPath,
      requestedRef: "main",
      descriptorPath: ".variamos/spl.json",
    };
    const validation = await request(server, { path: "/api/spl/v1/connections/validate", body: connectionBody });
    assert.equal(validation.statusCode, 200);
    assert.match(validation.body.connection.resolvedCommit, /^[a-f0-9]{40}$/);
    assert.equal(validation.body.descriptor.project.id, "external-event-portal");
    assert.equal(JSON.stringify(validation.body).includes("checkoutPath"), false);

    const staleConnection = await request(server, {
      path: "/api/spl/v1/connections",
      body: {
        ...connectionBody,
        expectedResolvedCommit: "0".repeat(40),
        expectedDescriptorDigest: validation.body.connection.descriptorDigest,
      },
    });
    assert.equal(staleConnection.statusCode, 422);

    const connection = await request(server, {
      path: "/api/spl/v1/connections",
      body: {
        ...connectionBody,
        expectedResolvedCommit: validation.body.connection.resolvedCommit,
        expectedDescriptorDigest: validation.body.connection.descriptorDigest,
      },
    });
    assert.equal(connection.statusCode, 200);
    const imported = await request(server, {
      path: "/api/spl/v1/imports",
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

    const localProjectRoot = path.join(fixture.temporaryRoot, "local-project");
    fs.cpSync(externalTemplateRoot, localProjectRoot, { recursive: true });
    const localConnectionBody = {
      id: "external-local-project",
      provider: "local",
      rootPath: localProjectRoot,
      descriptorPath: ".variamos/spl.json",
      snapshotPolicy: "content-digest-v1",
    };
    const localValidation = await request(server, {
      path: "/api/spl/v1/connections/validate",
      body: localConnectionBody,
    });
    assert.equal(localValidation.statusCode, 200);
    assert.match(localValidation.body.connection.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(localValidation.body).includes("snapshotPath"), false);

    fs.appendFileSync(
      path.join(localProjectRoot, "artifacts/shell.html"),
      "\n<!-- change after preview -->\n"
    );
    const staleLocalConnection = await request(server, {
      path: "/api/spl/v1/connections",
      body: {
        ...localConnectionBody,
        expectedSnapshotDigest: localValidation.body.connection.snapshotDigest,
        expectedDescriptorDigest: localValidation.body.connection.descriptorDigest,
      },
    });
    assert.equal(staleLocalConnection.statusCode, 422);
    assert.match(staleLocalConnection.body.error, /changed after the preview/i);

    fs.cpSync(externalTemplateRoot, localProjectRoot, { recursive: true, force: true });
    const refreshedLocalValidation = await request(server, {
      path: "/api/spl/v1/connections/validate",
      body: localConnectionBody,
    });
    const localConnection = await request(server, {
      path: "/api/spl/v1/connections",
      body: {
        ...localConnectionBody,
        expectedSnapshotDigest: refreshedLocalValidation.body.connection.snapshotDigest,
        expectedDescriptorDigest: refreshedLocalValidation.body.connection.descriptorDigest,
      },
    });
    assert.equal(localConnection.statusCode, 200);
    const localImported = await request(server, {
      path: "/api/spl/v1/imports",
      body: { connectionId: localConnectionBody.id, profileId: "external-event-portal.static" },
    });
    assert.equal(localImported.statusCode, 201);
    assert.equal(localImported.body.provenance.provider, "local");
    assert.equal(
      localImported.body.provenance.snapshotDigest,
      localConnection.body.connection.snapshotDigest
    );

    const localMappingModel = externalMapping(featureModel, localImported.body);
    const localPlan = await request(server, {
      body: {
        action: "plan",
        projectId: "external-local-event-project",
        productLineId: "external-event-portal",
        featureModel,
        mappingModel: localMappingModel,
      },
    });
    assert.equal(localPlan.statusCode, 200);
    const localBuild = await request(server, {
      body: {
        action: "build",
        projectId: "external-local-event-project",
        productLineId: "external-event-portal",
        featureModel,
        mappingModel: localMappingModel,
        expectedPlanDigest: localPlan.body.planDigest,
      },
    });
    assert.equal(localBuild.statusCode, 200);
    assert.equal(localBuild.body.tests.status, "passed");
  } finally {
    await stopServer(server);
    fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
