const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Ajv2020 = require("ajv/dist/2020");

const contractsRoot = path.resolve(__dirname, "..");
const schemasRoot = path.join(contractsRoot, "schemas");
const eventPortalRoot = path.join(contractsRoot, "examples", "event-portal");

const schemaDefinitions = {
  artifact: {
    id: "https://variamosple.org/schemas/spl/artifact/v1",
    file: "artifact.schema.json",
  },
  catalog: {
    id: "https://variamosple.org/schemas/spl/catalog/v1",
    file: "catalog.schema.json",
  },
  binding: {
    id: "https://variamosple.org/schemas/spl/binding/v1",
    file: "binding.schema.json",
  },
  configuration: {
    id: "https://variamosple.org/schemas/spl/configuration/v1",
    file: "configuration.schema.json",
  },
  target: {
    id: "https://variamosple.org/schemas/spl/target/v1",
    file: "target.schema.json",
  },
  manifest: {
    id: "https://variamosple.org/schemas/spl/manifest/v1",
    file: "manifest.schema.json",
  },
  variamosProject: {
    id: "https://variamosple.org/schemas/spl/variamos-project/v1",
    file: "variamos-project.schema.json",
  },
};

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
  });

  Object.values(schemaDefinitions).forEach(({ file }) => {
    ajv.addSchema(loadJson(path.join(schemasRoot, file)));
  });

  return ajv;
}

function formatErrors(errors) {
  return (errors || []).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message}`;
  });
}

function validateDocument(ajv, schemaName, document) {
  const definition = schemaDefinitions[schemaName];
  const validator = ajv.getSchema(definition.id);

  if (!validator) {
    throw new Error(`Schema ${schemaName} was not found.`);
  }

  const valid = validator(document);
  return {
    valid,
    errors: valid ? [] : formatErrors(validator.errors),
  };
}

function distinctIds(items, scope) {
  const ids = new Set();
  const errors = [];

  items.forEach((item) => {
    if (ids.has(item.id)) {
      errors.push(`${scope}: ID '${item.id}' is duplicated.`);
    }
    ids.add(item.id);
  });

  return errors;
}

function validateCrossReferences({ catalog, bindings, configuration, manifest, target }) {
  const errors = [];
  const artifactById = new Map(catalog.artifacts.map((artifact) => [artifact.id, artifact]));
  const bindingByFeatureId = new Map();

  errors.push(...distinctIds(catalog.artifacts, "catalog.artifacts"));
  errors.push(...distinctIds(bindings.bindings, "bindings.bindings"));
  errors.push(...distinctIds(configuration.selections.map((selection) => ({ id: selection.featureId })), "configuration.selections"));

  bindings.bindings.forEach((binding) => {
    if (bindingByFeatureId.has(binding.featureId)) {
      errors.push(`bindings.bindings: feature '${binding.featureId}' has more than one v1 binding.`);
    }
    bindingByFeatureId.set(binding.featureId, binding);

    binding.actions.forEach((action) => {
      if (action.artifactId && !artifactById.has(action.artifactId)) {
        errors.push(`binding '${binding.id}' references missing artifact '${action.artifactId}'.`);
      }
    });
  });

  configuration.selections
    .filter((selection) => selection.selected)
    .forEach((selection) => {
      if (!bindingByFeatureId.has(selection.featureId)) {
        errors.push(`configuration: selected feature '${selection.featureId}' has no binding.`);
      }
    });

  manifest.features
    .filter((feature) => feature.selected)
    .forEach((feature) => {
      const selection = configuration.selections.find((item) => item.featureId === feature.id);
      if (!selection || !selection.selected) {
        errors.push(`manifest: selected feature '${feature.id}' does not match the configuration.`);
      }
    });

  manifest.artifacts.forEach((artifact) => {
    const catalogArtifact = artifactById.get(artifact.id);
    if (!catalogArtifact) {
      errors.push(`manifest: artifact '${artifact.id}' does not exist in the catalog.`);
      return;
    }
    if (catalogArtifact.version !== artifact.version) {
      errors.push(`manifest: version of '${artifact.id}' does not match the catalog.`);
    }
    if (catalogArtifact.integrity.digest !== artifact.digest) {
      errors.push(`manifest: digest of '${artifact.id}' does not match the catalog.`);
    }
  });

  if (manifest.target.id !== target.id) {
    errors.push(`manifest: target '${manifest.target.id}' does not match '${target.id}'.`);
  }

  return errors;
}

function digestFile(fileName) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(fileName)).digest("hex")}`;
}

function loadEventPortalExampleSet() {
  return {
    featureIds: loadJson(path.join(eventPortalRoot, "feature-ids.json")),
    featureModel: loadJson(path.join(eventPortalRoot, "models", "feature-model.json")),
    mappings: [
      loadJson(path.join(eventPortalRoot, "models", "mapping.static.json")),
      loadJson(path.join(eventPortalRoot, "models", "mapping.monolith.json")),
    ],
    catalogs: [
      loadJson(path.join(eventPortalRoot, "catalogs", "static.local.json")),
      loadJson(path.join(eventPortalRoot, "catalogs", "monolith.local.json")),
    ],
    targets: [
      loadJson(path.join(eventPortalRoot, "targets", "static.local.json")),
      loadJson(path.join(eventPortalRoot, "targets", "monolith.local.json")),
    ],
    configurations: [
      "conference-presential.json",
      "presential-basic.json",
      "virtual.json",
    ].map((file) => loadJson(path.join(eventPortalRoot, "configurations", file))),
    registry: loadJson(path.join(eventPortalRoot, "registry.local.json")),
  };
}

function validateEventPortalExampleSet() {
  const ajv = createValidator();
  const examples = loadEventPortalExampleSet();
  const errors = [];
  const schemaDocuments = [
    ...examples.catalogs.map((document) => ["catalog", document]),
    ...examples.targets.map((document) => ["target", document]),
    ...examples.configurations.map((document) => ["configuration", document]),
  ];
  schemaDocuments.forEach(([schemaName, document]) => {
    const result = validateDocument(ajv, schemaName, document);
    if (!result.valid) errors.push(...result.errors.map((error) => `Event Portal ${schemaName}: ${error}`));
  });

  const declaredFeatureIds = new Set(Object.values(examples.featureIds.features));
  const sourceFeatureIds = new Set(examples.featureModel.elements.map((element) => element.id));
  const mappedFeatureIds = new Set(
    examples.mappings.flatMap((mapping) =>
      mapping.elements
        .filter((element) => element.type === "FeatureBinding")
        .map((element) => (element.properties || []).find((property) => property.name === "feature_ref")?.value)
    )
  );
  declaredFeatureIds.forEach((featureId) => {
    if (!mappedFeatureIds.has(featureId)) errors.push(`Event Portal: feature '${featureId}' is missing from the mappings.`);
  });
  examples.configurations.forEach((configuration) => {
    configuration.selections.forEach((selection) => {
      if (!declaredFeatureIds.has(selection.featureId)) {
        errors.push(`Event Portal: '${configuration.id}' references unknown feature '${selection.featureId}'.`);
      }
    });
  });

  const registryRoot = path.dirname(path.join(eventPortalRoot, "registry.local.json"));
  Object.entries(examples.registry.catalogs).forEach(([catalogId, relativePath]) => {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      errors.push(`Event Portal: catalog '${catalogId}' has an unauthorized path.`);
    }
  });
  const artifactRoot = path.resolve(registryRoot, examples.registry.localRoots["event-portal-assets"]);
  examples.catalogs.forEach((catalog) => {
    errors.push(...distinctIds(catalog.artifacts, `Event Portal ${catalog.id}.artifacts`));
    catalog.artifacts.forEach((artifact) => {
      const source = artifact.source || {};
      if (source.provider !== "local" || source.location !== "event-portal-assets") {
        errors.push(`Event Portal: '${artifact.id}' must use the versioned local provider.`);
        return;
      }
      if (!source.path || path.isAbsolute(source.path) || source.path.split(/[\\/]/).includes("..")) {
        errors.push(`Event Portal: '${artifact.id}' has an unauthorized asset path.`);
        return;
      }
      const artifactPath = path.resolve(artifactRoot, source.path);
      if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`) || !fs.existsSync(artifactPath)) {
        errors.push(`Event Portal: asset '${artifact.id}' does not exist.`);
        return;
      }
      if (digestFile(artifactPath) !== artifact.integrity.digest) {
        errors.push(`Event Portal: digest of '${artifact.id}' does not match the asset.`);
      }
    });
  });

  const catalogIds = new Set(examples.catalogs.map((catalog) => catalog.id));
  const targetIds = new Set(examples.targets.map((target) => target.id));
  const mappingRefs = new Set();
  examples.mappings.forEach((mapping) => {
    if (mapping.type !== "SPL Deployment Mapping v1") errors.push(`Event Portal: '${mapping.id}' does not use the native SPL language.`);
    if ((mapping.sourceModelIds || []).join(",") !== examples.featureModel.id) errors.push(`Event Portal: '${mapping.id}' does not link its source feature model.`);
    const root = mapping.elements.find((element) => element.type === "DeploymentMapping");
    const property = (name) => (root?.properties || []).find((candidate) => candidate.name === name)?.value;
    mapping.elements
      .filter((element) => element.type === "FeatureBinding")
      .forEach((element) => {
        const sourceFeatureId = (element.properties || []).find((candidate) => candidate.name === "source_feature_id")?.value;
        if (!sourceFeatureIds.has(sourceFeatureId)) errors.push(`Event Portal: '${mapping.id}' links a missing source feature.`);
      });
    if (property("mapping_schema") !== "spl-deployment-mapping/v1") errors.push(`Event Portal: '${mapping.id}' does not declare the v1 mapping schema.`);
    if (!property("mapping_ref")) errors.push(`Event Portal: '${mapping.id}' does not declare mapping_ref.`);
    else mappingRefs.add(property("mapping_ref"));
    if (!catalogIds.has(property("catalog_ref"))) errors.push(`Event Portal: '${mapping.id}' references an invalid catalog.`);
    if (!targetIds.has(property("target_ref"))) errors.push(`Event Portal: '${mapping.id}' references an invalid target.`);
  });
  Object.entries(examples.registry.profiles || {}).forEach(([profileId, profile]) => {
    if (!mappingRefs.has(profile.mappingRef)) errors.push(`Event Portal: profile '${profileId}' references an undeclared mapping.`);
    if (!examples.registry.catalogs[profile.catalogRef] || !catalogIds.has(profile.catalogRef)) errors.push(`Event Portal: profile '${profileId}' references an unauthorized catalog.`);
    if (!examples.registry.targets[profile.targetRef] || !targetIds.has(profile.targetRef)) errors.push(`Event Portal: profile '${profileId}' references an unauthorized target.`);
  });

  return { errors, examples };
}

const allowedProjectAdapters = new Set([
  "static-site-v1",
  "node-modular-monolith-v1",
]);
const allowedProjectTestAdapters = new Set([
  "html-validation-v1",
  "node-test-v1",
]);

function validateVariamosProjectDescriptor(document, options = {}) {
  const ajv = options.ajv || createValidator();
  const schemaResult = validateDocument(ajv, "variamosProject", document);
  const errors = [...schemaResult.errors];
  if (!schemaResult.valid) return { valid: false, errors };

  const artifactIds = new Set();
  for (const artifact of document.artifacts) {
    if (artifactIds.has(artifact.id)) errors.push(`artifacts: ID '${artifact.id}' is duplicated.`);
    artifactIds.add(artifact.id);
    for (const dependency of artifact.dependsOn || []) {
      if (dependency === artifact.id) errors.push(`artifact '${artifact.id}' cannot depend on itself.`);
    }
  }
  const profileIds = new Set();
  for (const profile of document.profiles) {
    if (profileIds.has(profile.id)) errors.push(`profiles: ID '${profile.id}' is duplicated.`);
    profileIds.add(profile.id);
    if (!allowedProjectAdapters.has(profile.builderAdapter)) {
      errors.push(`profile '${profile.id}' uses unauthorized builder '${profile.builderAdapter}'.`);
    }
    if (profile.testAdapter && !allowedProjectTestAdapters.has(profile.testAdapter)) {
      errors.push(`profile '${profile.id}' uses unauthorized test adapter '${profile.testAdapter}'.`);
    }
    for (const artifactId of profile.artifactIds || []) {
      if (!artifactIds.has(artifactId)) errors.push(`profile '${profile.id}' references missing artifact '${artifactId}'.`);
    }
  }
  for (const artifact of document.artifacts) {
    for (const dependency of artifact.dependsOn || []) {
      if (!artifactIds.has(dependency)) errors.push(`artifact '${artifact.id}' depends on missing artifact '${dependency}'.`);
    }
  }
  if (options.requireReady && document.status !== "ready") {
    errors.push("The descriptor must have 'ready' status before it can be imported.");
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  createValidator,
  loadJson,
  loadEventPortalExampleSet,
  validateCrossReferences,
  validateDocument,
  validateEventPortalExampleSet,
  validateVariamosProjectDescriptor,
};

if (require.main === module) {
  const eventPortal = validateEventPortalExampleSet();
  const projectRoot = path.join(contractsRoot, "examples", "variamos-project");
  const readyProject = validateVariamosProjectDescriptor(loadJson(path.join(projectRoot, "valid.static.json")), { requireReady: true });
  const draftProject = validateVariamosProjectDescriptor(loadJson(path.join(projectRoot, "valid.draft.json")));
  const downloadableTemplate = validateVariamosProjectDescriptor(
    loadJson(path.resolve(contractsRoot, "../public/templates/spl.json")),
    { requireReady: true }
  );
  const errors = [...eventPortal.errors, ...readyProject.errors, ...draftProject.errors, ...downloadableTemplate.errors];

  if (errors.length > 0) {
    console.error("The SPL contracts are invalid:");
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log("The SPL contracts, Event Portal fixture, and variamos-project/v1 are valid.");
  }
}
