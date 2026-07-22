const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { DsplMappingModelAdapter } = require("../dist/adapters/variamos/DsplMappingModelAdapter.js");
const { DerivationResolver } = require("../dist/DerivationResolver.js");

const root = path.resolve(__dirname, "../../../contracts/examples/event-portal");
const load = (fileName) => JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));

test("adapta un feature model y un mapping separado a bindings compuestos", () => {
  const catalog = load("catalogs/monolith.local.json");
  const featureModel = load("models/feature-model.json");
  const mappingModel = load("models/mapping.monolith.json");
  const output = new DsplMappingModelAdapter().adapt(featureModel, mappingModel, {
    catalog,
    configurationId: "event-portal.configuration.test",
    productLineId: "event-portal",
    modelVersion: "event-portal-feature-model.v1",
  });

  const registration = output.bindings.bindings.find((binding) => binding.featureId === "feature.event.registration");
  assert.equal(registration.actions.length, 4);
  assert.deepEqual(
    registration.actions.map((action) => action.artifactId),
    [
      "event-portal.monolith.registration.api",
      "event-portal.monolith.registration.schema",
      "event-portal.monolith.registration.tests",
      "event-portal.monolith.registration.ui",
    ]
  );

  const manifest = new DerivationResolver().resolve({
    catalog,
    bindings: output.bindings,
    configuration: output.configuration,
    target: load("targets/monolith.local.json"),
    sourceModel: { projectId: "event-portal-project", modelId: featureModel.id, version: "event-portal-feature-model.v1" },
  });
  assert.equal(manifest.verification[0].path, "/health");
  assert.equal(manifest.artifacts.some((artifact) => artifact.id === "event-portal.monolith.virtual"), false);
});

test("rechaza una feature seleccionada que no posee FeatureBinding", () => {
  const catalog = load("catalogs/static.local.json");
  const featureModel = load("models/feature-model.json");
  const mappingModel = load("models/mapping.static.json");
  mappingModel.elements = mappingModel.elements.filter((element) => element.id !== "binding-agenda");
  mappingModel.relationships = mappingModel.relationships.filter((relationship) => relationship.sourceId !== "binding-agenda");

  assert.throws(
    () => new DsplMappingModelAdapter().adapt(featureModel, mappingModel, {
      catalog,
      configurationId: "event-portal.configuration.test",
      productLineId: "event-portal",
      modelVersion: "event-portal-feature-model.v1",
    }),
    /no posee FeatureBinding/
  );
});
