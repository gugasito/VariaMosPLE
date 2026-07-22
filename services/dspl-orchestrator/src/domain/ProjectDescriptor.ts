export interface VariamosProjectArtifact {
  id: string;
  label?: string;
  description?: string;
  kind: string;
  version: string;
  source: { path: string };
  integrity?: { algorithm: "sha256"; digest: string };
  build?: { entrypoint?: string };
  dependsOn?: string[];
  requiresCapabilities?: string[];
}

export interface VariamosProjectProfile {
  id: string;
  name: string;
  builderAdapter: string;
  testAdapter?: string;
  artifactIds?: string[];
  requiredTargetCapabilities: string[];
}

export interface VariamosProjectDescriptor {
  schemaVersion: "variamos-project/v1";
  status: "draft" | "ready";
  project: { id: string; name: string; description?: string };
  artifacts: VariamosProjectArtifact[];
  profiles: VariamosProjectProfile[];
  artifactProposals?: Array<{ featureId: string; label: string; questions: string[] }>;
  pending?: Array<{ kind: "artifact" | "path" | "profile" | "binding"; featureId: string; question: string }>;
}

export interface GitProjectConnectionInput {
  id: string;
  provider: "git";
  repositoryUrl: string;
  requestedRef: string;
  descriptorPath?: string;
  credentialRef?: string;
  expectedResolvedCommit?: string;
  expectedDescriptorDigest?: string;
}

export interface GitProjectConnection extends GitProjectConnectionInput {
  descriptorPath: string;
  resolvedCommit: string;
  checkoutPath: string;
  descriptorDigest: string;
  validatedAt: string;
}
