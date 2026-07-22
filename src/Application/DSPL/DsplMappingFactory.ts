import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";

export interface DsplProfileSummary {
  id: string;
  name: string;
  mappingRef: string;
  catalogRef: string;
  targetRef: string;
  builderAdapter: string;
  testAdapter: string | null;
  deployerAdapter: string;
  artifacts: Array<{ id: string; kind: string; version: string; label?: string }>;
  provenance?: {
    connectionId: string;
    requestedRef: string;
    resolvedCommit: string;
    descriptorPath: string;
    descriptorDigest: string;
  };
}

const property = (name: string, value: string) => ({ name, value });
const idFragment = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "feature";

export function featureBindings(mapping: Model) {
  return mapping.elements.filter((element) => element.type === "FeatureBinding");
}

export function createDsplMapping(featureModel: Model, profile: DsplProfileSummary): Model {
  const now = Date.now().toString(36);
  const bindings = featureModel.elements
    .filter((feature) => feature.properties?.some((item) => item.name === "Selected"))
    .map((feature, index) => ({
      id: `binding-${idFragment(feature.id)}`,
      type: "FeatureBinding",
      name: `Binding ${feature.name}`,
      x: 40,
      y: 160 + index * 100,
      width: 180,
      height: 70,
      properties: [property("source_feature_id", feature.id), property("feature_ref", `feature.${idFragment(feature.name || feature.id)}`)],
    }));
  const artifacts = profile.artifacts.map((artifact, index) => ({
    id: `artifact-${idFragment(artifact.id)}`,
    type: "SoftwareArtifact",
    name: artifact.id,
    x: 500,
    y: 160 + index * 100,
    width: 210,
    height: 70,
    properties: [property("artifact_ref", artifact.id)],
  }));
  const root = {
    id: "mapping-root",
    type: "DeploymentMapping",
    name: profile.name,
    x: 260,
    y: 30,
    width: 240,
    height: 90,
    properties: [
      property("mapping_schema", "dspl-deployment-mapping/v1"),
      property("mapping_ref", profile.mappingRef),
      property("catalog_ref", profile.catalogRef),
      property("target_ref", profile.targetRef),
    ],
  };
  const relationships = [
    ...bindings.map((binding) => ({ id: `contains-binding-${binding.id}`, type: "ContainsBinding", name: "contiene", sourceId: root.id, targetId: binding.id, properties: [] })),
    ...artifacts.map((artifact) => ({ id: `contains-artifact-${artifact.id}`, type: "ContainsArtifact", name: "contiene", sourceId: root.id, targetId: artifact.id, properties: [] })),
  ];
  const mapping = new Model(`dspl-mapping-${idFragment(profile.id)}-${now}`, `${profile.name} — mapping`, "DSPL Deployment Mapping v1", "900002", "Mapping generado por el asistente DSPL");
  mapping.sourceModelIds = [featureModel.id];
  mapping.elements = [root, ...bindings, ...artifacts] as any;
  mapping.relationships = relationships as any;
  return mapping;
}

/** Actualiza un mapping existente sin eliminar sus relaciones confirmadas. Al
 * añadir una feature al modelo, el asistente incorpora su binding vacío para
 * que la persona pueda asociarlo explícitamente a artefactos. */
export function synchronizeDsplMapping(existing: Model | undefined, featureModel: Model, profile: DsplProfileSummary): Model {
  if (!existing) return createDsplMapping(featureModel, profile);
  const generated = createDsplMapping(featureModel, profile);
  const bindingFor = (element: any) => element.properties?.find((item: any) => item.name === "source_feature_id")?.value;
  const artifactFor = (element: any) => element.properties?.find((item: any) => item.name === "artifact_ref")?.value;
  const currentBindingSources = new Set(existing.elements.filter((element) => element.type === "FeatureBinding").map(bindingFor));
  const currentArtifactRefs = new Set(existing.elements.filter((element) => element.type === "SoftwareArtifact").map(artifactFor));
  const root = existing.elements.find((element) => element.type === "DeploymentMapping");
  const generatedRoot = generated.elements.find((element) => element.type === "DeploymentMapping");
  if (root && generatedRoot) {
    root.properties = generatedRoot.properties as any;
    root.name = profile.name;
  }
  const append = (element: any, relationshipType: string) => {
    existing.elements.push(element);
    const sourceId = root?.id || "mapping-root";
    existing.relationships.push({ id: `${relationshipType.toLowerCase()}-${element.id}`, type: relationshipType, name: "contiene", sourceId, targetId: element.id, properties: [] } as any);
  };
  generated.elements.filter((element) => element.type === "FeatureBinding" && !currentBindingSources.has(bindingFor(element))).forEach((element) => append(element, "ContainsBinding"));
  generated.elements.filter((element) => element.type === "SoftwareArtifact" && !currentArtifactRefs.has(artifactFor(element))).forEach((element) => append(element, "ContainsArtifact"));
  existing.sourceModelIds = [featureModel.id];
  return existing;
}

export function applyBindingAssignments(mapping: Model, assignments: Record<string, string[]>): Model {
  const artifacts = new Map(mapping.elements.filter((element) => element.type === "SoftwareArtifact").map((element) => [element.properties.find((p) => p.name === "artifact_ref")?.value, element]));
  mapping.relationships = mapping.relationships.filter((relationship) => relationship.type !== "ImplementedBy");
  featureBindings(mapping).forEach((binding) => {
    const sourceFeatureId = binding.properties.find((p) => p.name === "source_feature_id")?.value || binding.id;
    (assignments[sourceFeatureId] || []).forEach((artifactRef) => {
      const artifact = artifacts.get(artifactRef);
      if (artifact) mapping.relationships.push({ id: `implements-${binding.id}-${artifact.id}`, type: "ImplementedBy", name: "implementa", sourceId: binding.id, targetId: artifact.id, properties: [] } as any);
    });
  });
  return mapping;
}
