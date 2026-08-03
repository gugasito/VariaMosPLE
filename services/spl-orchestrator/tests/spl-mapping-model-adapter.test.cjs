const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { SplMappingModelAdapter } = require("../dist/adapters/variamos/SplMappingModelAdapter.js");
const { DerivationResolver } = require("../dist/DerivationResolver.js");

const root = path.resolve(__dirname, "../../../contracts/examples/event-portal");
const load = (fileName) => JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));

test("adapts a feature model and separate mapping into composite bindings", () => {
  const catalog = load("catalogs/monolith.local.json");
  const featureModel = load("models/feature-model.json");
  const mappingModel = load("models/mapping.monolith.json");
  const output = new SplMappingModelAdapter().adapt(featureModel, mappingModel, {
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

test("reads a historical mapping without republishing it as the canonical name", () => {
  const catalog = load("catalogs/static.local.json");
  const featureModel = load("models/feature-model.json");
  const mappingModel = load("models/mapping.static.json");
  mappingModel.type = "DSPL Deployment Mapping v1";
  mappingModel.elements
    .find((element) => element.type === "DeploymentMapping")
    .properties
    .find((property) => property.name === "mapping_schema").value = "dspl-deployment-mapping/v1";

  const output = new SplMappingModelAdapter().adapt(featureModel, mappingModel, {
    catalog,
    configurationId: "event-portal.configuration.legacy",
    productLineId: "event-portal",
    modelVersion: "event-portal-feature-model.v1",
  });

  assert.equal(output.bindings.schemaVersion, "feature-artifact-bindings/v1");
  assert.ok(output.bindings.bindings.length > 0);
});

test("rejects a selected feature without a FeatureBinding", () => {
  const catalog = load("catalogs/static.local.json");
  const featureModel = load("models/feature-model.json");
  const mappingModel = load("models/mapping.static.json");
  mappingModel.elements = mappingModel.elements.filter((element) => element.id !== "binding-agenda");
  mappingModel.relationships = mappingModel.relationships.filter((relationship) => relationship.sourceId !== "binding-agenda");

  assert.throws(
    () => new SplMappingModelAdapter().adapt(featureModel, mappingModel, {
      catalog,
      configurationId: "event-portal.configuration.test",
      productLineId: "event-portal",
      modelVersion: "event-portal-feature-model.v1",
    }),
    /has no FeatureBinding/
  );
});
