import { DeploymentManifest } from "../contracts";

export type ProjectRole = "owner" | "editor" | "viewer";
export type AuthorizationAction =
  | "metadata:read"
  | "project:import"
  | "derivation:plan"
  | "derivation:build"
  | "target:manage"
  | "credential:manage"
  | "deployment:manage";

export interface AuthenticatedProjectActor {
  userId: string;
  displayName?: string;
  role: ProjectRole;
  projectId: string;
  token?: string;
}

export type CredentialPurpose = "source-read" | "deployment";
export type CredentialType =
  | "git-https-token-v1"
  | "git-ssh-key-v1"
  | "ssh-deployment-v1";
export type CredentialProviderId =
  | "aws-secrets-manager"
  | "macos-keychain";
export type CredentialBindingStatus = "pending" | "active" | "revoked";

export interface CredentialBindingSubject {
  kind: "source-connection" | "deployment-target";
  id: string;
}

export interface CredentialBinding {
  schemaVersion: "credential-binding/v1";
  id: string;
  ref: string;
  projectId: string;
  alias: string;
  provider: CredentialProviderId;
  purpose: CredentialPurpose;
  credentialType: CredentialType;
  externalSecretId: string;
  subject: CredentialBindingSubject;
  activeVersionId?: string;
  status: CredentialBindingStatus;
  createdAt: string;
  createdBy: string;
  validatedAt?: string;
  validatedBy?: string;
  rotatedAt?: string;
  rotatedBy?: string;
  revokedAt?: string;
  revokedBy?: string;
  externalRevocationConfirmedAt?: string;
  externalRevocationConfirmedBy?: string;
}

export type PublicCredentialBinding = Omit<
  CredentialBinding,
  "externalSecretId"
>;

export interface GitHttpsTokenPayload {
  schemaVersion: "git-https-token/v1";
  username: string;
  token: string;
}

export interface GitSshKeyPayload {
  schemaVersion: "git-ssh-key/v1";
  username: string;
  privateKey: string;
  passphrase?: string;
}

export interface SshDeploymentPayload {
  schemaVersion: "ssh-deployment/v1";
  username: string;
  privateKey: string;
  passphrase?: string;
}

/**
 * One-time password supplied by an owner for an SSH server. This payload
 * is intentionally excluded from CredentialPayload because it may never be
 * stored by a CredentialProvider or in the secure state repository.
 */
export interface SshPasswordPayload {
  schemaVersion: "ssh-password/v1";
  username: string;
  password: string;
}

export interface EphemeralSshPasswordInput {
  schemaVersion: "ssh-password/v1";
  username: string;
  password: string;
}

/** A one-time PEM key supplied directly for validation or a deployment job. */
export interface EphemeralSshPemInput {
  schemaVersion: "ssh-pem/v1";
  username: string;
  privateKey: string;
  passphrase?: string;
}

export type EphemeralSshCredentialInput = EphemeralSshPasswordInput | EphemeralSshPemInput;
export type EphemeralSshCredentialPayload = SshPasswordPayload | EphemeralSshPemInput;

export type CredentialPayload =
  | GitHttpsTokenPayload
  | GitSshKeyPayload
  | SshDeploymentPayload;

export interface DeploymentTargetConnection {
  schemaVersion: "deployment-target-connection/v1";
  id: string;
  /** Internal persistence scope; never returned by the public API. */
  ownerUserId: string;
  name: string;
  /** Optional operational classification. It does not change deployment mechanics. */
  environment?: "development" | "staging" | "production";
  adapter: "ssh-compose-v1";
  endpoint: {
    host: string;
    port: number;
    sshHostKeyFingerprint: string;
  };
  remoteBasePath: string;
  publishedPort: number;
  publicBaseUrl: string;
  images: {
    nginx?: string;
    node?: string;
  };
  capabilities: string[];
  authentication: {
    mode: "prompt-password" | "prompt-pem";
    /** Persisted so the owner only has to re-enter the password. */
    username: string;
  };
  /** @deprecated Read only for rejecting historical managed-key records. */
  deploymentCredentialRef?: string;
  status: "pending" | "active" | "disabled";
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  validatedAt?: string;
  validatedBy?: string;
  disabledAt?: string;
  disabledBy?: string;
}

export type PublicDeploymentTarget = Omit<
  DeploymentTargetConnection,
  "deploymentCredentialRef" | "remoteBasePath" | "ownerUserId"
> & { scope: "personal" };

export interface BuildRecord {
  schemaVersion: "spl-build-record/v1";
  buildId: string;
  projectId: string;
  manifest: DeploymentManifest;
  manifestDigest: string;
  planDigest: string;
  targetRef: string;
  targetRevision?: number;
  outputDirectory: string;
  outputDigest: string;
  tests: {
    status: "passed";
    results?: Array<{ name: string; status: string }>;
  };
  builderAdapter: string;
  createdAt: string;
  createdBy: string;
}

export type DeploymentExecutionStatus =
  | "queued"
  | "authorizing"
  | "resolving-credential"
  | "connecting"
  | "uploading"
  | "deploying"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolled-back"
  | "interrupted";

export interface DeploymentExecution {
  schemaVersion: "spl-deployment-execution/v1";
  executionId: string;
  idempotencyKey: string;
  projectId: string;
  buildId: string;
  targetRef: string;
  /** Owner scope of the target at the time the deployment was created. */
  targetOwnerUserId?: string;
  targetRevision: number;
  expectedPlanDigest: string;
  status: DeploymentExecutionStatus;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  stageMessage?: string;
  errorCode?: string;
  safeError?: string;
  releaseId?: string;
  publicUrl?: string;
  rollback?: {
    attempted: boolean;
    succeeded: boolean;
    safeError?: string;
  };
}

export interface RemoteReleaseRecord {
  schemaVersion: "ssh-compose-release/v1";
  projectId: string;
  targetRef: string;
  releaseId: string;
  manifestId: string;
  builderAdapter: string;
  remoteDirectory: string;
  composeProject: string;
  publicUrl: string;
  deployedAt: string;
  previousReleaseId?: string;
}

export interface TargetAdapterDefinition {
  id: string;
  name: string;
  availability: "available" | "disabled";
  credentialTypes: CredentialType[];
  capabilities: string[];
  authenticationModes: Array<{
    id: "prompt-password" | "prompt-pem";
    name: string;
    description: string;
    storesSecret: boolean;
    availability: "available" | "disabled";
  }>;
  presets: Array<{
    id: string;
    name: string;
    description: string;
    builderAdapters: string[];
    capabilities: string[];
    defaultPublishedPort: number;
    images: {
      nginx?: string;
      node?: string;
    };
  }>;
  configurationSchema: Record<string, unknown>;
}

export interface AuditEvent {
  event: string;
  result: "allowed" | "denied" | "succeeded" | "failed" | "requested";
  actorId?: string;
  projectId?: string;
  targetRef?: string;
  credentialAlias?: string;
  credentialVersionId?: string;
  executionId?: string;
  details?: Record<string, unknown>;
}
