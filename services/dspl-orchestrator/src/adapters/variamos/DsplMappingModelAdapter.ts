import {
  ArtifactCatalog,
  BindingDocument,
  ProductConfiguration,
} from "../../contracts";
import {
  VariaMosElement,
  VariaMosModelAdapterOptions,
  VariaMosProperty,
  VariaMosSerializedModel,
} from "./VariaMosModelTypes";

const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAPPING_SCHEMA = "dspl-deployment-mapping/v1";
const MAPPING_LANGUAGE = "DSPL Deployment Mapping v1";

export interface DsplMappingTrace {
  sourceFeatureId: string;
  featureId: string;
  bindingElementId: string;
  artifactId: string;
  relationshipId: string;
}

export interface DsplMappingModelAdaptationResult {
  configuration: ProductConfiguration;
  bindings: BindingDocument;
  mapping: {
    mappingRef: string;
    catalogRef: string;
    targetRef: string;
  };
  trace: DsplMappingTrace[];
}

export class DsplMappingModelAdaptationError extends Error {
  public readonly diagnostics: string[];

  constructor(diagnostics: string[]) {
    super(`No se pudo adaptar el mapping DSPL: ${diagnostics.join(" | ")}`);
    this.name = "DsplMappingModelAdaptationError";
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, DsplMappingModelAdaptationError.prototype);
  }
}

function propertyValue(
  element: { properties?: VariaMosProperty[] },
  name: string
): string | undefined {
  const property = (element.properties || []).find((candidate) => candidate.name === name);
  return typeof property?.value === "string" ? property.value.trim() : undefined;
}

function stable(value: string | undefined, field: string, diagnostics: string[]): string {
  if (!value || !STABLE_ID.test(value)) {
    diagnostics.push(`El campo '${field}' debe ser un ID estable DSPL.`);
    return "invalid";
  }
  return value;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

export class DsplMappingModelAdapter {
  public adapt(
    featureModel: VariaMosSerializedModel,
    mappingModel: VariaMosSerializedModel,
    options: VariaMosModelAdapterOptions
  ): DsplMappingModelAdaptationResult {
    const diagnostics: string[] = [];
    if (!featureModel?.id || !Array.isArray(featureModel.elements)) {
      diagnostics.push("El feature model no contiene elementos válidos.");
    }
    if (!mappingModel?.id || !Array.isArray(mappingModel.elements) || !Array.isArray(mappingModel.relationships)) {
      diagnostics.push("El mapping model no contiene elementos o relaciones válidas.");
    }
    if (mappingModel.type !== MAPPING_LANGUAGE) {
      diagnostics.push(`El mapping model debe usar '${MAPPING_LANGUAGE}'.`);
    }
    if ((mappingModel.sourceModelIds || []).length !== 1 || mappingModel.sourceModelIds?.[0] !== featureModel.id) {
      diagnostics.push("El mapping debe vincular exactamente el feature model fuente mediante sourceModelIds.");
    }
    stable(options.configurationId, "configurationId", diagnostics);
    stable(options.productLineId, "productLineId", diagnostics);
    if (!options.modelVersion) diagnostics.push("modelVersion es obligatorio.");

    const mappingRoots = (mappingModel.elements || []).filter(
      (element) => element.type === "DeploymentMapping"
    );
    if (mappingRoots.length !== 1) {
      diagnostics.push("El mapping debe contener exactamente un DeploymentMapping.");
    }
    const root = mappingRoots[0];
    const mappingSchema = root ? propertyValue(root, "mapping_schema") : undefined;
    if (mappingSchema !== MAPPING_SCHEMA) {
      diagnostics.push(`DeploymentMapping.mapping_schema debe ser '${MAPPING_SCHEMA}'.`);
    }
    const mappingRef = stable(root ? propertyValue(root, "mapping_ref") : undefined, "mapping_ref", diagnostics);
    const catalogRef = stable(root ? propertyValue(root, "catalog_ref") : undefined, "catalog_ref", diagnostics);
    const targetRef = stable(root ? propertyValue(root, "target_ref") : undefined, "target_ref", diagnostics);
    if (catalogRef !== "invalid" && catalogRef !== options.catalog.id) {
      diagnostics.push(`El catálogo '${catalogRef}' del mapping no coincide con '${options.catalog.id}'.`);
    }

    const featureById = new Map((featureModel.elements || []).map((element) => [element.id, element]));
    const artifactById = new Map(options.catalog.artifacts.map((artifact) => [artifact.id, artifact]));
    const mappingElementById = new Map<string, VariaMosElement>();
    (mappingModel.elements || []).forEach((element) => {
      if (mappingElementById.has(element.id)) diagnostics.push(`El mapping repite el elemento '${element.id}'.`);
      mappingElementById.set(element.id, element);
    });

    const artifactRefByElementId = new Map<string, string>();
    (mappingModel.elements || [])
      .filter((element) => element.type === "SoftwareArtifact")
      .forEach((element) => {
        const artifactRef = stable(propertyValue(element, "artifact_ref"), `artifact_ref de '${element.id}'`, diagnostics);
        if (artifactRef !== "invalid") {
          if (!artifactById.has(artifactRef)) diagnostics.push(`artifact_ref '${artifactRef}' no existe en el catálogo.`);
          artifactRefByElementId.set(element.id, artifactRef);
        }
      });

    type BindingNode = { element: VariaMosElement; sourceFeatureId: string; featureId: string };
    const bindingByElementId = new Map<string, BindingNode>();
    const bindingBySourceFeatureId = new Map<string, BindingNode>();
    const bindingByFeatureId = new Map<string, BindingNode>();
    (mappingModel.elements || [])
      .filter((element) => element.type === "FeatureBinding")
      .forEach((element) => {
        const sourceFeatureId = propertyValue(element, "source_feature_id");
        const featureId = stable(propertyValue(element, "feature_ref"), `feature_ref de '${element.id}'`, diagnostics);
        if (!sourceFeatureId || !featureById.has(sourceFeatureId)) {
          diagnostics.push(`FeatureBinding '${element.id}' no referencia una feature fuente existente.`);
          return;
        }
        if (bindingBySourceFeatureId.has(sourceFeatureId)) diagnostics.push(`La feature fuente '${sourceFeatureId}' posee más de un binding.`);
        if (featureId !== "invalid" && bindingByFeatureId.has(featureId)) diagnostics.push(`feature_ref '${featureId}' está duplicado.`);
        const binding = { element, sourceFeatureId, featureId };
        bindingByElementId.set(element.id, binding);
        bindingBySourceFeatureId.set(sourceFeatureId, binding);
        if (featureId !== "invalid") bindingByFeatureId.set(featureId, binding);
      });

    const artifactsByBindingElementId = new Map<string, Array<{ artifactId: string; relationshipId: string }>>();
    (mappingModel.relationships || [])
      .filter((relationship) => relationship.type === "ImplementedBy")
      .sort(byId)
      .forEach((relationship) => {
        const binding = bindingByElementId.get(relationship.sourceId);
        const artifactId = artifactRefByElementId.get(relationship.targetId);
        if (!binding) {
          diagnostics.push(`ImplementedBy '${relationship.id}' debe salir de un FeatureBinding.`);
          return;
        }
        if (!artifactId) {
          diagnostics.push(`ImplementedBy '${relationship.id}' debe llegar a un SoftwareArtifact válido.`);
          return;
        }
        const values = artifactsByBindingElementId.get(binding.element.id) || [];
        if (values.some((value) => value.artifactId === artifactId)) {
          diagnostics.push(`El binding '${binding.featureId}' repite el artefacto '${artifactId}'.`);
          return;
        }
        values.push({ artifactId, relationshipId: relationship.id });
        artifactsByBindingElementId.set(binding.element.id, values);
      });

    const selections: ProductConfiguration["selections"] = [];
    const bindings: BindingDocument["bindings"] = [];
    const trace: DsplMappingTrace[] = [];
    [...bindingByFeatureId.values()]
      .sort((left, right) => left.featureId.localeCompare(right.featureId))
      .forEach((binding) => {
        const feature = featureById.get(binding.sourceFeatureId) as VariaMosElement;
        const selectedValue = propertyValue(feature, "Selected");
        if (!selectedValue || !["Selected", "Unselected", "Undefined"].includes(selectedValue)) {
          diagnostics.push(`La feature '${feature.name || feature.id}' no declara Selected válido.`);
          return;
        }
        const selected = selectedValue === "Selected";
        const selectedArtifacts = (artifactsByBindingElementId.get(binding.element.id) || []).sort((left, right) =>
          left.artifactId.localeCompare(right.artifactId)
        );
        if (selected && selectedArtifacts.length === 0) {
          diagnostics.push(`La feature seleccionada '${binding.featureId}' no posee artefactos vinculados.`);
        }
        selections.push({ featureId: binding.featureId, selected });
        bindings.push({
          id: `binding.${binding.featureId}`,
          featureId: binding.featureId,
          when: { selected: true },
          priority: 100,
          actions: selectedArtifacts.map((artifact) => ({ type: "include", artifactId: artifact.artifactId })),
        });
        selectedArtifacts.forEach((artifact) => {
          trace.push({
            sourceFeatureId: binding.sourceFeatureId,
            featureId: binding.featureId,
            bindingElementId: binding.element.id,
            artifactId: artifact.artifactId,
            relationshipId: artifact.relationshipId,
          });
        });
      });

    const mappedSources = new Set(bindingBySourceFeatureId.keys());
    (featureModel.elements || []).forEach((feature) => {
      const selected = propertyValue(feature, "Selected");
      if (selected === "Selected" && !mappedSources.has(feature.id)) {
        diagnostics.push(`La feature seleccionada '${feature.name || feature.id}' no posee FeatureBinding en el mapping.`);
      }
    });
    if (diagnostics.length > 0) throw new DsplMappingModelAdaptationError(diagnostics);

    return {
      configuration: {
        schemaVersion: "product-configuration/v1",
        id: options.configurationId,
        productLineId: options.productLineId,
        modelVersion: options.modelVersion,
        selections: selections.sort((left, right) => left.featureId.localeCompare(right.featureId)),
      },
      bindings: {
        schemaVersion: "feature-artifact-bindings/v1",
        id: `bindings.${mappingModel.id.toLowerCase()}`,
        bindings: bindings.sort(byId),
      },
      mapping: { mappingRef, catalogRef, targetRef },
      trace: trace.sort((left, right) => {
        const feature = left.featureId.localeCompare(right.featureId);
        return feature || left.artifactId.localeCompare(right.artifactId);
      }),
    };
  }
}
