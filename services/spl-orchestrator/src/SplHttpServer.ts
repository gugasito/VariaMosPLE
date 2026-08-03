import crypto from "crypto";
import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { NodeModularMonolithBuilder } from "./adapters/builders/NodeModularMonolithBuilder";
import { StaticSiteBuilder } from "./adapters/builders/StaticSiteBuilder";
import { NginxContainerDeployer } from "./adapters/deployers/NginxContainerDeployer";
import { NodeContainerDeployer } from "./adapters/deployers/NodeContainerDeployer";
import { ArtifactProviderRegistry } from "./adapters/providers/ArtifactProvider";
import { GitArtifactProvider } from "./adapters/providers/GitArtifactProvider";
import { LocalArtifactProvider } from "./adapters/providers/LocalArtifactProvider";
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

const MAX_REQUEST_BYTES = 1024 * 1024;

export type DerivationAction = "plan" | "build" | "deploy";

export interface SplHttpServerConfig {
  gitRepositories?: Record<string, string>;
  localRoots?: Record<string, string>;
  outputRoot: string;
  releaseStateDirectory: string;
  allowedOrigins: string[];
  resourceRegistryPath?: string;
  externalProjectStateDirectory?: string;
  projectDescriptorSchemaPath?: string;
  allowLocalGitRepositories?: boolean;
  allowLocalDirectories?: boolean;
}

interface SplMappingDerivationRequestBody {
  action?: DerivationAction;
  projectId: string;
  productLineId: string;
  configurationRef?: { id?: string; name?: string };
  featureModel: VariaMosSerializedModel;
  mappingModel: VariaMosSerializedModel;
  expectedPlanDigest?: string;
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
  return {
    action,
    projectId: body.projectId,
    productLineId: body.productLineId,
    configurationRef: body.configurationRef,
    featureModel: body.featureModel,
    mappingModel: body.mappingModel,
    expectedPlanDigest: body.expectedPlanDigest,
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
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
  return true;
}

export function createSplHttpHandler(config: SplHttpServerConfig): http.RequestListener {
  const resourceRegistryPath = config.resourceRegistryPath;
  const resourceRegistry = resourceRegistryPath
    ? loadJson<SplResourceRegistry>(resourceRegistryPath)
    : undefined;
  const resolver = new DerivationResolver();
  const mappingModelAdapter = new SplMappingModelAdapter();
  const staticBuilder = new StaticSiteBuilder();
  const nodeBuilder = new NodeModularMonolithBuilder();
  const staticDeployer = new NginxContainerDeployer();
  const nodeDeployer = new NodeContainerDeployer();
  const htmlTests = new HtmlValidationAdapter();
  const nodeTests = new NodeTestAdapter();

  const registeredTargets = (): ExternalProjectTarget[] => {
    if (!resourceRegistry || !resourceRegistryPath) return [];
    return Object.entries(resourceRegistry.targets).map(([ref, entry]) => ({
      ref,
      target: loadJson<DeploymentTarget>(resolveRegistryPath(resourceRegistryPath, entry.path)),
      port: entry.port,
      releaseState: entry.releaseState,
      ...(entry.dataState ? { dataState: entry.dataState } : {}),
    }));
  };
  const externalProjects = new ExternalProjectService({
    stateDirectory: config.externalProjectStateDirectory || "/tmp/variamos-spl-external-projects",
    descriptorSchemaPath:
      config.projectDescriptorSchemaPath ||
      path.join(process.cwd(), "contracts/schemas/variamos-project.schema.json"),
    allowLocalGitRepositories: config.allowLocalGitRepositories || false,
    allowLocalDirectories: config.allowLocalDirectories || false,
    targets: registeredTargets,
  });

  const getMappingResources = (mappingModel: VariaMosSerializedModel) => {
    const root = mappingModel.elements.find((element) => element.type === "DeploymentMapping");
    const getProperty = (name: string): string | undefined => {
      const property = (root?.properties || []).find((candidate) => candidate.name === name);
      return typeof property?.value === "string" ? property.value : undefined;
    };
    const catalogRef = getProperty("catalog_ref");
    const targetRef = getProperty("target_ref");
    if (!isStableId(catalogRef) || !isStableId(targetRef)) {
      throw new SplHttpServerError(422, "DeploymentMapping must declare stable catalog_ref and target_ref values.");
    }
    const external = externalProjects.resources(catalogRef, targetRef);
    if (external) {
      return {
        catalog: external.catalog,
        target: external.target,
        targetEntry: external.targetEntry,
        providers: new ArtifactProviderRegistry([
          new GitArtifactProvider({ repositories: external.gitRepositories }),
          new LocalArtifactProvider({ roots: external.localRoots }),
        ]),
      };
    }
    if (!resourceRegistry || !resourceRegistryPath) {
      throw new SplHttpServerError(503, "The orchestrator does not have an SPL resource registry configured.");
    }
    const catalogRelativePath = resourceRegistry.catalogs[catalogRef];
    const targetEntry = resourceRegistry.targets[targetRef];
    if (!catalogRelativePath || !targetEntry) {
      throw new SplHttpServerError(422, "The referenced catalog or target is not authorized by the SPL registry.");
    }
    const catalog = loadJson<ArtifactCatalog>(resolveRegistryPath(resourceRegistryPath, catalogRelativePath));
    const target = loadJson<DeploymentTarget>(resolveRegistryPath(resourceRegistryPath, targetEntry.path));
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
    return {
      catalog,
      target,
      targetEntry,
      providers: new ArtifactProviderRegistry([
        new GitArtifactProvider({ repositories: config.gitRepositories || {} }),
        new LocalArtifactProvider({ roots: localRoots }),
      ]),
    };
  };

  return async (request, response): Promise<void> => {
    if (!setCorsHeaders(request, response, config.allowedOrigins)) {
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok", service: "spl-orchestrator" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/spl/v1/providers") {
      sendJson(response, 200, {
        schemaVersion: "spl-provider-index/v1",
        providers: externalProjects.providerIndex(),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/spl/v1/descriptors/validate") {
      try {
        const body = await readJsonBody(request) as { descriptor?: unknown; requireReady?: boolean };
        const result = externalProjects.validateDescriptor(body?.descriptor, Boolean(body?.requireReady));
        sendJson(response, result.valid ? 200 : 422, result);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "The descriptor could not be validated." });
      }
      return;
    }
    if (
      request.method === "POST" &&
      (request.url === "/api/spl/v1/connections/validate" || request.url === "/api/spl/v1/connections")
    ) {
      try {
        const body = await readJsonBody(request) as ExternalProjectConnectionInput;
        const result = externalProjects.validateConnection(
          body,
          request.url === "/api/spl/v1/connections"
        );
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error instanceof ExternalProjectError ? 422 : 400, {
          error: error instanceof Error ? error.message : "The Git connection could not be validated.",
        });
      }
      return;
    }
    const connectionMatch = request.url?.match(/^\/api\/spl\/v1\/connections\/([^/]+)$/);
    if (request.method === "GET" && connectionMatch) {
      try {
        sendJson(response, 200, externalProjects.getConnection(decodeURIComponent(connectionMatch[1])));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : "Connection not found." });
      }
      return;
    }
    const descriptorMatch = request.url?.match(
      /^\/api\/spl\/v1\/connections\/([^/]+)\/descriptor\/validate$/
    );
    if (request.method === "POST" && descriptorMatch) {
      try {
        const result = externalProjects.validateStoredDescriptor(decodeURIComponent(descriptorMatch[1]));
        sendJson(response, result.valid ? 200 : 422, result);
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "The descriptor could not be validated." });
      }
      return;
    }
    if (request.method === "POST" && request.url === "/api/spl/v1/imports") {
      try {
        const body = await readJsonBody(request) as {
          connectionId?: string;
          profileId?: string;
          targetRef?: string;
        };
        if (!body.connectionId || !body.profileId) {
          throw new ExternalProjectError("connectionId y profileId son obligatorios.");
        }
        sendJson(
          response,
          201,
          externalProjects.importProject(body.connectionId, body.profileId, body.targetRef)
        );
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "The project could not be imported." });
      }
      return;
    }
    const importMatch = request.url?.match(/^\/api\/spl\/v1\/imports\/([^/]+)$/);
    if (request.method === "GET" && importMatch) {
      try {
        sendJson(response, 200, externalProjects.getImport(decodeURIComponent(importMatch[1])));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : "Import not found." });
      }
      return;
    }
    if (request.method === "GET" && request.url === "/api/spl/v1/profiles") {
      try {
        if (!resourceRegistry || !resourceRegistryPath) throw new SplHttpServerError(404, "No SPL profiles are configured.");
        const profiles = Object.entries(resourceRegistry.profiles || {}).map(([id, profile]) => {
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
          profiles: [...profiles, ...externalProjects.importedProfiles()],
        });
      } catch (error) {
        const statusCode = error instanceof SplHttpServerError ? error.statusCode : 422;
        sendJson(response, statusCode, { error: error instanceof Error ? error.message : "The SPL profiles could not be read." });
      }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/spl/v1/catalogs/")) {
      try {
        if (!resourceRegistry || !resourceRegistryPath) {
          throw new SplHttpServerError(404, "No public SPL catalogs are configured.");
        }
        const catalogRef = decodeURIComponent(request.url.slice("/api/spl/v1/catalogs/".length));
        const externalCatalog = externalProjects.catalogSummary(catalogRef);
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
        const statusCode = error instanceof SplHttpServerError ? error.statusCode : 422;
        sendJson(response, statusCode, { error: error instanceof Error ? error.message : "The SPL catalog could not be read." });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/spl/v1/derivations") {
      sendJson(response, 404, { error: "SPL route not found." });
      return;
    }

    try {
      const input = validateMappingRequestBody(await readJsonBody(request));
        const featureErrors = validateFeatureModel(input.featureModel);
        if (featureErrors.length) throw new SplHttpServerError(422, `Invalid feature configuration: ${featureErrors.join(" | ")}`);
        const resources = getMappingResources(input.mappingModel);
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
        const planDigest = createPlanDigest({ configurationId, featureModel: input.featureModel, mappingModel: input.mappingModel, catalog: resources.catalog, target: resources.target });
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
          profile: { ...exported.mapping, builderAdapter: resources.catalog.derivation.builderAdapter, deployerAdapter: resources.target.adapter },
        };
        let outputDirectory: string | undefined;
        if (input.action === "build" || input.action === "deploy") {
          outputDirectory = path.join(config.outputRoot, manifest.manifestId);
          if (resources.catalog.derivation.builderAdapter === "static-site-v1") {
            const build = staticBuilder.build({ manifest, catalog: resources.catalog, providers: resources.providers, outputDirectory });
            responseBody.build = { artifactCount: build.artifacts.length, artifacts: build.artifacts };
            responseBody.tests = htmlTests.run(manifest, outputDirectory);
          } else if (resources.catalog.derivation.builderAdapter === "node-modular-monolith-v1") {
            const build = nodeBuilder.build({ manifest, catalog: resources.catalog, providers: resources.providers, outputDirectory });
            responseBody.build = { artifactCount: build.artifacts.length, artifacts: build.artifacts };
            responseBody.tests = nodeTests.run(manifest, outputDirectory);
          } else {
            throw new SplHttpServerError(422, `No authorized builder exists for '${resources.catalog.derivation.builderAdapter}'.`);
          }
        }
        if (input.action === "deploy" && outputDirectory) {
          if (resources.target.adapter === "nginx-container-v1") {
            const deployment = await staticDeployer.deploy({ manifest, distributionDirectory: outputDirectory, stateDirectory: path.join(config.releaseStateDirectory, resources.targetEntry.releaseState), hostPort: resources.targetEntry.port });
            responseBody.deployment = { status: deployment.status, releaseId: deployment.release.releaseId, url: deployment.release.endpoint.url };
          } else if (resources.target.adapter === "node-container-v1") {
            const deployment = await nodeDeployer.deploy({ manifest, distributionDirectory: outputDirectory, stateDirectory: path.join(config.releaseStateDirectory, resources.targetEntry.releaseState), dataDirectory: path.join(config.releaseStateDirectory, resources.targetEntry.dataState || "data"), hostPort: resources.targetEntry.port });
            responseBody.deployment = { status: deployment.status, releaseId: deployment.release.releaseId, url: deployment.release.endpoint.url.replace(/\/health$/, "/") };
          } else {
            throw new SplHttpServerError(422, `No authorized deployer exists for '${resources.target.adapter}'.`);
          }
        }
        sendJson(response, 200, responseBody);
    } catch (error) {
      const statusCode = error instanceof SplHttpServerError ? error.statusCode : 422;
      const message = error instanceof Error ? error.message : "The SPL derivation could not be completed.";
      sendJson(response, statusCode, { error: message });
    }
  };
}

export function createLocalSplHttpServerConfig(
  workspaceRoot: string = process.cwd()
): SplHttpServerConfig {
  const environment = process.env;
  const origins = environment.SPL_UI_ORIGINS || [
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://127.0.0.1:3002",
    "http://localhost:3002",
  ].join(",");

  return {
    gitRepositories: {},
    outputRoot: environment.SPL_OUTPUT_ROOT || "/tmp/variamos-spl/products",
    releaseStateDirectory: environment.SPL_RELEASE_STATE || "/tmp/variamos-spl/releases",
    allowedOrigins: origins.split(",").map((origin) => origin.trim()).filter(Boolean),
    resourceRegistryPath: environment.SPL_RESOURCE_REGISTRY_PATH || path.join(
      workspaceRoot,
      "contracts/resource-registry.local.json"
    ),
    externalProjectStateDirectory:
      environment.SPL_EXTERNAL_PROJECT_STATE || "/tmp/variamos-spl-external-projects",
    projectDescriptorSchemaPath:
      environment.SPL_PROJECT_DESCRIPTOR_SCHEMA ||
      path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
    allowLocalGitRepositories:
      environment.SPL_ALLOW_LOCAL_GIT_REPOSITORIES === "true",
    allowLocalDirectories:
      environment.SPL_ALLOW_LOCAL_DIRECTORIES === "true",
  };
}
