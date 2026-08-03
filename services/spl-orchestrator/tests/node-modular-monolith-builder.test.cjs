const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SplMappingModelAdapter } = require("../dist/adapters/variamos/SplMappingModelAdapter.js");
const { DerivationResolver } = require("../dist/DerivationResolver.js");
const { NodeModularMonolithBuilder } = require("../dist/adapters/builders/NodeModularMonolithBuilder.js");
const { NodeTestAdapter } = require("../dist/adapters/tests/NodeTestAdapter.js");
const { ArtifactProviderRegistry } = require("../dist/adapters/providers/ArtifactProvider.js");
const { LocalArtifactProvider } = require("../dist/adapters/providers/LocalArtifactProvider.js");

const root = path.resolve(__dirname, "../../../contracts/examples/event-portal");
const load = (fileName) => JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));

test("assembles and tests a modular monolith from verified artifacts", () => {
  const catalog = load("catalogs/monolith.local.json");
  const featureModel = load("models/feature-model.json");
  const mappingModel = load("models/mapping.monolith.json");
  const adapted = new SplMappingModelAdapter().adapt(featureModel, mappingModel, {
    catalog,
    configurationId: "event-portal.configuration.test",
    productLineId: "event-portal",
    modelVersion: "event-portal-feature-model.v1",
  });
  const manifest = new DerivationResolver().resolve({
    catalog,
    bindings: adapted.bindings,
    configuration: adapted.configuration,
    target: load("targets/monolith.local.json"),
    sourceModel: { projectId: "event-portal-project", modelId: featureModel.id, version: "event-portal-feature-model.v1" },
  });
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "event-portal-monolith-"));
  const providers = new ArtifactProviderRegistry([
    new LocalArtifactProvider({ roots: { "event-portal-assets": path.resolve(__dirname, "../../../examples/event-portal/artifacts") } }),
  ]);

  const build = new NodeModularMonolithBuilder().build({ manifest, catalog, providers, outputDirectory });
  assert.equal(fs.existsSync(build.runtimePath), true);
  assert.equal(fs.existsSync(path.join(outputDirectory, "dist/runtime/generated/registry.js")), true);
  assert.equal(build.artifacts.length, 10);
  assert.equal(new NodeTestAdapter().run(manifest, outputDirectory).status, "passed");
});
