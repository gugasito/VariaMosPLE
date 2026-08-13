export type Primitive = string | number | boolean | null;

export interface Artifact {
  schemaVersion: "artifact/v1";
  id: string;
  kind: string;
  version: string;
  source: {
    provider: string;
    location: string;
    ref?: string;
    path?: string;
  };
  integrity: {
    algorithm: "sha256";
    digest: string;
  };
  build: {
    adapter: string;
    entrypoint?: string | null;
  };
  dependsOn?: string[];
  requiresCapabilities: string[];
}

export interface ArtifactCatalog {
  schemaVersion: "artifact-catalog/v1";
  id: string;
  version: string;
  derivation: {
    builderAdapter: string;
    testAdapter?: string;
  };
  artifacts: Artifact[];
}

export interface BindingAction {
  type: string;
  artifactId?: string;
  parameters?: Record<string, Primitive>;
}

export interface FeatureArtifactBinding {
  id: string;
  featureId: string;
  when: {
    selected: true;
  };
  priority?: number;
  actions: BindingAction[];
}

export interface BindingDocument {
  schemaVersion: "feature-artifact-bindings/v1";
  id: string;
  bindings: FeatureArtifactBinding[];
}

export interface ProductConfiguration {
  schemaVersion: "product-configuration/v1";
  id: string;
  productLineId: string;
  modelVersion: string;
  selections: Array<{
    featureId: string;
    selected: boolean;
  }>;
  inputs?: Record<string, Primitive>;
}

export interface DeploymentTarget {
  schemaVersion: "deployment-target/v1";
  id: string;
  adapter: string;
  capabilities: string[];
  credentialsRef?: string;
  hostRef?: string;
}

export interface SourceModelReference {
  projectId: string;
  modelId: string;
  version: string;
}

export interface DerivationRequest {
  catalog: ArtifactCatalog;
  bindings: BindingDocument;
  configuration: ProductConfiguration;
  target: DeploymentTarget;
  sourceModel: SourceModelReference;
  productId?: string;
}

export interface DeploymentManifest {
  schemaVersion: "spl-deployment-manifest/v1";
  manifestId: string;
  product: {
    id: string;
    configurationId: string;
  };
  sourceModel: SourceModelReference;
  features: Array<{
    id: string;
    selected: boolean;
  }>;
  artifacts: Array<{
    id: string;
    version: string;
    digest: string;
  }>;
  operations: Array<{
    type: "generate" | "build" | "test" | "deploy" | "verify";
    adapter: string;
  }>;
  target: {
    id: string;
    credentialsRef?: string;
  };
  verification: Array<{
    type: "http-health-check" | "smoke-test";
    path?: string;
  }>;
  rollback: {
    strategy: "previous-successful-release";
  };
}
