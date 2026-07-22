const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Ajv2020 = require("ajv/dist/2020");

const contractsRoot = path.resolve(__dirname, "..");
const schemasRoot = path.join(contractsRoot, "schemas");
const eventPortalRoot = path.join(contractsRoot, "examples", "event-portal");

const schemaDefinitions = {
  artifact: {
    id: "https://variamosple.org/schemas/dspl/artifact/v1",
    file: "artifact.schema.json",
  },
  catalog: {
    id: "https://variamosple.org/schemas/dspl/catalog/v1",
    file: "catalog.schema.json",
  },
  binding: {
    id: "https://variamosple.org/schemas/dspl/binding/v1",
    file: "binding.schema.json",
  },
  configuration: {
    id: "https://variamosple.org/schemas/dspl/configuration/v1",
    file: "configuration.schema.json",
  },
  target: {
    id: "https://variamosple.org/schemas/dspl/target/v1",
    file: "target.schema.json",
  },
  manifest: {
    id: "https://variamosple.org/schemas/dspl/manifest/v1",
    file: "manifest.schema.json",
  },
  variamosProject: {
    id: "https://variamosple.org/schemas/dspl/variamos-project/v1",
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
    throw new Error(`No se encontró el esquema ${schemaName}.`);
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
      errors.push(`${scope}: el id '${item.id}' está duplicado.`);
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
      errors.push(`bindings.bindings: la feature '${binding.featureId}' tiene más de un binding v1.`);
    }
    bindingByFeatureId.set(binding.featureId, binding);

    binding.actions.forEach((action) => {
      if (action.artifactId && !artifactById.has(action.artifactId)) {
        errors.push(`binding '${binding.id}' referencia el artefacto inexistente '${action.artifactId}'.`);
      }
    });
  });

  configuration.selections
    .filter((selection) => selection.selected)
    .forEach((selection) => {
      if (!bindingByFeatureId.has(selection.featureId)) {
        errors.push(`configuration: la feature seleccionada '${selection.featureId}' no tiene binding.`);
      }
    });

  manifest.features
    .filter((feature) => feature.selected)
    .forEach((feature) => {
      const selection = configuration.selections.find((item) => item.featureId === feature.id);
      if (!selection || !selection.selected) {
        errors.push(`manifest: la feature seleccionada '${feature.id}' no coincide con la configuración.`);
      }
    });

  manifest.artifacts.forEach((artifact) => {
    const catalogArtifact = artifactById.get(artifact.id);
    if (!catalogArtifact) {
      errors.push(`manifest: el artefacto '${artifact.id}' no existe en el catálogo.`);
      return;
    }
    if (catalogArtifact.version !== artifact.version) {
      errors.push(`manifest: la versión de '${artifact.id}' no coincide con el catálogo.`);
    }
    if (catalogArtifact.integrity.digest !== artifact.digest) {
      errors.push(`manifest: el digest de '${artifact.id}' no coincide con el catálogo.`);
    }
  });

  if (manifest.target.id !== target.id) {
    errors.push(`manifest: el target '${manifest.target.id}' no coincide con '${target.id}'.`);
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
    if (!result.valid) errors.push(...result.errors.map((error) => `Portal de Eventos ${schemaName}: ${error}`));
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
    if (!mappedFeatureIds.has(featureId)) errors.push(`Portal de Eventos: la feature '${featureId}' falta en los mappings.`);
  });
  examples.configurations.forEach((configuration) => {
    configuration.selections.forEach((selection) => {
      if (!declaredFeatureIds.has(selection.featureId)) {
        errors.push(`Portal de Eventos: '${configuration.id}' referencia la feature desconocida '${selection.featureId}'.`);
      }
    });
  });

  const registryRoot = path.dirname(path.join(eventPortalRoot, "registry.local.json"));
  Object.entries(examples.registry.catalogs).forEach(([catalogId, relativePath]) => {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      errors.push(`Portal de Eventos: el catálogo '${catalogId}' tiene una ruta no autorizada.`);
    }
  });
  const artifactRoot = path.resolve(registryRoot, examples.registry.localRoots["event-portal-assets"]);
  examples.catalogs.forEach((catalog) => {
    errors.push(...distinctIds(catalog.artifacts, `Portal de Eventos ${catalog.id}.artifacts`));
    catalog.artifacts.forEach((artifact) => {
      const source = artifact.source || {};
      if (source.provider !== "local" || source.location !== "event-portal-assets") {
        errors.push(`Portal de Eventos: '${artifact.id}' debe usar el provider local versionado.`);
        return;
      }
      if (!source.path || path.isAbsolute(source.path) || source.path.split(/[\\/]/).includes("..")) {
        errors.push(`Portal de Eventos: '${artifact.id}' tiene una ruta de activo no autorizada.`);
        return;
      }
      const artifactPath = path.resolve(artifactRoot, source.path);
      if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`) || !fs.existsSync(artifactPath)) {
        errors.push(`Portal de Eventos: no existe el activo '${artifact.id}'.`);
        return;
      }
      if (digestFile(artifactPath) !== artifact.integrity.digest) {
        errors.push(`Portal de Eventos: el digest de '${artifact.id}' no coincide con el activo.`);
      }
    });
  });

  const catalogIds = new Set(examples.catalogs.map((catalog) => catalog.id));
  const targetIds = new Set(examples.targets.map((target) => target.id));
  const mappingRefs = new Set();
  examples.mappings.forEach((mapping) => {
    if (mapping.type !== "DSPL Deployment Mapping v1") errors.push(`Portal de Eventos: '${mapping.id}' no usa el lenguaje DSPL propio.`);
    if ((mapping.sourceModelIds || []).join(",") !== examples.featureModel.id) errors.push(`Portal de Eventos: '${mapping.id}' no enlaza su feature model fuente.`);
    const root = mapping.elements.find((element) => element.type === "DeploymentMapping");
    const property = (name) => (root?.properties || []).find((candidate) => candidate.name === name)?.value;
    mapping.elements
      .filter((element) => element.type === "FeatureBinding")
      .forEach((element) => {
        const sourceFeatureId = (element.properties || []).find((candidate) => candidate.name === "source_feature_id")?.value;
        if (!sourceFeatureIds.has(sourceFeatureId)) errors.push(`Portal de Eventos: '${mapping.id}' enlaza una feature fuente inexistente.`);
      });
    if (property("mapping_schema") !== "dspl-deployment-mapping/v1") errors.push(`Portal de Eventos: '${mapping.id}' no declara el schema de mapping v1.`);
    if (!property("mapping_ref")) errors.push(`Portal de Eventos: '${mapping.id}' no declara mapping_ref.`);
    else mappingRefs.add(property("mapping_ref"));
    if (!catalogIds.has(property("catalog_ref"))) errors.push(`Portal de Eventos: '${mapping.id}' referencia un catálogo inválido.`);
    if (!targetIds.has(property("target_ref"))) errors.push(`Portal de Eventos: '${mapping.id}' referencia un target inválido.`);
  });
  Object.entries(examples.registry.profiles || {}).forEach(([profileId, profile]) => {
    if (!mappingRefs.has(profile.mappingRef)) errors.push(`Portal de Eventos: el perfil '${profileId}' referencia un mapping no declarado.`);
    if (!examples.registry.catalogs[profile.catalogRef] || !catalogIds.has(profile.catalogRef)) errors.push(`Portal de Eventos: el perfil '${profileId}' referencia un catálogo no autorizado.`);
    if (!examples.registry.targets[profile.targetRef] || !targetIds.has(profile.targetRef)) errors.push(`Portal de Eventos: el perfil '${profileId}' referencia un target no autorizado.`);
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
    if (artifactIds.has(artifact.id)) errors.push(`artifacts: el id '${artifact.id}' está duplicado.`);
    artifactIds.add(artifact.id);
    for (const dependency of artifact.dependsOn || []) {
      if (dependency === artifact.id) errors.push(`artifact '${artifact.id}' no puede depender de sí mismo.`);
    }
  }
  const profileIds = new Set();
  for (const profile of document.profiles) {
    if (profileIds.has(profile.id)) errors.push(`profiles: el id '${profile.id}' está duplicado.`);
    profileIds.add(profile.id);
    if (!allowedProjectAdapters.has(profile.builderAdapter)) {
      errors.push(`profile '${profile.id}' usa el builder no autorizado '${profile.builderAdapter}'.`);
    }
    if (profile.testAdapter && !allowedProjectTestAdapters.has(profile.testAdapter)) {
      errors.push(`profile '${profile.id}' usa el tester no autorizado '${profile.testAdapter}'.`);
    }
    for (const artifactId of profile.artifactIds || []) {
      if (!artifactIds.has(artifactId)) errors.push(`profile '${profile.id}' referencia el artefacto inexistente '${artifactId}'.`);
    }
  }
  for (const artifact of document.artifacts) {
    for (const dependency of artifact.dependsOn || []) {
      if (!artifactIds.has(dependency)) errors.push(`artifact '${artifact.id}' depende del artefacto inexistente '${dependency}'.`);
    }
  }
  if (options.requireReady && document.status !== "ready") {
    errors.push("El descriptor debe tener status 'ready' antes de importarse.");
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
  const errors = [...eventPortal.errors, ...readyProject.errors, ...draftProject.errors];

  if (errors.length > 0) {
    console.error("Los contratos DSPL no son válidos:");
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log("Los contratos DSPL, el fixture Portal de Eventos y variamos-project/v1 son válidos.");
  }
}
