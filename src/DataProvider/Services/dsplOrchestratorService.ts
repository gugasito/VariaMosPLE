import axios from "axios";
import { Config } from "../../Config";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import { DsplProfileSummary } from "../../Application/DSPL/DsplMappingFactory";

export type DsplDerivationAction = "plan" | "build" | "deploy";

/**
 * Contrato del flujo DSPL actual. El modelo de features sigue siendo la fuente
 * de las decisiones; el modelo de mapping sólo declara qué artefactos
 * versionados implementan esas decisiones.
 */
export interface DsplMappingDerivationRequest {
  action: DsplDerivationAction;
  projectId: string;
  productLineId: string;
  featureModel: Model;
  mappingModel: Model;
  configurationRef?: {
    id?: string;
    name?: string;
  };
  /** Obligatorio para build/deploy: evita ejecutar un plan ya obsoleto. */
  expectedPlanDigest?: string;
}

export interface DsplDerivationResponse {
  action: DsplDerivationAction;
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
  return `${Config.SERVICES.urlDsplOrchestrator.replace(/\/$/, "")}${path}`;
}

function requestHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("authToken") : null;
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function getDsplOrchestratorErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseMessage = error.response?.data?.error;
    if (typeof responseMessage === "string") return responseMessage;
    if (error.code === "ECONNABORTED") return "El orquestador DSPL no respondió a tiempo.";
    if (!error.response) return "No se pudo conectar al orquestador DSPL local.";
  }
  return error instanceof Error ? error.message : "No se pudo derivar y desplegar el producto.";
}

export async function requestDsplMappingDerivation(
  request: DsplMappingDerivationRequest
): Promise<DsplDerivationResponse> {
  const response = await axios.post<DsplDerivationResponse>(
    endpoint("/api/dspl/v1/derivations"),
    request,
    {
      headers: requestHeaders(),
      timeout: 30000,
    }
  );
  return response.data;
}

export async function getDsplProfiles(): Promise<DsplProfileSummary[]> {
  const response = await axios.get<{ profiles: DsplProfileSummary[] }>(endpoint("/api/dspl/v1/profiles"), { headers: requestHeaders(), timeout: 10000 });
  return response.data.profiles || [];
}

export interface DsplProjectDescriptor {
  schemaVersion: "variamos-project/v1";
  status: "draft" | "ready";
  project: { id: string; name: string; description?: string };
  artifacts: Array<{
    id: string;
    label?: string;
    kind: string;
    version: string;
    source: { path: string };
  }>;
  profiles: Array<{
    id: string;
    name: string;
    builderAdapter: string;
    testAdapter?: string;
    requiredTargetCapabilities: string[];
  }>;
  artifactProposals?: Array<{ featureId: string; label: string; questions: string[] }>;
  pending?: Array<{ kind: string; featureId: string; question: string }>;
}

export interface DsplGitConnectionInput {
  id: string;
  provider: "git";
  repositoryUrl: string;
  requestedRef: string;
  descriptorPath: string;
  credentialRef?: string;
  expectedResolvedCommit?: string;
  expectedDescriptorDigest?: string;
}

export interface DsplGitConnectionResult {
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
  descriptor: DsplProjectDescriptor;
  validation: { valid: boolean; errors: string[] };
}

export async function validateDsplGitConnection(input: DsplGitConnectionInput): Promise<DsplGitConnectionResult> {
  const response = await axios.post<DsplGitConnectionResult>(endpoint("/api/dspl/v1/connections/validate"), input, { headers: requestHeaders(), timeout: 65000 });
  return response.data;
}

export async function saveDsplGitConnection(input: DsplGitConnectionInput): Promise<DsplGitConnectionResult> {
  const response = await axios.post<DsplGitConnectionResult>(endpoint("/api/dspl/v1/connections"), input, { headers: requestHeaders(), timeout: 65000 });
  return response.data;
}

export async function importDsplProject(connectionId: string, profileId: string): Promise<DsplProfileSummary> {
  const response = await axios.post<DsplProfileSummary>(endpoint("/api/dspl/v1/imports"), { connectionId, profileId }, { headers: requestHeaders(), timeout: 30000 });
  return response.data;
}

export async function createDsplDescriptorDraft(input: {
  projectId: string;
  projectName: string;
  features: Array<{ id: string; name?: string }>;
}): Promise<{ descriptor: DsplProjectDescriptor; validation: { valid: boolean; errors: string[] } }> {
  const response = await axios.post(endpoint("/api/dspl/v1/descriptors/draft"), input, { headers: requestHeaders(), timeout: 10000 });
  return response.data;
}

export async function validateDsplDescriptor(descriptor: DsplProjectDescriptor, requireReady = false): Promise<{ valid: boolean; errors: string[] }> {
  try {
    const response = await axios.post(endpoint("/api/dspl/v1/descriptors/validate"), { descriptor, requireReady }, { headers: requestHeaders(), timeout: 10000 });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 422 && error.response.data) return error.response.data;
    throw error;
  }
}
