import Axios from "axios";
import { SPL_CLIENT } from "../../Infraestructure/AxiosConfig";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import { SplProfileSummary } from "../../Application/SPL/SplMappingFactory";

export type SplDerivationAction = "plan" | "build" | "deploy";

/**
 * Contract for the current SPL flow. The feature model remains the source of
 * decisions; the mapping model only declares which versioned artifacts
 * implement them.
 */
export interface SplMappingDerivationRequest {
  action: SplDerivationAction;
  projectId: string;
  productLineId: string;
  featureModel: Model;
  mappingModel: Model;
  configurationRef?: {
    id?: string;
    name?: string;
  };
  /** Required for build/deploy: prevents execution of a stale plan. */
  expectedPlanDigest?: string;
  /** Optional target override. Omitting it preserves mapping.target_ref. */
  targetRef?: string;
  /** Remote target revision returned by Plan. */
  targetRevision?: number;
}

export interface SplDerivationResponse {
  action: SplDerivationAction;
  configurationId: string;
  planDigest?: string;
  buildId?: string;
  targetRevision?: number | null;
  targetName?: string;
  configurationRef?: {
    id?: string;
    name?: string;
  } | null;
  manifest: {
    manifestId: string;
    artifacts: Array<{ id: string }>;
  };
  diagnostics: Array<{ level: string; code: string; message: string }>;
  trace?: Array<{
    sourceFeatureId: string;
    featureId: string;
    bindingElementId: string;
    artifactId: string;
    relationshipId: string;
  }>;
  profile?: {
    mappingRef: string;
    catalogRef: string;
    targetRef: string;
    builderAdapter: string;
    deployerAdapter: string;
  };
  build?: {
    artifactCount: number;
    artifacts: Array<{ id: string }>;
  };
  tests?: {
    status: string;
    results?: Array<{ name: string; status: string }>;
  };
  deployment?: {
    status: string;
    releaseId: string;
    url: string;
  };
}

function endpoint(path: string): string {
  return path.replace(/^\/api\/spl\/v1/, "") || "/";
}

function requestHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
  };
}

// Keep existing call sites concise while routing every request through the
// shared same-origin client and its Bearer interceptor.
const axios = SPL_CLIENT;

export function getSplOrchestratorErrorMessage(error: unknown): string {
  if (Axios.isAxiosError(error)) {
    const responseMessage = error.response?.data?.error;
    if (typeof responseMessage === "string") return responseMessage;
    if (error.code === "ECONNABORTED") return "The VariaMos backend did not respond in time.";
    if (!error.response) return "Could not connect to the VariaMos backend SPL service.";
  }
  return error instanceof Error ? error.message : "The product could not be derived and deployed.";
}

export async function requestSplMappingDerivation(
  request: SplMappingDerivationRequest
): Promise<SplDerivationResponse> {
  const response = await axios.post<SplDerivationResponse>(
    endpoint("/api/spl/v1/derivations"),
    request,
    {
      headers: requestHeaders(),
      timeout: 30000,
    }
  );
  return response.data;
}

export async function getSplProfiles(projectId: string): Promise<SplProfileSummary[]> {
  const query = `?projectId=${encodeURIComponent(projectId)}`;
  const response = await axios.get<{ profiles: SplProfileSummary[] }>(endpoint(`/api/spl/v1/profiles${query}`), { headers: requestHeaders(), timeout: 10000 });
  return response.data.profiles || [];
}

export interface SplProjectDescriptor {
  schemaVersion: "variamos-project/v1";
  status: "draft" | "ready";
  project: { id: string; name: string; description?: string };
  artifacts: Array<{
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
  }>;
  profiles: Array<{
    id: string;
    name: string;
    builderAdapter: string;
    testAdapter?: string;
    artifactIds?: string[];
    requiredTargetCapabilities: string[];
  }>;
  artifactProposals?: Array<{ featureId: string; label: string; questions: string[] }>;
  pending?: Array<{ kind: string; featureId: string; question: string }>;
}

export interface SplGitConnectionInput {
  id: string;
  projectId: string;
  provider: "git";
  repositoryUrl: string;
  requestedRef: string;
  descriptorPath: string;
  credentialRef?: string;
  sshHostKeyFingerprint?: string;
  expectedResolvedCommit?: string;
  expectedDescriptorDigest?: string;
}

export interface SplGitConnectionResult {
  connection: {
    id: string;
    provider: "git";
    repositoryUrl: string;
    requestedRef: string;
    descriptorPath: string;
    resolvedCommit: string;
    descriptorDigest: string;
    validatedAt: string;
    usesCredentialRef: boolean;
  };
  descriptor: SplProjectDescriptor;
  validation: { valid: boolean; errors: string[] };
}

export interface SplFolderUploadConnectionInput {
  id: string;
  projectId: string;
  provider: "upload";
  uploadId: string;
  descriptorPath: string;
  expectedSnapshotDigest?: string;
  expectedDescriptorDigest?: string;
}

export interface SplFolderUploadConnectionResult {
  connection: {
    id: string;
    provider: "upload";
    descriptorPath: string;
    sourceLocation: string;
    snapshotDigest: string;
    descriptorDigest: string;
    validatedAt: string;
    sourceStatus: "available" | "expired" | "missing" | "unsupported";
    sourceExpiresAt?: string;
    usesCredentialRef: false;
  };
  descriptor: SplProjectDescriptor;
  validation: { valid: boolean; errors: string[] };
}

export type SplProjectConnectionInput =
  | SplGitConnectionInput
  | SplFolderUploadConnectionInput;

export type SplProjectConnectionResult =
  | SplGitConnectionResult
  | SplFolderUploadConnectionResult;

export type SplProjectSourceId =
  | "git-remote"
  | "folder-upload";

export type SplProjectSourceAvailability =
  | "available"
  | "configuration-required"
  | "development";

export interface SplProjectSourceOption {
  id: SplProjectSourceId;
  provider: "git" | "upload";
  name: string;
  availability: SplProjectSourceAvailability;
  descriptorPath?: string;
  supportsCredentialRef: boolean;
  help: string;
  plannedFields: string[];
}

export async function getSplProjectSources(): Promise<SplProjectSourceOption[]> {
  const response = await axios.get<{ providers: SplProjectSourceOption[] }>(
    endpoint("/api/spl/v1/providers"),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data.providers || [];
}

export async function validateSplProjectConnection(input: SplProjectConnectionInput): Promise<SplProjectConnectionResult> {
  const response = await axios.post<SplProjectConnectionResult>(endpoint("/api/spl/v1/connections/validate"), input, { headers: requestHeaders(), timeout: 65000 });
  return response.data;
}

export async function saveSplProjectConnection(input: SplProjectConnectionInput): Promise<SplProjectConnectionResult> {
  const response = await axios.post<SplProjectConnectionResult>(endpoint("/api/spl/v1/connections"), input, { headers: requestHeaders(), timeout: 65000 });
  return response.data;
}

export interface SplFolderUploadResult {
  upload: {
    uploadId: string;
    snapshotDigest: string;
    descriptorDigest: string;
    fileCount: number;
    totalBytes: number;
    createdAt: string;
    expiresAt: string;
  };
  validation: { valid: boolean; errors: string[] };
}

export async function uploadSplProjectFolder(
  projectId: string,
  files: Array<{ relativePath: string; file: File }>,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<SplFolderUploadResult> {
  const form = new FormData();
  form.append("metadata", JSON.stringify({ files: files.map((entry, index) => ({ field: `file-${index}`, path: entry.relativePath })) }));
  files.forEach((entry, index) => form.append(`file-${index}`, entry.file, entry.file.name));
  const cancellation = Axios.CancelToken.source();
  signal?.addEventListener("abort", () => cancellation.cancel("Upload cancelled."), { once: true });
  const response = await axios.post<SplFolderUploadResult>(endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/source-uploads`), form, {
    cancelToken: cancellation.token,
    timeout: 120000,
    onUploadProgress: (event) => {
      if (event.total && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    },
  });
  return response.data as SplFolderUploadResult;
}

export async function restoreSplProjectFolderUpload(projectId: string, connectionId: string, uploadId: string) {
  const response = await axios.put(endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}/upload`), { uploadId }, { headers: requestHeaders(), timeout: 30000 });
  return response.data;
}

export async function importSplProject(
  connectionId: string,
  profileId: string,
  projectId: string,
  targetRef?: string
): Promise<SplProfileSummary> {
  const response = await axios.post<SplProfileSummary>(
    endpoint("/api/spl/v1/imports"),
    { connectionId, profileId, projectId, targetRef },
    { headers: requestHeaders(), timeout: 30000 }
  );
  return response.data;
}

export async function validateSplDescriptor(
  descriptor: unknown,
  requireReady = false,
  projectId?: string
): Promise<{ valid: boolean; errors: string[] }> {
  try {
    const response = await axios.post(
      endpoint("/api/spl/v1/descriptors/validate"),
      { descriptor, requireReady, ...(projectId ? { projectId } : {}) },
      { headers: requestHeaders(), timeout: 10000 }
    );
    return response.data;
  } catch (error) {
    if (Axios.isAxiosError(error) && error.response?.status === 422 && error.response.data) return error.response.data;
    throw error;
  }
}

export type SplCredentialPurpose = "source-read";
export type SplCredentialType =
  | "git-https-token-v1"
  | "git-ssh-key-v1";
export type SplCredentialProviderId =
  | "aws-secrets-manager"
  | "macos-keychain";

export interface SplCredentialBinding {
  schemaVersion: "credential-binding/v1";
  id: string;
  ref: string;
  projectId: string;
  alias: string;
  provider: SplCredentialProviderId;
  purpose: SplCredentialPurpose;
  credentialType: SplCredentialType;
  subject: {
    kind: "source-connection";
    id: string;
  };
  activeVersionId?: string;
  status: "pending" | "active" | "revoked";
  createdAt: string;
  validatedAt?: string;
  rotatedAt?: string;
  revokedAt?: string;
  externalRevocationConfirmedAt?: string;
}

export interface SplRemoteTargetInput {
  id: string;
  name: string;
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
    username: string;
  };
}

export interface SplEphemeralSshPassword {
  schemaVersion: "ssh-password/v1";
  username: string;
  password: string;
}

export interface SplEphemeralSshPem {
  schemaVersion: "ssh-pem/v1";
  username: string;
  privateKey: string;
  passphrase?: string;
}

export type SplEphemeralSshCredential = SplEphemeralSshPassword | SplEphemeralSshPem;

export interface SplRemoteTarget {
  schemaVersion: "deployment-target-connection/v1";
  id: string;
  scope: "personal";
  name: string;
  environment?: SplRemoteTargetInput["environment"];
  adapter: "ssh-compose-v1";
  endpoint: SplRemoteTargetInput["endpoint"];
  publishedPort: number;
  publicBaseUrl: string;
  images: SplRemoteTargetInput["images"];
  capabilities: string[];
  authentication: NonNullable<SplRemoteTargetInput["authentication"]>;
  status: "pending" | "active" | "disabled";
  revision: number;
  validatedAt?: string;
}

export interface SplTargetAdapterDefinition {
  id: "ssh-compose-v1";
  name: string;
  availability: "available" | "disabled";
  credentialTypes: [];
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

export interface SplProjectAccess {
  schemaVersion: "spl-project-access/v1";
  projectId: string;
  role: "owner" | "editor" | "viewer";
  permissions: {
    metadataRead: boolean;
    importProject: boolean;
    plan: boolean;
    build: boolean;
    manageTargets: boolean;
    manageCredentials: boolean;
    deploy: boolean;
  };
}

export type SplDeploymentStatus =
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

export interface SplDeploymentExecution {
  schemaVersion: "spl-deployment-execution/v1";
  executionId: string;
  projectId: string;
  buildId: string;
  targetRef: string;
  targetRevision: number;
  expectedPlanDigest: string;
  status: SplDeploymentStatus;
  createdAt: string;
  updatedAt: string;
  stageMessage?: string;
  safeError?: string;
  releaseId?: string;
  publicUrl?: string;
  cancelRequestedAt?: string;
  rollback?: {
    attempted: boolean;
    succeeded: boolean;
    safeError?: string;
  };
}

export async function getSplTargetAdapters(): Promise<SplTargetAdapterDefinition[]> {
  const response = await axios.get<{ adapters: SplTargetAdapterDefinition[] }>(
    endpoint("/api/spl/v1/target-adapters"),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data.adapters || [];
}

export interface SplRuntimeCapabilities {
  schemaVersion: "spl-runtime-capabilities/v1";
  /** Development fixtures only; production always reports false. */
  localTargetsEnabled: boolean;
}

export async function getSplRuntimeCapabilities(): Promise<SplRuntimeCapabilities> {
  const response = await axios.get<SplRuntimeCapabilities>(
    endpoint("/api/spl/v1/runtime"),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data;
}

export async function getSplProjectAccess(projectId: string): Promise<SplProjectAccess> {
  const response = await axios.get<SplProjectAccess>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/access`),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data;
}

export async function getSplTargets(projectId: string): Promise<SplRemoteTarget[]> {
  const response = await axios.get<{ targets: SplRemoteTarget[] }>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/targets`),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data.targets || [];
}

export async function validateSplTarget(
  projectId: string,
  input: SplRemoteTargetInput,
  ephemeralCredential?: SplEphemeralSshCredential
): Promise<{ valid: true; target: SplRemoteTarget }> {
  const response = await axios.post(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/targets/validate`),
    { ...input, ...(ephemeralCredential ? { ephemeralCredential } : {}) },
    { headers: requestHeaders(), timeout: 30000 }
  );
  return response.data;
}

export async function createSplTarget(
  projectId: string,
  input: SplRemoteTargetInput,
  ephemeralCredential?: SplEphemeralSshCredential
): Promise<SplRemoteTarget> {
  const response = await axios.post<SplRemoteTarget>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/targets`),
    { ...input, ...(ephemeralCredential ? { ephemeralCredential } : {}) },
    { headers: requestHeaders(), timeout: 30000 }
  );
  return response.data;
}

export async function updateSplTarget(
  projectId: string,
  targetRef: string,
  input: Partial<Omit<SplRemoteTargetInput, "id" | "adapter">>
): Promise<SplRemoteTarget> {
  const response = await axios.patch<SplRemoteTarget>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/targets/${encodeURIComponent(targetRef)}`),
    input,
    { headers: requestHeaders(), timeout: 30000 }
  );
  return response.data;
}

export async function deleteSplTarget(
  projectId: string,
  targetRef: string
): Promise<{ deleted: true; targetRef: string }> {
  const response = await axios.delete<{ deleted: true; targetRef: string }>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/targets/${encodeURIComponent(targetRef)}`),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data;
}

export async function getSplCredentialBindings(projectId: string): Promise<SplCredentialBinding[]> {
  const response = await axios.get<{ bindings: SplCredentialBinding[] }>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/credential-bindings`),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data.bindings || [];
}

export interface SplCredentialRegistrationInput {
  id: string;
  alias: string;
  purpose: SplCredentialPurpose;
  credentialType: SplCredentialType;
  externalSecretId: string;
  subject: SplCredentialBinding["subject"];
}

export async function validateSplCredentialReference(
  projectId: string,
  input: Pick<SplCredentialRegistrationInput, "purpose" | "credentialType" | "externalSecretId">
): Promise<{ valid: true; versionId: string; credentialType: SplCredentialType }> {
  const response = await axios.post(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/credential-bindings/validate`),
    input,
    { headers: requestHeaders(), timeout: 20000 }
  );
  return response.data;
}

export async function createSplCredentialBinding(
  projectId: string,
  input: SplCredentialRegistrationInput
): Promise<SplCredentialBinding> {
  const response = await axios.post<SplCredentialBinding>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/credential-bindings`),
    input,
    { headers: requestHeaders(), timeout: 20000 }
  );
  return response.data;
}

async function credentialAction(
  projectId: string,
  bindingId: string,
  action: "validate-current" | "revoke" | "confirm-external-revocation"
): Promise<SplCredentialBinding> {
  const response = await axios.post<SplCredentialBinding>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/credential-bindings/${encodeURIComponent(bindingId)}/${action}`),
    {},
    { headers: requestHeaders(), timeout: action === "validate-current" ? 30000 : 10000 }
  );
  return response.data;
}

export function validateCurrentSplCredential(projectId: string, bindingId: string) {
  return credentialAction(projectId, bindingId, "validate-current");
}

export function revokeSplCredential(projectId: string, bindingId: string) {
  return credentialAction(projectId, bindingId, "revoke");
}

export function confirmExternalSplCredentialRevocation(projectId: string, bindingId: string) {
  return credentialAction(projectId, bindingId, "confirm-external-revocation");
}

export async function createSplDeployment(input: {
  projectId: string;
  buildId: string;
  targetRef: string;
  targetRevision: number;
  expectedPlanDigest: string;
  idempotencyKey: string;
  ephemeralCredential?: SplEphemeralSshCredential;
}): Promise<SplDeploymentExecution> {
  const response = await axios.post<SplDeploymentExecution>(
    endpoint("/api/spl/v1/deployments"),
    input,
    {
      headers: { ...requestHeaders(), "Idempotency-Key": input.idempotencyKey },
      timeout: 10000,
    }
  );
  return response.data;
}

export async function getSplDeployment(executionId: string): Promise<SplDeploymentExecution> {
  const response = await axios.get<SplDeploymentExecution>(
    endpoint(`/api/spl/v1/deployments/${encodeURIComponent(executionId)}`),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data;
}

export async function cancelSplDeployment(executionId: string): Promise<SplDeploymentExecution> {
  const response = await axios.post<SplDeploymentExecution>(
    endpoint(`/api/spl/v1/deployments/${encodeURIComponent(executionId)}/cancel`),
    {},
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data;
}

export async function getSplDeployments(projectId: string): Promise<SplDeploymentExecution[]> {
  const response = await axios.get<{ deployments: SplDeploymentExecution[] }>(
    endpoint(`/api/spl/v1/projects/${encodeURIComponent(projectId)}/deployments`),
    { headers: requestHeaders(), timeout: 10000 }
  );
  return response.data.deployments || [];
}
