import crypto from "crypto";
import Busboy from "busboy";
import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { NodeModularMonolithBuilder } from "./adapters/builders/NodeModularMonolithBuilder";
import { StaticSiteBuilder } from "./adapters/builders/StaticSiteBuilder";
import { NginxContainerDeployer } from "./adapters/deployers/NginxContainerDeployer";
import { NodeContainerDeployer } from "./adapters/deployers/NodeContainerDeployer";
import {
  DeploymentTargetAdapter,
  DeploymentTargetAdapterRegistry,
  RemoteDeploymentError,
} from "./adapters/deployers/DeploymentTargetAdapter";
import { SshComposeDeployer } from "./adapters/deployers/SshComposeDeployer";
import { ArtifactProviderRegistry } from "./adapters/providers/ArtifactProvider";
import { GitArtifactProvider } from "./adapters/providers/GitArtifactProvider";
import { LocalArtifactProvider } from "./adapters/providers/LocalArtifactProvider";
import {
  GitHttpsAuthenticationAdapter,
  GitSshAuthenticationAdapter,
  PublicOrLocalGitAuthenticationAdapter,
  SourceAuthenticationAdapterRegistry,
} from "./adapters/providers/SourceAuthentication";
import { VariaMosSerializedModel } from "./adapters/variamos/VariaMosModelTypes";
import { SplMappingModelAdapter } from "./adapters/variamos/SplMappingModelAdapter";
import { validateFeatureModel } from "./adapters/variamos/FeatureModelValidator";
import { HtmlValidationAdapter } from "./adapters/tests/HtmlValidationAdapter";
import { NodeTestAdapter } from "./adapters/tests/NodeTestAdapter";
import { ArtifactCatalog, DeploymentTarget } from "./contracts";
import { DerivationResolver } from "./DerivationResolver";
import {
  ExternalProjectError,
  ExternalProjectService,
  ExternalProjectTarget,
} from "./application/ExternalProjectService";
import { ExternalProjectConnectionInput } from "./domain/ProjectDescriptor";
import { TemporaryUploadStore, UploadFileInput } from "./application/TemporaryUploadStore";
import {
  BuildRecordService,
  DeploymentJobService,
  DeploymentJobServiceError,
} from "./application/DeploymentJobService";
import {
  DeploymentTargetInput,
  DeploymentTargetService,
  DeploymentTargetServiceError,
} from "./application/DeploymentTargetService";
import { SecureStateRepository } from "./security/AtomicStateStore";
import {
  AuthorizationError,
  ProjectAuthorizer,
  VariaMosProjectAuthorizer,
} from "./security/Authorization";
import {
  AwsSecretsManagerCredentialProvider,
  CredentialBroker,
  CredentialBrokerError,
  CredentialProvider,
  CredentialProviderRegistry,
  CredentialRegistrationInput,
  CredentialValidationInput,
  MacOsKeychainCredentialProvider,
} from "./security/CredentialBroker";
import { HostPolicy, HostPolicyError } from "./security/HostPolicy";
import { SafeAuditLogger } from "./security/SafeAuditLogger";
import {
  AuthenticatedProjectActor,
  AuthorizationAction,
  EphemeralSshCredentialInput,
} from "./security/SecureTypes";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type DerivationAction = "plan" | "build" | "deploy";

export interface SplHttpServerConfig {
  gitRepositories?: Record<string, string>;
  localRoots?: Record<string, string>;
  outputRoot: string;
  releaseStateDirectory: string;
  allowedOrigins: string[];
  resourceRegistryPath?: string;
  /** Local registry targets are a development/test fixture only. */
  localTargetsEnabled?: boolean;
  externalProjectStateDirectory?: string;
  projectDescriptorSchemaPath?: string;
  temporaryUploadDirectory?: string;
  folderUploadEnabled?: boolean;
  uploadTtlMs?: number;
  uploadMaxBytes?: number;
  uploadMaxFiles?: number;
  remoteDeploymentEnabled?: boolean;
  sessionInfoUrl?: string;
  projectInfoUrl?: string;
  secureStateDirectory?: string;
  auditSink?: "file" | "stdout" | "both";
  auditFilePath?: string;
  secretBackend?: "aws" | "macos-keychain" | "none";
  localMacSshTestMode?: boolean;
  awsRegion?: string;
  gitHostAllowlist?: string[];
  sshHostAllowlist?: string[];
  healthHostAllowlist?: string[];
  credentialProvider?: CredentialProvider;
  /** In-process test seam. The runtime/CLI configuration never exposes it. */
  authorizer?: ProjectAuthorizer;
  deploymentTargetAdapters?: DeploymentTargetAdapter[];
  runtimePlatform?: NodeJS.Platform;
  nodeEnvironment?: string;
}

interface SplMappingDerivationRequestBody {
  action?: DerivationAction;
  projectId: string;
  productLineId: string;
  configurationRef?: { id?: string; name?: string };
  featureModel: VariaMosSerializedModel;
  mappingModel: VariaMosSerializedModel;
  expectedPlanDigest?: string;
  targetRef?: string;
  targetRevision?: number;
}

interface SplResourceRegistry {
  schemaVersion: "spl-resource-registry/v1";
  catalogs: Record<string, string>;
  targets: Record<string, {
    path: string;
    port: number;
    releaseState: string;
    dataState?: string;
  }>;
  profiles?: Record<string, {
    name: string;
    mappingRef: string;
    catalogRef: string;
    targetRef: string;
  }>;
  localRoots?: Record<string, string>;
}

export class SplHttpServerError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SplHttpServerError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, SplHttpServerError.prototype);
  }
}

function loadJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(fileName), "utf8")) as T;
}

function isStableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
  );
}

function isLoopbackOnlyAllowlist(values: string[] | undefined): boolean {
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  return Boolean(
    values?.length &&
    values.every((value) => loopback.has(value.trim().toLowerCase()))
  );
}

function isModel(value: unknown): value is VariaMosSerializedModel {
  if (!value || typeof value !== "object") {
    return false;
  }
  const model = value as Partial<VariaMosSerializedModel>;
  return (
    typeof model.id === "string" &&
    typeof model.type === "string" &&
    Array.isArray(model.elements) &&
    Array.isArray(model.relationships)
  );
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new SplHttpServerError(413, "The SPL request exceeds the allowed size."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new SplHttpServerError(400, "The request body must contain valid JSON."));
      }
    });
    request.on("error", (error) => reject(error));
  });
}

/** Receives only the explicitly listed descriptor/artifact files; names from the browser are ignored. */
function readFolderUpload(request: IncomingMessage, maxBytes: number, maxFiles: number): Promise<UploadFileInput[]> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.startsWith("multipart/form-data")) return reject(new SplHttpServerError(415, "Project folders must be uploaded as multipart/form-data."));
    let mapping: Record<string, string> | undefined;
    const received: Array<{ field: string; content: Buffer }> = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); request.unpipe(); request.resume(); } };
    let parser: Busboy.Busboy;
    try { parser = Busboy({ headers: request.headers, limits: { files: maxFiles, fileSize: 5 * 1024 * 1024, fields: 2 } }); }
    catch (_error) { reject(new SplHttpServerError(400, "The upload content type is invalid.")); return; }
    parser.on("field", (name, value) => {
      if (name !== "metadata" || mapping) return fail(new SplHttpServerError(400, "The upload metadata is invalid."));
      try {
        const parsed = JSON.parse(value) as { files?: Array<{ field: string; path: string }> };
        mapping = Object.fromEntries((parsed.files || []).map((item) => [item.field, item.path]));
        if (!Object.keys(mapping).length) throw new Error("empty");
      } catch (_error) { fail(new SplHttpServerError(400, "The upload metadata must list the selected files.")); }
    });
    parser.on("file", (field, stream) => {
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      stream.on("data", (chunk: Buffer) => {
        fileBytes += chunk.length; total += chunk.length;
        if (total > maxBytes) fail(new SplHttpServerError(413, "The project upload exceeds the allowed size."));
        else chunks.push(chunk);
      });
      stream.on("limit", () => fail(new SplHttpServerError(413, "An uploaded artifact exceeds the 5 MiB limit.")));
      stream.on("end", () => { if (!settled) received.push({ field, content: Buffer.concat(chunks, fileBytes) }); });
    });
    parser.on("filesLimit", () => fail(new SplHttpServerError(413, `The project upload exceeds the ${maxFiles}-file limit.`)));
    parser.on("error", () => fail(new SplHttpServerError(400, "The project upload could not be read.")));
    parser.on("finish", () => {
      if (settled) return;
      if (!mapping || received.length !== Object.keys(mapping).length) return fail(new SplHttpServerError(400, "The upload files do not match its metadata."));
      const files = received.map((item) => ({ relativePath: mapping![item.field], content: item.content }));
      if (files.some((file) => !file.relativePath)) return fail(new SplHttpServerError(400, "The upload contains an unknown file."));
      settled = true; resolve(files);
    });
    request.pipe(parser);
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function createMappingConfigurationId(
  featureModel: VariaMosSerializedModel,
  mappingModel: VariaMosSerializedModel
): string {
  const selected = featureModel.elements
    .map((element) => ({
      id: element.id,
      selected: (element.properties || []).find((property) => property.name === "Selected")?.value,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const relevant = {
    featureModelId: featureModel.id,
    selected,
    mappingModelId: mappingModel.id,
    sourceModelIds: mappingModel.sourceModelIds || [],
    mappingProperties: mappingModel.elements
      .map((element) => ({
        id: element.id,
        type: element.type,
        properties: (element.properties || []).map((property) => ({ name: property.name, value: property.value }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    relationships: mappingModel.relationships
      .map((relationship) => ({ id: relationship.id, type: relationship.type, sourceId: relationship.sourceId, targetId: relationship.targetId }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const suffix = crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 16);
  return `configuration.${featureModel.id.toLowerCase()}.${suffix}`;
}

function createModelVersion(featureModel: VariaMosSerializedModel): string {
  const suffix = crypto
    .createHash("sha256")
    .update(JSON.stringify({ id: featureModel.id, elements: featureModel.elements, relationships: featureModel.relationships }))
    .digest("hex")
    .slice(0, 16);
  return `model.${featureModel.id.toLowerCase()}.${suffix}`;
}

function createPlanDigest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validateMappingRequestBody(value: unknown): SplMappingDerivationRequestBody {
  if (!value || typeof value !== "object") {
    throw new SplHttpServerError(400, "The SPL request must be a JSON object.");
  }
  const body = value as Partial<SplMappingDerivationRequestBody>;
  const action = body.action || "plan";
  if (action !== "plan" && action !== "build" && action !== "deploy") {
    throw new SplHttpServerError(400, "action must be plan, build, or deploy.");
  }
  if (!isStableId(body.projectId) || !isStableId(body.productLineId) || !isModel(body.featureModel) || !isModel(body.mappingModel)) {
    throw new SplHttpServerError(400, "projectId, productLineId, featureModel, and mappingModel must use a valid SPL format.");
  }
  if ((action === "build" || action === "deploy") && (!body.expectedPlanDigest || !/^sha256:[a-f0-9]{64}$/.test(body.expectedPlanDigest))) {
    throw new SplHttpServerError(400, "build and deploy require expectedPlanDigest from a valid plan.");
  }
  if (body.targetRef !== undefined && !isStableId(body.targetRef)) {
    throw new SplHttpServerError(400, "targetRef must be a stable target identifier.");
  }
  if (
    body.targetRevision !== undefined &&
    (!Number.isInteger(body.targetRevision) || (body.targetRevision as number) < 1)
  ) {
    throw new SplHttpServerError(400, "targetRevision must be a positive integer.");
  }
  return {
    action,
    projectId: body.projectId,
    productLineId: body.productLineId,
    configurationRef: body.configurationRef,
    featureModel: body.featureModel,
    mappingModel: body.mappingModel,
    expectedPlanDigest: body.expectedPlanDigest,
    targetRef: body.targetRef,
    targetRevision: body.targetRevision,
  };
}

function resolveRegistryPath(registryPath: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new SplHttpServerError(422, "The SPL registry contains an unauthorized relative path.");
  }
  const root = path.dirname(path.resolve(registryPath));
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new SplHttpServerError(422, "The SPL registry attempts to resolve outside its directory.");
  }
  return resolved;
}

function setCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: string[]
): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  if (!allowedOrigins.includes(origin)) {
    sendJson(response, 403, { error: "The origin is not authorized to use the SPL orchestrator." });
    return false;
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization, idempotency-key");
  return true;
}

export interface SplHttpHandler extends http.RequestListener {
  shutdown(): void;
}

export function createSplHttpHandler(config: SplHttpServerConfig): SplHttpHandler {
  const remoteEnabled = Boolean(config.remoteDeploymentEnabled);
  const secureStateDirectory = config.secureStateDirectory ||
    path.join(config.externalProjectStateDirectory || path.join(process.cwd(), ".runtime/spl/projects/imports"), "secure");
  const auditSink = config.auditSink || "file";
  const auditFilePath = config.auditFilePath || path.join(secureStateDirectory, "audit", "spl-audit.jsonl");
  const gitHosts = new HostPolicy(
    config.gitHostAllowlist || [],
    "Git"
  );
  const sshHosts = new HostPolicy(config.sshHostAllowlist || [], "SSH");
  const healthHosts = new HostPolicy(config.healthHostAllowlist || [], "health-check");
  const awsSecretsEnabled = config.secretBackend === "aws";
  const macOsKeychainEnabled = config.secretBackend === "macos-keychain";
  const secretProviderEnabled = awsSecretsEnabled || macOsKeychainEnabled;
  const runtimePlatform = config.runtimePlatform || "linux";
  const nodeEnvironment = config.nodeEnvironment || "production";
  const missing = [
    !config.authorizer && !config.sessionInfoUrl ? "identity session URL" : "",
    !config.authorizer && !config.projectInfoUrl ? "project permission URL" : "",
    awsSecretsEnabled && !config.awsRegion && !config.credentialProvider ? "SPL_AWS_REGION" : "",
    (remoteEnabled || secretProviderEnabled) && !gitHosts.configured() ? "SPL_GIT_HOST_ALLOWLIST" : "",
    remoteEnabled && !sshHosts.configured() ? "SPL_SSH_HOST_ALLOWLIST" : "",
    remoteEnabled && !healthHosts.configured() ? "SPL_HEALTH_HOST_ALLOWLIST" : "",
    macOsKeychainEnabled && !config.localMacSshTestMode ? "SPL_LOCAL_MAC_SSH_TEST_MODE=true" : "",
    macOsKeychainEnabled && runtimePlatform !== "darwin" ? "macOS runtime" : "",
    macOsKeychainEnabled && nodeEnvironment === "production" ? "non-production NODE_ENV" : "",
    macOsKeychainEnabled && !isLoopbackOnlyAllowlist(config.sshHostAllowlist)
      ? "loopback-only SPL_SSH_HOST_ALLOWLIST"
      : "",
    macOsKeychainEnabled && !isLoopbackOnlyAllowlist(config.healthHostAllowlist)
      ? "loopback-only SPL_HEALTH_HOST_ALLOWLIST"
      : "",
    !auditSink ? "audit sink" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`The authenticated SPL orchestrator cannot start because these controls are missing: ${missing.join(", ")}.`);
  }
  const audit = new SafeAuditLogger({
    sink: auditSink,
    ...(auditSink === "file" || auditSink === "both" ? { filePath: auditFilePath } : {}),
  });
  const repository = new SecureStateRepository(secureStateDirectory);
  const unavailableProviderId = macOsKeychainEnabled
    ? "macos-keychain" as const
    : "aws-secrets-manager" as const;
  const unavailableProvider: CredentialProvider = {
    id: unavailableProviderId,
    async describeSecret() {
      throw new CredentialBrokerError("The credential provider is not configured.");
    },
    async getSecretValue() {
      throw new CredentialBrokerError("The credential provider is not configured.");
    },
  };
  const credentialProvider = config.credentialProvider ||
    (config.secretBackend === "aws" && config.awsRegion
      ? new AwsSecretsManagerCredentialProvider({ region: config.awsRegion })
      : config.secretBackend === "macos-keychain"
        ? new MacOsKeychainCredentialProvider({ platform: runtimePlatform })
      : unavailableProvider);
  const credentialBroker = new CredentialBroker({
    repository,
    providers: new CredentialProviderRegistry([credentialProvider]),
    audit,
    defaultProviderId: credentialProvider.id,
  });
  const sshCompose = new SshComposeDeployer({ sshHosts, healthHosts });
  const targetAdapters = new DeploymentTargetAdapterRegistry(
    config.deploymentTargetAdapters || [sshCompose]
  );
  const targetService = new DeploymentTargetService({
    repository,
    adapters: targetAdapters,
    sshHosts,
    healthHosts,
    audit,
    remoteEnabled,
  });
  const authorizer = config.authorizer || new VariaMosProjectAuthorizer({
    sessionInfoUrl: config.sessionInfoUrl || "",
    projectInfoUrl: config.projectInfoUrl || "",
    audit,
  });
  const buildRecords = new BuildRecordService(repository);
  const deploymentJobs = new DeploymentJobService({
    repository,
    targets: targetService,
    adapters: targetAdapters,
    authorizer,
    audit,
  });
  const sourceAuthentication = new SourceAuthenticationAdapterRegistry([
    new GitHttpsAuthenticationAdapter(credentialBroker, gitHosts),
    new GitSshAuthenticationAdapter(credentialBroker, gitHosts),
    new PublicOrLocalGitAuthenticationAdapter(gitHosts),
  ]);
  const resourceRegistryPath = config.resourceRegistryPath;
  const resourceRegistry = resourceRegistryPath
    ? loadJson<SplResourceRegistry>(resourceRegistryPath)
    : undefined;
  const localTargetsEnabled = Boolean(config.localTargetsEnabled !== false && resourceRegistry && resourceRegistryPath);
  const resolver = new DerivationResolver();
  const mappingModelAdapter = new SplMappingModelAdapter();
  const staticBuilder = new StaticSiteBuilder();
  const nodeBuilder = new NodeModularMonolithBuilder();
  const staticDeployer = new NginxContainerDeployer();
  const nodeDeployer = new NodeContainerDeployer();
  const htmlTests = new HtmlValidationAdapter();
  const nodeTests = new NodeTestAdapter();

  const registeredTargets = (ownerUserId?: string): ExternalProjectTarget[] => {
    const localTargets = !localTargetsEnabled
      ? []
      : Object.entries(resourceRegistry!.targets).map(([ref, entry]) => ({
      ref,
      target: loadJson<DeploymentTarget>(resolveRegistryPath(resourceRegistryPath!, entry.path)),
      port: entry.port,
      releaseState: entry.releaseState,
      ...(entry.dataState ? { dataState: entry.dataState } : {}),
    }));
    const remoteTargets = ownerUserId
      ? repository.listTargets(ownerUserId)
        .filter((target) => target.status === "active")
        .map((target) => ({
          ref: target.id,
          target: targetService.asResolverTarget(target),
          port: target.publishedPort,
          releaseState: target.id,
        }))
      : [];
    return [...localTargets, ...remoteTargets];
  };
  const uploadStore = new TemporaryUploadStore({
    rootDirectory: config.temporaryUploadDirectory || path.join(process.cwd(), ".runtime/spl/temporary/uploads"),
    ttlMs: config.uploadTtlMs || 24 * 60 * 60 * 1000,
    maxBytes: config.uploadMaxBytes || 100 * 1024 * 1024,
    maxFiles: config.uploadMaxFiles || 500,
  });
  const externalProjects = new ExternalProjectService({
    stateDirectory: config.externalProjectStateDirectory || path.join(process.cwd(), ".runtime/spl/projects/imports"),
    descriptorSchemaPath:
      config.projectDescriptorSchemaPath ||
      path.join(process.cwd(), "contracts/schemas/variamos-project.schema.json"),
    folderUploadEnabled: config.folderUploadEnabled || false,
    uploadStore,
    targets: registeredTargets,
    sourceAuthentication,
    remoteGitConfigured: gitHosts.configured(),
  });

  const getMappingResources = (
    mappingModel: VariaMosSerializedModel,
    projectId: string,
    ownerUserId?: string,
    requestedTargetRef?: string,
    requestedTargetRevision?: number,
    requiresSource = true,
  ) => {
    const root = mappingModel.elements.find((element) => element.type === "DeploymentMapping");
    const getProperty = (name: string): string | undefined => {
      const property = (root?.properties || []).find((candidate) => candidate.name === name);
      return typeof property?.value === "string" ? property.value : undefined;
    };
    const catalogRef = getProperty("catalog_ref");
    const mappingTargetRef = getProperty("target_ref");
    if (!isStableId(catalogRef) || !isStableId(mappingTargetRef)) {
      throw new SplHttpServerError(422, "DeploymentMapping must declare stable catalog_ref and target_ref values.");
    }
    const targetRef = requestedTargetRef || mappingTargetRef;
    const external = externalProjects.catalogResources(
      catalogRef,
      projectId,
      requiresSource,
    );
    let catalog: ArtifactCatalog;
    let providers: ArtifactProviderRegistry;
    if (external) {
      catalog = external.catalog;
      providers = new ArtifactProviderRegistry([
        new GitArtifactProvider({ repositories: external.gitRepositories }),
        new LocalArtifactProvider({ roots: external.localRoots }),
      ]);
    } else {
      if (!resourceRegistry || !resourceRegistryPath) {
        throw new SplHttpServerError(503, "The orchestrator does not have an SPL resource registry configured.");
      }
      const catalogRelativePath = resourceRegistry.catalogs[catalogRef];
      if (!catalogRelativePath) {
        throw new SplHttpServerError(422, "The referenced catalog is not authorized by the SPL registry.");
      }
      catalog = loadJson<ArtifactCatalog>(resolveRegistryPath(resourceRegistryPath, catalogRelativePath));
      const registryRoot = path.dirname(path.resolve(resourceRegistryPath));
      const localRoots = {
        ...(config.localRoots || {}),
        ...Object.fromEntries(
          Object.entries(resourceRegistry.localRoots || {}).map(([id, localPath]) => [
            id,
            path.resolve(registryRoot, localPath),
          ])
        ),
      };
      providers = new ArtifactProviderRegistry([
        new GitArtifactProvider({ repositories: config.gitRepositories || {} }),
        new LocalArtifactProvider({ roots: localRoots }),
      ]);
    }
    const remoteTarget = ownerUserId ? repository.getTarget(ownerUserId, targetRef) : undefined;
    if (remoteTarget) {
      if (remoteTarget.status !== "active") {
        throw new SplHttpServerError(409, "The selected remote target is disabled.");
      }
      if (
        requestedTargetRevision !== undefined &&
        requestedTargetRevision !== remoteTarget.revision
      ) {
        throw new SplHttpServerError(409, "The selected target changed; generate a new plan.");
      }
      return {
        catalog,
        target: targetService.asResolverTarget(remoteTarget),
        targetEntry: { remote: true as const },
        providers,
        targetRef,
        targetRevision: remoteTarget.revision,
        targetName: remoteTarget.name,
        remote: true as const,
      };
    }
    if (config.localTargetsEnabled === false) {
      throw new SplHttpServerError(404, "Only remote deployment targets are available in this environment.");
    }
    if (!resourceRegistry || !resourceRegistryPath) {
      throw new SplHttpServerError(503, "The orchestrator does not have an SPL resource registry configured.");
    }
    const targetEntry = resourceRegistry.targets[targetRef];
    if (!targetEntry) {
      throw new SplHttpServerError(404, "The selected deployment target does not exist for this account and project.");
    }
    if (requestedTargetRevision !== undefined) {
      throw new SplHttpServerError(409, "Local targets do not use targetRevision.");
    }
    const target = loadJson<DeploymentTarget>(resolveRegistryPath(resourceRegistryPath, targetEntry.path));
    return {
      catalog,
      target,
      targetEntry,
      providers,
      targetRef,
      targetRevision: undefined,
      targetName: target.id,
      remote: false as const,
    };
  };

  const handler: SplHttpHandler = async (request, response): Promise<void> => {
    if (!setCorsHeaders(request, response, config.allowedOrigins)) {
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const parsedRequestUrl = new URL(request.url || "/", "http://variamos-backend.local");
    const routePath = parsedRequestUrl.pathname;
    const authorize = (
      projectId: string,
      action: AuthorizationAction
    ): Promise<AuthenticatedProjectActor> => {
      if (!isStableId(projectId)) {
        throw new SplHttpServerError(400, "projectId must be a stable identifier.");
      }
      return authorizer.authorize(request, projectId, action);
    };
    if (request.method === "GET" && routePath === "/api/spl/v1/target-adapters") {
      sendJson(response, 200, {
        schemaVersion: "deployment-target-adapter-index/v1",
        adapters: targetService.adapterDefinitions().map((definition) => ({
          ...definition,
        })),
      });
      return;
    }
    if (request.method === "GET" && routePath === "/api/spl/v1/providers") {
      sendJson(response, 200, {
        schemaVersion: "spl-provider-index/v1",
        providers: externalProjects.providerIndex(),
      });
      return;
    }
    if (request.method === "GET" && routePath === "/api/spl/v1/runtime") {
      sendJson(response, 200, {
        schemaVersion: "spl-runtime-capabilities/v1",
        localTargetsEnabled,
      });
      return;
    }
    if (request.method === "POST" && routePath === "/api/spl/v1/descriptors/validate") {
      try {
        const body = await readJsonBody(request) as { descriptor?: unknown; requireReady?: boolean; projectId?: string };
        const projectId = body?.projectId;
        const actor = projectId ? await authorize(projectId, "project:import") : undefined;
        const result = externalProjects.validateDescriptor(body?.descriptor, Boolean(body?.requireReady), actor?.userId);
        sendJson(response, result.valid ? 200 : 422, result);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "The descriptor could not be validated." });
      }
      return;
    }

    const projectAccessMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/access$/);
    if (request.method === "GET" && projectAccessMatch) {
      try {
        const projectId = decodeURIComponent(projectAccessMatch[1]);
        const actor = await authorize(projectId, "metadata:read");
        const canEdit = actor.role === "owner" || actor.role === "editor";
        const isOwner = actor.role === "owner";
        sendJson(response, 200, {
          schemaVersion: "spl-project-access/v1",
          projectId,
          role: actor.role,
          permissions: {
            metadataRead: true,
            importProject: canEdit,
            plan: canEdit,
            build: canEdit,
            manageTargets: isOwner,
            manageCredentials: isOwner,
            deploy: isOwner,
          },
        });
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof DeploymentTargetServiceError
            ? error.statusCode
          : 422;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }

    const targetsMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/targets$/);
    if (request.method === "GET" && targetsMatch) {
      try {
        const projectId = decodeURIComponent(targetsMatch[1]);
        const actor = await authorize(projectId, "target:manage");
        sendJson(response, 200, {
          schemaVersion: "deployment-target-connection-index/v1",
          targets: targetService.list(actor.userId),
        });
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof DeploymentTargetServiceError
            ? error.statusCode
          : 422;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    const targetValidateMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/targets\/validate$/);
    if (request.method === "POST" && targetValidateMatch) {
      try {
        const projectId = decodeURIComponent(targetValidateMatch[1]);
        const actor = await authorize(projectId, "target:manage");
        const raw = await readJsonBody(request) as DeploymentTargetInput & {
          ephemeralCredential?: EphemeralSshCredentialInput;
        };
        const { ephemeralCredential, ...body } = raw;
        sendJson(response, 200, await targetService.validate(actor, body, undefined, ephemeralCredential));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, status, {
          error: error instanceof DeploymentTargetServiceError ||
            error instanceof RemoteDeploymentError ||
            error instanceof HostPolicyError
            ? error.message
            : audit.safeError(error),
        });
      }
      return;
    }
    if (request.method === "POST" && targetsMatch) {
      try {
        const projectId = decodeURIComponent(targetsMatch[1]);
        const actor = await authorize(projectId, "target:manage");
        const raw = await readJsonBody(request) as DeploymentTargetInput & {
          ephemeralCredential?: EphemeralSshCredentialInput;
        };
        const { ephemeralCredential, ...body } = raw;
        sendJson(response, 201, await targetService.create(actor, body, ephemeralCredential));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof DeploymentTargetServiceError ||
            error instanceof RemoteDeploymentError ||
            error instanceof HostPolicyError
            ? 422
            : 500;
        sendJson(response, status, {
          error: error instanceof DeploymentTargetServiceError ||
            error instanceof RemoteDeploymentError ||
            error instanceof HostPolicyError
            ? error.message
            : "The deployment target could not be created.",
        });
      }
      return;
    }
    const targetItemMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/targets\/([^/]+)$/);
    if (request.method === "PATCH" && targetItemMatch) {
      try {
        const projectId = decodeURIComponent(targetItemMatch[1]);
        const targetRef = decodeURIComponent(targetItemMatch[2]);
        const actor = await authorize(projectId, "target:manage");
        const raw = await readJsonBody(request) as Partial<Omit<DeploymentTargetInput, "id" | "adapter">> & {
          ephemeralCredential?: EphemeralSshCredentialInput;
        };
        const { ephemeralCredential, ...body } = raw;
        sendJson(response, 200, await targetService.update(actor, targetRef, body, ephemeralCredential));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof DeploymentTargetServiceError ? error.statusCode : 422;
        sendJson(response, status, {
          error: error instanceof DeploymentTargetServiceError ||
            error instanceof RemoteDeploymentError ||
            error instanceof HostPolicyError
            ? error.message
            : audit.safeError(error),
        });
      }
      return;
    }
    if (request.method === "DELETE" && targetItemMatch) {
      try {
        const projectId = decodeURIComponent(targetItemMatch[1]);
        const targetRef = decodeURIComponent(targetItemMatch[2]);
        const actor = await authorize(projectId, "target:manage");
        sendJson(response, 200, targetService.remove(actor, targetRef));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof DeploymentTargetServiceError ? error.statusCode : 422;
        sendJson(response, status, {
          error: error instanceof DeploymentTargetServiceError
            ? error.message
            : audit.safeError(error),
        });
      }
      return;
    }

    const bindingsMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/credential-bindings$/);
    if (request.method === "GET" && bindingsMatch) {
      try {
        const projectId = decodeURIComponent(bindingsMatch[1]);
        await authorize(projectId, "metadata:read");
        sendJson(response, 200, {
          schemaVersion: "credential-binding-index/v1",
          bindings: credentialBroker.list(projectId),
        });
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    const bindingValidateMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/credential-bindings\/validate$/);
    if (request.method === "POST" && bindingValidateMatch) {
      try {
        const projectId = decodeURIComponent(bindingValidateMatch[1]);
        await authorize(projectId, "credential:manage");
        const body = await readJsonBody(request) as CredentialValidationInput;
        sendJson(response, 200, await credentialBroker.validateReference(projectId, body));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, status, {
          error: error instanceof CredentialBrokerError ? error.message : "The credential reference could not be validated.",
        });
      }
      return;
    }
    if (request.method === "POST" && bindingsMatch) {
      try {
        const projectId = decodeURIComponent(bindingsMatch[1]);
        const actor = await authorize(projectId, "credential:manage");
        const body = await readJsonBody(request) as CredentialRegistrationInput;
        sendJson(response, 201, await credentialBroker.register(actor, body));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, status, {
          error: error instanceof CredentialBrokerError ? error.message : "The credential binding could not be registered.",
        });
      }
      return;
    }
    const bindingActionMatch = routePath.match(
      /^\/api\/spl\/v1\/projects\/([^/]+)\/credential-bindings\/([^/]+)\/(validate-current|revoke|confirm-external-revocation)$/
    );
    if (request.method === "POST" && bindingActionMatch) {
      try {
        const projectId = decodeURIComponent(bindingActionMatch[1]);
        const bindingId = decodeURIComponent(bindingActionMatch[2]);
        const action = bindingActionMatch[3];
        const actor = await authorize(projectId, "credential:manage");
        if (action === "validate-current") {
          const current = credentialBroker.get(projectId, bindingId);
          const result = await credentialBroker.validateCurrent(
            actor,
            bindingId,
            current.subject?.kind === "deployment-target"
              ? async (credential) => {
                const target = targetService.get(projectId, current.subject!.id);
                await targetAdapters.require(target.adapter).validate({ target, credential });
              }
              : current.subject?.kind === "source-connection"
                ? async (credential) => {
                  await externalProjects.validateSourceCredential(
                    current.subject!.id,
                    projectId,
                    actor.userId,
                    credential
                  );
                }
                : undefined
          );
          sendJson(response, 200, result);
        } else if (action === "revoke") {
          const revoked = credentialBroker.revoke(actor, bindingId);
          deploymentJobs.cancelByCredential(projectId, revoked.ref);
          sendJson(response, 200, revoked);
        } else {
          sendJson(response, 200, credentialBroker.confirmExternalRevocation(actor, bindingId));
        }
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, status, {
          error: error instanceof CredentialBrokerError || error instanceof DeploymentTargetServiceError
            ? error.message
            : "The credential lifecycle operation failed.",
        });
      }
      return;
    }

    if (request.method === "POST" && routePath === "/api/spl/v1/deployments") {
      try {
        const body = await readJsonBody(request) as {
          projectId: string;
          buildId: string;
          targetRef: string;
          targetRevision: number;
          expectedPlanDigest: string;
          idempotencyKey?: string;
          ephemeralCredential?: EphemeralSshCredentialInput;
        };
        const actor = await authorize(body.projectId, "deployment:manage");
        const keyHeader = request.headers["idempotency-key"];
        const idempotencyKey = typeof keyHeader === "string" ? keyHeader : body.idempotencyKey || "";
        const created = deploymentJobs.create(actor, { ...body, idempotencyKey });
        sendJson(response, created.created ? 202 : 200, created.execution);
      } catch (error) {
        const status = error instanceof AuthorizationError ||
          error instanceof SplHttpServerError ||
          error instanceof DeploymentJobServiceError
          ? error.statusCode
          : 422;
        sendJson(response, status, {
          error: error instanceof DeploymentJobServiceError ? error.message : audit.safeError(error),
        });
      }
      return;
    }
    const deploymentItemMatch = routePath.match(/^\/api\/spl\/v1\/deployments\/([^/]+)$/);
    if (request.method === "GET" && deploymentItemMatch) {
      try {
        const executionId = decodeURIComponent(deploymentItemMatch[1]);
        const execution = repository.findDeployment(executionId);
        if (!execution) throw new DeploymentJobServiceError(404, "The deployment execution does not exist.");
        await authorize(execution.projectId, "metadata:read");
        sendJson(response, 200, execution);
      } catch (error) {
        const status = error instanceof AuthorizationError ||
          error instanceof DeploymentJobServiceError
          ? error.statusCode
          : 422;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    const deploymentCancelMatch = routePath.match(/^\/api\/spl\/v1\/deployments\/([^/]+)\/cancel$/);
    if (request.method === "POST" && deploymentCancelMatch) {
      try {
        const executionId = decodeURIComponent(deploymentCancelMatch[1]);
        const execution = repository.findDeployment(executionId);
        if (!execution) throw new DeploymentJobServiceError(404, "The deployment execution does not exist.");
        const actor = await authorize(execution.projectId, "deployment:manage");
        sendJson(response, 200, deploymentJobs.cancel(actor, executionId));
      } catch (error) {
        const status = error instanceof AuthorizationError ||
          error instanceof DeploymentJobServiceError
          ? error.statusCode
          : 422;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    const projectDeploymentsMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/deployments$/);
    if (request.method === "GET" && projectDeploymentsMatch) {
      try {
        const projectId = decodeURIComponent(projectDeploymentsMatch[1]);
        await authorize(projectId, "metadata:read");
        sendJson(response, 200, {
          schemaVersion: "spl-deployment-execution-index/v1",
          deployments: deploymentJobs.list(projectId),
        });
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    const sourceUploadMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/source-uploads$/);
    if (request.method === "POST" && sourceUploadMatch) {
      try {
        if (!config.folderUploadEnabled) throw new SplHttpServerError(503, "Project folder uploads are not enabled in this VariaMos backend.");
        const projectId = decodeURIComponent(sourceUploadMatch[1]);
        if (!isStableId(projectId)) throw new SplHttpServerError(400, "projectId must be a stable identifier.");
        const actor = await authorize(projectId, "project:import");
        const files = await readFolderUpload(request, config.uploadMaxBytes || 100 * 1024 * 1024, config.uploadMaxFiles || 500);
        const upload = uploadStore.create(projectId, actor.userId, files);
        // Descriptor/artifact validation is performed once here, before the upload can be referenced by a connection.
        const descriptor = JSON.parse(fs.readFileSync(path.join(upload.root, ".variamos/spl.json"), "utf8"));
        const validation = externalProjects.validateDescriptor(descriptor, true, actor.userId);
        if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
        const declared = new Set([".variamos/spl.json", ...(descriptor as { artifacts: Array<{ source: { path: string } }> }).artifacts.map((artifact) => artifact.source.path)]);
        if (declared.size !== files.length || files.some((file) => !declared.has(file.relativePath))) {
          throw new ExternalProjectError("The upload must contain exactly the descriptor and artifacts declared by it.");
        }
        sendJson(response, 201, { upload: externalProjects.describeUpload(upload.uploadId, projectId, actor.userId), validation });
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError || error instanceof ExternalProjectError
          ? error.statusCode : 422;
        const body: Record<string, unknown> = { error: error instanceof ExternalProjectError ? error.message : audit.safeError(error) };
        if (error instanceof ExternalProjectError && error.code) body.code = error.code;
        if (error instanceof ExternalProjectError && error.requiresReupload) body.requiresReupload = true;
        sendJson(response, status, body);
      }
      return;
    }
    const restoreUploadMatch = routePath.match(/^\/api\/spl\/v1\/projects\/([^/]+)\/connections\/([^/]+)\/upload$/);
    if (request.method === "PUT" && restoreUploadMatch) {
      try {
        const projectId = decodeURIComponent(restoreUploadMatch[1]);
        const connectionId = decodeURIComponent(restoreUploadMatch[2]);
        const body = await readJsonBody(request) as { uploadId?: string };
        if (!body.uploadId) throw new SplHttpServerError(400, "uploadId is required.");
        const actor = await authorize(projectId, "project:import");
        sendJson(response, 200, externalProjects.restoreUpload(connectionId, projectId, body.uploadId, actor.userId));
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError || error instanceof ExternalProjectError ? error.statusCode : 422;
        const body: Record<string, unknown> = { error: error instanceof ExternalProjectError ? error.message : audit.safeError(error) };
        if (error instanceof ExternalProjectError && error.code) body.code = error.code;
        if (error instanceof ExternalProjectError && error.requiresReupload) body.requiresReupload = true;
        sendJson(response, status, body);
      }
      return;
    }
    if (
      request.method === "POST" &&
      (routePath === "/api/spl/v1/connections/validate" || routePath === "/api/spl/v1/connections")
    ) {
      try {
        const body = await readJsonBody(request) as ExternalProjectConnectionInput;
        const requestedProjectId = (body as ExternalProjectConnectionInput & { projectId?: string }).projectId;
        const projectId = requestedProjectId || "";
        if (!projectId) throw new SplHttpServerError(400, "projectId is required for project connections.");
        const actor = await authorize(projectId, "project:import");
        const result = await externalProjects.validateConnection(
          body,
          routePath === "/api/spl/v1/connections",
          { actorId: actor.userId, projectId }
        );
        sendJson(response, 200, result);
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof ExternalProjectError
            ? error.statusCode
            : 400;
        sendJson(response, status, {
          error: error instanceof ExternalProjectError ? error.message : audit.safeError(error),
          ...(error instanceof ExternalProjectError && error.code ? { code: error.code } : {}),
          ...(error instanceof ExternalProjectError && error.requiresReupload ? { requiresReupload: true } : {}),
        });
      }
      return;
    }
    const connectionMatch = routePath.match(/^\/api\/spl\/v1\/connections\/([^/]+)$/);
    if (request.method === "GET" && connectionMatch) {
      try {
        const projectId = parsedRequestUrl.searchParams.get("projectId") || "";
        if (!projectId) throw new SplHttpServerError(400, "projectId is required.");
        await authorize(projectId, "metadata:read");
        sendJson(
          response,
          200,
          externalProjects.getConnection(
            decodeURIComponent(connectionMatch[1]),
            projectId
          )
        );
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 404;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    const descriptorMatch = routePath.match(
      /^\/api\/spl\/v1\/connections\/([^/]+)\/descriptor\/validate$/
    );
    if (request.method === "POST" && descriptorMatch) {
      try {
        const body = await readJsonBody(request) as { projectId?: string };
        const projectId = body.projectId || "";
        if (!projectId) throw new SplHttpServerError(400, "projectId is required.");
        const actor = await authorize(projectId, "project:import");
        const result = externalProjects.validateStoredDescriptor(
          decodeURIComponent(descriptorMatch[1]),
          projectId,
          actor.userId
        );
        sendJson(response, result.valid ? 200 : 422, result);
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof ExternalProjectError ? error.statusCode : 422;
        sendJson(response, status, { error: error instanceof ExternalProjectError ? error.message : audit.safeError(error), ...(error instanceof ExternalProjectError && error.code ? { code: error.code } : {}), ...(error instanceof ExternalProjectError && error.requiresReupload ? { requiresReupload: true } : {}) });
      }
      return;
    }
    if (request.method === "POST" && routePath === "/api/spl/v1/imports") {
      try {
        const body = await readJsonBody(request) as {
          connectionId?: string;
          profileId?: string;
          targetRef?: string;
          projectId?: string;
        };
        if (!body.connectionId || !body.profileId) {
          throw new ExternalProjectError("connectionId y profileId son obligatorios.");
        }
        const projectId = body.projectId || "";
        if (!projectId) throw new SplHttpServerError(400, "projectId is required.");
        const actor = await authorize(projectId, "project:import");
        sendJson(
          response,
          201,
          externalProjects.importProject(
            body.connectionId,
            body.profileId,
            body.targetRef,
            projectId,
            actor.userId
          )
        );
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : error instanceof ExternalProjectError ? error.statusCode : 422;
        sendJson(response, status, {
          error: error instanceof ExternalProjectError ? error.message : audit.safeError(error),
          ...(error instanceof ExternalProjectError && error.code ? { code: error.code } : {}),
          ...(error instanceof ExternalProjectError && error.requiresReupload ? { requiresReupload: true } : {}),
        });
      }
      return;
    }
    const importMatch = routePath.match(/^\/api\/spl\/v1\/imports\/([^/]+)$/);
    if (request.method === "GET" && importMatch) {
      try {
        const projectId = parsedRequestUrl.searchParams.get("projectId") || "";
        if (!projectId) throw new SplHttpServerError(400, "projectId is required.");
        await authorize(projectId, "metadata:read");
        sendJson(
          response,
          200,
          externalProjects.getImport(
            decodeURIComponent(importMatch[1]),
            projectId
          )
        );
      } catch (error) {
        const status = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 404;
        sendJson(response, status, { error: audit.safeError(error) });
      }
      return;
    }
    if (request.method === "GET" && routePath === "/api/spl/v1/profiles") {
      try {
        const requestedProjectId = parsedRequestUrl.searchParams.get("projectId") || "";
        if (!requestedProjectId) throw new SplHttpServerError(400, "projectId is required.");
        await authorize(requestedProjectId, "metadata:read");
        // Built-in profiles are development fixtures. Imported profiles belong
        // to the authenticated project and must remain available in production
        // even though the local resource registry is intentionally absent.
        const profiles = !resourceRegistry || !resourceRegistryPath
          ? []
          : Object.entries(resourceRegistry.profiles || {}).map(([id, profile]) => {
          const catalogPath = resourceRegistry.catalogs[profile.catalogRef];
          const targetEntry = resourceRegistry.targets[profile.targetRef];
          if (!catalogPath || !targetEntry) throw new SplHttpServerError(422, `Profile '${id}' does not reference authorized resources.`);
          const catalog = loadJson<ArtifactCatalog>(resolveRegistryPath(resourceRegistryPath, catalogPath));
          const target = loadJson<DeploymentTarget>(resolveRegistryPath(resourceRegistryPath, targetEntry.path));
          return {
            id, name: profile.name, mappingRef: profile.mappingRef, catalogRef: profile.catalogRef, targetRef: profile.targetRef,
            builderAdapter: catalog.derivation.builderAdapter, testAdapter: catalog.derivation.testAdapter || null, deployerAdapter: target.adapter,
            artifacts: catalog.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, version: artifact.version })),
          };
        });
        sendJson(response, 200, {
          schemaVersion: "spl-profile-index/v1",
          profiles: [
            ...profiles,
            ...externalProjects.importedProfiles(requestedProjectId),
          ],
        });
      } catch (error) {
        const statusCode = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, statusCode, { error: audit.safeError(error) });
      }
      return;
    }
    if (request.method === "GET" && routePath.startsWith("/api/spl/v1/catalogs/")) {
      try {
        if (!resourceRegistry || !resourceRegistryPath) {
          throw new SplHttpServerError(404, "No public SPL catalogs are configured.");
        }
        const catalogRef = decodeURIComponent(routePath.slice("/api/spl/v1/catalogs/".length));
        const requestedProjectId = parsedRequestUrl.searchParams.get("projectId") || "";
        if (!requestedProjectId) throw new SplHttpServerError(400, "projectId is required.");
        await authorize(requestedProjectId, "metadata:read");
        const externalCatalog = externalProjects.catalogSummary(
          catalogRef,
          requestedProjectId
        );
        if (externalCatalog) {
          sendJson(response, 200, externalCatalog);
          return;
        }
        if (!isStableId(catalogRef) || !resourceRegistry.catalogs[catalogRef]) {
          throw new SplHttpServerError(404, "The requested catalog is not authorized.");
        }
        const catalog = loadJson<ArtifactCatalog>(resolveRegistryPath(resourceRegistryPath, resourceRegistry.catalogs[catalogRef]));
        sendJson(response, 200, {
          id: catalog.id,
          version: catalog.version,
          artifacts: catalog.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, version: artifact.version })),
        });
      } catch (error) {
        const statusCode = error instanceof AuthorizationError || error instanceof SplHttpServerError
          ? error.statusCode
          : 422;
        sendJson(response, statusCode, { error: audit.safeError(error) });
      }
      return;
    }
    if (request.method !== "POST" || routePath !== "/api/spl/v1/derivations") {
      sendJson(response, 404, { error: "SPL route not found." });
      return;
    }

    try {
      const input = validateMappingRequestBody(await readJsonBody(request));
        const authorizationAction: AuthorizationAction = input.action === "plan"
          ? "derivation:plan"
          : input.action === "build"
            ? "derivation:build"
            : "deployment:manage";
        const actor = await authorize(input.projectId, authorizationAction);
        const featureErrors = validateFeatureModel(input.featureModel);
        if (featureErrors.length) throw new SplHttpServerError(422, `Invalid feature configuration: ${featureErrors.join(" | ")}`);
        const resources = getMappingResources(
          input.mappingModel,
          input.projectId,
          actor.userId,
          input.targetRef,
          input.targetRevision,
          input.action !== "plan"
        );
        if (resources.remote && input.action === "deploy") {
          throw new SplHttpServerError(
            409,
            "Remote targets deploy only from an immutable tested build through POST /api/spl/v1/deployments."
          );
        }
        const configurationId = createMappingConfigurationId(input.featureModel, input.mappingModel);
        const modelVersion = createModelVersion(input.featureModel);
        const exported = mappingModelAdapter.adapt(input.featureModel, input.mappingModel, {
          catalog: resources.catalog,
          configurationId,
          productLineId: input.productLineId,
          modelVersion,
        });
        const manifest = resolver.resolve({
          catalog: resources.catalog,
          bindings: exported.bindings,
          configuration: exported.configuration,
          target: resources.target,
          sourceModel: { projectId: input.projectId, modelId: input.featureModel.id, version: modelVersion },
        });
        const planDigest = createPlanDigest({
          configurationId,
          featureModel: input.featureModel,
          mappingModel: input.mappingModel,
          catalog: resources.catalog,
          target: resources.target,
          targetRevision: resources.targetRevision || null,
        });
        if ((input.action === "build" || input.action === "deploy") && input.expectedPlanDigest !== planDigest) {
          throw new SplHttpServerError(409, "The model or mapping changed after the plan was generated; generate a new plan before continuing.");
        }
        const responseBody: Record<string, unknown> = {
          action: input.action,
          configurationId,
          planDigest,
          configurationRef: input.configurationRef || null,
          manifest,
          diagnostics: [],
          trace: exported.trace,
          targetRevision: resources.targetRevision || null,
          targetName: resources.targetName,
          profile: {
            ...exported.mapping,
            targetRef: resources.targetRef,
            builderAdapter: resources.catalog.derivation.builderAdapter,
            deployerAdapter: resources.target.adapter,
          },
        };
        let outputDirectory: string | undefined;
        let testResult: { status: string; results?: Array<{ name: string; status: string }> } | undefined;
        if (input.action === "build" || input.action === "deploy") {
          outputDirectory = path.join(config.outputRoot, input.projectId, manifest.manifestId);
          if (resources.catalog.derivation.builderAdapter === "static-site-v1") {
            const build = staticBuilder.build({ manifest, catalog: resources.catalog, providers: resources.providers, outputDirectory });
            responseBody.build = { artifactCount: build.artifacts.length, artifacts: build.artifacts };
            testResult = htmlTests.run(manifest, outputDirectory);
            responseBody.tests = testResult;
          } else if (resources.catalog.derivation.builderAdapter === "node-modular-monolith-v1") {
            const build = nodeBuilder.build({ manifest, catalog: resources.catalog, providers: resources.providers, outputDirectory });
            responseBody.build = { artifactCount: build.artifacts.length, artifacts: build.artifacts };
            testResult = nodeTests.run(manifest, outputDirectory);
            responseBody.tests = testResult;
          } else {
            throw new SplHttpServerError(422, `No authorized builder exists for '${resources.catalog.derivation.builderAdapter}'.`);
          }
          if (!testResult || testResult.status !== "passed") {
            throw new SplHttpServerError(422, "The derived product did not pass all required tests.");
          }
          const buildRecord = buildRecords.record({
            projectId: input.projectId,
            manifest,
            planDigest,
            targetRef: resources.targetRef,
            targetRevision: resources.targetRevision,
            outputDirectory,
            tests: testResult,
            builderAdapter: resources.catalog.derivation.builderAdapter,
            actor,
          });
          responseBody.buildId = buildRecord.buildId;
        }
        if (input.action === "deploy" && outputDirectory) {
          if ("remote" in resources.targetEntry) {
            throw new SplHttpServerError(409, "Remote deployment must be started through the deployment job API.");
          }
          const localTargetEntry = resources.targetEntry;
          if (resources.target.adapter === "nginx-container-v1") {
            const deployment = await staticDeployer.deploy({ manifest, distributionDirectory: outputDirectory, stateDirectory: path.join(config.releaseStateDirectory, localTargetEntry.releaseState), hostPort: localTargetEntry.port });
            responseBody.deployment = { status: deployment.status, releaseId: deployment.release.releaseId, url: deployment.release.endpoint.url };
          } else if (resources.target.adapter === "node-container-v1") {
            const deployment = await nodeDeployer.deploy({ manifest, distributionDirectory: outputDirectory, stateDirectory: path.join(config.releaseStateDirectory, localTargetEntry.releaseState), dataDirectory: path.join(config.releaseStateDirectory, localTargetEntry.dataState || "data"), hostPort: localTargetEntry.port });
            responseBody.deployment = { status: deployment.status, releaseId: deployment.release.releaseId, url: deployment.release.endpoint.url.replace(/\/health$/, "/") };
          } else {
            throw new SplHttpServerError(422, `No authorized deployer exists for '${resources.target.adapter}'.`);
          }
        }
        audit.record({
          event: `derivation.${input.action}`,
          result: "succeeded",
          actorId: actor.userId,
          projectId: input.projectId,
          targetRef: resources.targetRef,
          details: {
            manifestId: manifest.manifestId,
            planDigest,
            targetRevision: resources.targetRevision || null,
          },
        });
        sendJson(response, 200, responseBody);
    } catch (error) {
      const statusCode = error instanceof SplHttpServerError || error instanceof AuthorizationError || error instanceof ExternalProjectError
        ? error.statusCode
        : error instanceof DeploymentJobServiceError
          ? error.statusCode
          : 422;
      const message = error instanceof SplHttpServerError ||
        error instanceof AuthorizationError ||
        error instanceof DeploymentJobServiceError || error instanceof ExternalProjectError
        ? error.message
        : audit.safeError(error);
      sendJson(response, statusCode, { error: message, ...(error instanceof ExternalProjectError && error.code ? { code: error.code } : {}), ...(error instanceof ExternalProjectError && error.requiresReupload ? { requiresReupload: true } : {}) });
    }
  };
  handler.shutdown = () => { deploymentJobs.shutdown(); uploadStore.close(); };
  return handler;
}
