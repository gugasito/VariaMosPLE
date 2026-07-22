const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DerivationResolver,
  DerivationResolutionError,
} = require("../dist/DerivationResolver.js");
const {
  DsplMappingModelAdapter,
} = require("../dist/adapters/variamos/DsplMappingModelAdapter.js");

const examplesRoot = path.resolve(
  __dirname,
  "../../../contracts/examples/event-portal"
);

function loadJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(examplesRoot, fileName), "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRequest() {
  const catalog = loadJson("catalogs/static.local.json");
  const featureModel = loadJson("models/feature-model.json");
  const mappingModel = loadJson("models/mapping.static.json");
  const adapted = new DsplMappingModelAdapter().adapt(featureModel, mappingModel, {
    catalog,
    configurationId: "event-portal.configuration.test",
    productLineId: "event-portal",
    modelVersion: "event-portal-feature-model.v1",
  });
  return {
    catalog,
    bindings: adapted.bindings,
    configuration: adapted.configuration,
    target: loadJson("targets/static.local.json"),
    sourceModel: {
      projectId: "project.event-portal",
      modelId: featureModel.id,
      version: "event-portal-feature-model.v1",
    },
  };
}

function expectResolutionError(callback, expectedMessage) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof DerivationResolutionError, true);
    assert.match(error.diagnostics.join("\n"), expectedMessage);
    return true;
  });
}

test("resuelve un mapping propio en un manifest determinista sin ejecutar un deploy", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  const firstManifest = resolver.resolve(request);
  const secondManifest = resolver.resolve(clone(request));

  assert.deepEqual(firstManifest, secondManifest);
  assert.deepEqual(
    firstManifest.features.map((feature) => feature.id),
    [
      "feature.event.agenda",
      "feature.event.notifications",
      "feature.event.portal",
      "feature.event.presential",
      "feature.event.registration",
      "feature.event.venue-map",
    ]
  );
  assert.deepEqual(
    firstManifest.artifacts.map((artifact) => artifact.id),
    [
      "event-portal.static.agenda",
      "event-portal.static.notifications",
      "event-portal.static.presential",
      "event-portal.static.registration",
      "event-portal.static.shell",
      "event-portal.static.venue-map",
    ]
  );
  assert.deepEqual(firstManifest.operations, [
    { type: "generate", adapter: "static-site-v1" },
    { type: "build", adapter: "static-site-v1" },
    { type: "test", adapter: "html-validation-v1" },
    { type: "deploy", adapter: "nginx-container-v1" },
    { type: "verify", adapter: "http-health-check-v1" },
  ]);
});

test("incluye dependencias transitivas antes del artefacto que las requiere", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  const agenda = request.catalog.artifacts.find(
    (artifact) => artifact.id === "event-portal.static.agenda"
  );

  agenda.dependsOn = ["event-portal.static.shell"];
  request.configuration.selections.forEach((selection) => {
    selection.selected = selection.featureId === "feature.event.agenda";
  });

  const manifest = resolver.resolve(request);
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.id),
    ["event-portal.static.shell", "event-portal.static.agenda"]
  );
});

test("rechaza una feature seleccionada sin binding", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  request.configuration.selections.push({
    featureId: "feature.sin-binding",
    selected: true,
  });

  expectResolutionError(() => resolver.resolve(request), /no posee un binding/);
});

test("rechaza un target sin las capacidades de los artefactos", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  request.target.capabilities = ["docker"];

  expectResolutionError(() => resolver.resolve(request), /no tiene la capacidad 'static-http'/);
});

test("rechaza ciclos de dependencias", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  const agenda = request.catalog.artifacts.find(
    (artifact) => artifact.id === "event-portal.static.agenda"
  );
  const shell = request.catalog.artifacts.find(
    (artifact) => artifact.id === "event-portal.static.shell"
  );

  agenda.dependsOn = ["event-portal.static.shell"];
  shell.dependsOn = ["event-portal.static.agenda"];
  request.configuration.selections.forEach((selection) => {
    selection.selected = selection.featureId === "feature.event.agenda";
  });

  expectResolutionError(() => resolver.resolve(request), /ciclo de dependencias/);
});
