const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  createValidator,
  loadJson,
  validateCrossReferences,
  validateDocument,
  validateEventPortalExampleSet,
  validateVariamosProjectDescriptor,
} = require("../scripts/validate-contracts.cjs");

const examplesRoot = path.resolve(__dirname, "..", "examples");

test("the normal registry installs no demonstration catalogs or profiles", () => {
  const registry = loadJson(path.resolve(__dirname, "..", "resource-registry.local.json"));
  assert.deepEqual(registry.catalogs, {});
  assert.deepEqual(registry.profiles, {});
  assert.deepEqual(Object.keys(registry.targets).sort(), [
    "variamos.target.docker.node.local",
    "variamos.target.docker.static.local",
  ]);
});

test("the Event Portal regression fixture preserves its contracts and hashes", () => {
  const { errors, examples } = validateEventPortalExampleSet();
  assert.deepEqual(errors, []);
  assert.equal(examples.catalogs.length, 2);
  assert.equal(examples.mappings.length, 2);
  assert.equal(examples.configurations.length, 3);
});

test("the schema rejects a configuration without selected state", () => {
  const ajv = createValidator();
  const invalidConfiguration = loadJson(path.join(
    examplesRoot,
    "event-portal",
    "configurations",
    "conference-presential.json"
  ));
  delete invalidConfiguration.selections[0].selected;

  const result = validateDocument(ajv, "configuration", invalidConfiguration);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /selected/);
});

test("semantic validation rejects a binding to a missing artifact", () => {
  const ajv = createValidator();
  const { examples } = validateEventPortalExampleSet();
  const invalidBindings = loadJson(
    path.join(examplesRoot, "invalid", "binding-unknown-artifact.json")
  );

  const schemaResult = validateDocument(ajv, "binding", invalidBindings);
  assert.equal(schemaResult.valid, true);

  const errors = validateCrossReferences({
    catalog: examples.catalogs[0],
    bindings: invalidBindings,
    configuration: {
      schemaVersion: "product-configuration/v1",
      id: "event-portal.configuration.invalid-binding",
      productLineId: "event-portal",
      modelVersion: "event-portal-feature-model.v1",
      selections: [{ featureId: "feature.event.agenda", selected: true }],
    },
    manifest: { features: [], artifacts: [], target: { id: examples.targets[0].id } },
    target: examples.targets[0],
  });
  assert.match(errors.join("\n"), /missing artifact/);
});

test("variamos-project/v1 accepts a ready descriptor and a draft with questions", () => {
  const root = path.join(examplesRoot, "variamos-project");
  const ready = validateVariamosProjectDescriptor(loadJson(path.join(root, "valid.static.json")), { requireReady: true });
  const draft = validateVariamosProjectDescriptor(loadJson(path.join(root, "valid.draft.json")));
  assert.deepEqual(ready.errors, []);
  assert.deepEqual(draft.errors, []);
});

test("the downloadable spl.json template is a real, ready descriptor", () => {
  const workspaceRoot = path.resolve(__dirname, "../..");
  const template = loadJson(path.join(workspaceRoot, "public/templates/spl.json"));
  const realExample = loadJson(path.join(workspaceRoot, "examples/external-project-onboarding/.variamos/spl.json"));
  const result = validateVariamosProjectDescriptor(template, { requireReady: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(template, realExample);
});

test("variamos-project/v1 blocks traversal, secrets, and imported drafts", () => {
  const root = path.join(examplesRoot, "variamos-project");
  const traversal = validateVariamosProjectDescriptor(loadJson(path.join(root, "invalid.path-traversal.json")));
  const secret = validateVariamosProjectDescriptor(loadJson(path.join(root, "invalid.secret.json")));
  const draft = validateVariamosProjectDescriptor(loadJson(path.join(root, "valid.draft.json")), { requireReady: true });
  assert.equal(traversal.valid, false);
  assert.equal(secret.valid, false);
  assert.match(draft.errors.join("\n"), /'ready' status/);
});
