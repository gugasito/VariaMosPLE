import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import {
  createSplMapping,
  SPL_MAPPING_LANGUAGE,
  SPL_MAPPING_MODEL_NAME,
  SplProfileSummary,
  synchronizeSplMapping,
} from "./SplMappingFactory";

const profile: SplProfileSummary = {
  id: "static-site",
  name: "Static website",
  mappingRef: "mapping.static.v1",
  catalogRef: "catalog.static.v1",
  targetRef: "target.static.local",
  builderAdapter: "static-site-v1",
  testAdapter: null,
  deployerAdapter: "nginx-container-v1",
  artifacts: [{ id: "artifact.site", kind: "directory", version: "1.0.0" }],
};

function featureModel(): Model {
  const model = new Model("feature-model", "Product decisions", "Feature model without attributes", "1");
  model.elements = [{
    id: "feature-site",
    type: "RootFeature",
    name: "Site",
    properties: [{ name: "Selected", value: "Selected" }],
  } as any];
  return model;
}

describe("SPL Feature–Artifact Mapping terminology", () => {
  test("uses the accepted descriptive name for generated correspondence models", () => {
    const mapping = createSplMapping(featureModel(), profile);

    expect(mapping.name).toBe(`${SPL_MAPPING_MODEL_NAME} — ${profile.name}`);
    expect(mapping.type).toBe(SPL_MAPPING_LANGUAGE);
    expect(mapping.description).toContain("derivation, testing, and deployment");
  });

  test("normalizes the previous generated name while preserving a custom user name", () => {
    const generated = createSplMapping(featureModel(), profile);
    generated.name = `${profile.name} — mapping`;
    synchronizeSplMapping(generated, featureModel(), profile);
    expect(generated.name).toBe(`${SPL_MAPPING_MODEL_NAME} — ${profile.name}`);

    generated.name = "My product realization";
    synchronizeSplMapping(generated, featureModel(), profile);
    expect(generated.name).toBe("My product realization");
  });
});
