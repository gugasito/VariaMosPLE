import axios from "axios";
import { Config } from "../../Config";
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
}

export interface SplDerivationResponse {
  action: SplDerivationAction;
  configurationId: string;
  planDigest?: string;
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
  return `${Config.SERVICES.urlSplOrchestrator.replace(/\/$/, "")}${path}`;
}

function requestHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("authToken") : null;
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function getSplOrchestratorErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseMessage = error.response?.data?.error;
    if (typeof responseMessage === "string") return responseMessage;
    if (error.code === "ECONNABORTED") return "The SPL orchestrator did not respond in time.";
    if (!error.response) return "Could not connect to the local SPL orchestrator.";
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

export async function getSplProfiles(): Promise<SplProfileSummary[]> {
  const response = await axios.get<{ profiles: SplProfileSummary[] }>(endpoint("/api/spl/v1/profiles"), { headers: requestHeaders(), timeout: 10000 });
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
  provider: "git";
  repositoryUrl: string;
  requestedRef: string;
  descriptorPath: string;
  credentialRef?: string;
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

export interface SplLocalDirectoryConnectionInput {
  id: string;
  provider: "local";
  rootPath: string;
  descriptorPath: string;
  snapshotPolicy: "content-digest-v1";
  expectedSnapshotDigest?: string;
  expectedDescriptorDigest?: string;
}

export interface SplLocalDirectoryConnectionResult {
  connection: {
    id: string;
    provider: "local";
    rootPath: string;
    descriptorPath: string;
    snapshotPolicy: "content-digest-v1";
    sourceLocation: string;
    snapshotDigest: string;
    descriptorDigest: string;
    validatedAt: string;
    usesCredentialRef: false;
  };
  descriptor: SplProjectDescriptor;
  validation: { valid: boolean; errors: string[] };
}

export type SplProjectConnectionInput =
  | SplGitConnectionInput
  | SplLocalDirectoryConnectionInput;

export type SplProjectConnectionResult =
  | SplGitConnectionResult
  | SplLocalDirectoryConnectionResult;

export type SplProjectSourceId =
  | "git-remote"
  | "git-local"
  | "local-directory";

export type SplProjectSourceAvailability =
  | "available"
  | "configuration-required"
  | "development";

export interface SplProjectSourceOption {
  id: SplProjectSourceId;
  provider: "git" | "local";
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

export async function importSplProject(connectionId: string, profileId: string): Promise<SplProfileSummary> {
  const response = await axios.post<SplProfileSummary>(endpoint("/api/spl/v1/imports"), { connectionId, profileId }, { headers: requestHeaders(), timeout: 30000 });
  return response.data;
}

export async function validateSplDescriptor(descriptor: unknown, requireReady = false): Promise<{ valid: boolean; errors: string[] }> {
  try {
    const response = await axios.post(endpoint("/api/spl/v1/descriptors/validate"), { descriptor, requireReady }, { headers: requestHeaders(), timeout: 10000 });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 422 && error.response.data) return error.response.data;
    throw error;
  }
}
