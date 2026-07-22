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

test("el registro normal no instala catálogos ni perfiles de demostración", () => {
  const registry = loadJson(path.resolve(__dirname, "..", "resource-registry.local.json"));
  assert.deepEqual(registry.catalogs, {});
  assert.deepEqual(registry.profiles, {});
  assert.deepEqual(Object.keys(registry.targets).sort(), [
    "variamos.target.docker.node.local",
    "variamos.target.docker.static.local",
  ]);
});

test("el fixture de regresión Portal de Eventos conserva sus contratos y hashes", () => {
  const { errors, examples } = validateEventPortalExampleSet();
  assert.deepEqual(errors, []);
  assert.equal(examples.catalogs.length, 2);
  assert.equal(examples.mappings.length, 2);
  assert.equal(examples.configurations.length, 3);
});

test("una configuración sin estado selected es rechazada por el esquema", () => {
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

test("un binding a un artefacto inexistente es rechazado por la validación semántica", () => {
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
  assert.match(errors.join("\n"), /artefacto inexistente/);
});

test("variamos-project/v1 acepta un descriptor listo y un borrador con preguntas", () => {
  const root = path.join(examplesRoot, "variamos-project");
  const ready = validateVariamosProjectDescriptor(loadJson(path.join(root, "valid.static.json")), { requireReady: true });
  const draft = validateVariamosProjectDescriptor(loadJson(path.join(root, "valid.draft.json")));
  assert.deepEqual(ready.errors, []);
  assert.deepEqual(draft.errors, []);
});

test("variamos-project/v1 bloquea traversal, secretos y borradores importados", () => {
  const root = path.join(examplesRoot, "variamos-project");
  const traversal = validateVariamosProjectDescriptor(loadJson(path.join(root, "invalid.path-traversal.json")));
  const secret = validateVariamosProjectDescriptor(loadJson(path.join(root, "invalid.secret.json")));
  const draft = validateVariamosProjectDescriptor(loadJson(path.join(root, "valid.draft.json")), { requireReady: true });
  assert.equal(traversal.valid, false);
  assert.equal(secret.valid, false);
  assert.match(draft.errors.join("\n"), /status 'ready'/);
});
