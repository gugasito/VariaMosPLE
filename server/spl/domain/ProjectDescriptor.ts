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
  projectId?: string;
  provider: "git";
  repositoryUrl: string;
  requestedRef: string;
  descriptorPath?: string;
  credentialRef?: string;
  sshHostKeyFingerprint?: string;
  expectedResolvedCommit?: string;
  expectedDescriptorDigest?: string;
}

export interface GitProjectConnection extends GitProjectConnectionInput {
  descriptorPath: string;
  resolvedCommit: string;
  descriptorDigest: string;
  validatedAt: string;
}

/** A source snapshot uploaded by the browser. It is never a path on the backend host. */
export interface FolderUploadConnectionInput {
  id: string;
  projectId?: string;
  provider: "upload";
  uploadId: string;
  descriptorPath?: string;
  expectedSnapshotDigest?: string;
  expectedDescriptorDigest?: string;
}

export interface FolderUploadConnection extends FolderUploadConnectionInput {
  descriptorPath: string;
  sourceLocation: string;
  snapshotDigest: string;
  descriptorDigest: string;
  sourceExpiresAt: string;
  validatedAt: string;
}

/** Read-only compatibility shape for data persisted by old versions. Never dereference its paths. */
export interface LegacyLocalDirectoryConnection {
  id: string;
  projectId?: string;
  provider: "local";
  rootPath?: string;
  snapshotPath?: string;
  descriptorPath?: string;
  snapshotDigest?: string;
  descriptorDigest?: string;
  validatedAt?: string;
}

export type ExternalProjectConnectionInput =
  | GitProjectConnectionInput
  | FolderUploadConnectionInput;

export type ExternalProjectConnection =
  | GitProjectConnection
  | FolderUploadConnection
  | LegacyLocalDirectoryConnection;
