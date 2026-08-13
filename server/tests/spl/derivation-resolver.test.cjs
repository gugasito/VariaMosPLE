const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DerivationResolver,
  DerivationResolutionError,
} = require("../../dist/spl/DerivationResolver.js");
const {
  SplMappingModelAdapter,
} = require("../../dist/spl/adapters/variamos/SplMappingModelAdapter.js");

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
  const adapted = new SplMappingModelAdapter().adapt(featureModel, mappingModel, {
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

test("resolves a native mapping into a deterministic manifest without deploying", () => {
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

test("includes transitive dependencies before the artifact that requires them", () => {
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

test("rejects a selected feature without a binding", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  request.configuration.selections.push({
    featureId: "feature.sin-binding",
    selected: true,
  });

  expectResolutionError(() => resolver.resolve(request), /does not have a binding/);
});

test("rejects a target without the artifact capabilities", () => {
  const resolver = new DerivationResolver();
  const request = createRequest();
  request.target.capabilities = ["docker"];

  expectResolutionError(() => resolver.resolve(request), /does not provide capability 'static-http'/);
});

test("rejects dependency cycles", () => {
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

  expectResolutionError(() => resolver.resolve(request), /dependency cycle/);
});
