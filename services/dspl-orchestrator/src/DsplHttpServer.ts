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
import { DsplMappingModelAdapter } from "./adapters/variamos/DsplMappingModelAdapter";
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
import { GitProjectConnectionInput } from "./domain/ProjectDescriptor";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type DerivationAction = "plan" | "build" | "deploy";

export interface DsplHttpServerConfig {
  gitRepositories?: Record<string, string>;
  localRoots?: Record<string, string>;
  outputRoot: string;
  releaseStateDirectory: string;
  allowedOrigins: string[];
  resourceRegistryPath?: string;
  externalProjectStateDirectory?: string;
  projectDescriptorSchemaPath?: string;
  allowLocalGitRepositories?: boolean;
}

interface DsplMappingDerivationRequestBody {
  action?: DerivationAction;
  projectId: string;
  productLineId: string;
  configurationRef?: { id?: string; name?: string };
  featureModel: VariaMosSerializedModel;
  mappingModel: VariaMosSerializedModel;
  expectedPlanDigest?: string;
}

interface DsplResourceRegistry {
  schemaVersion: "dspl-resource-registry/v1";
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

export class DsplHttpServerError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DsplHttpServerError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, DsplHttpServerError.prototype);
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
        reject(new DsplHttpServerError(413, "La solicitud DSPL supera el tamaño permitido."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new DsplHttpServerError(400, "El cuerpo de la solicitud debe ser JSON válido."));
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

function validateMappingRequestBody(value: unknown): DsplMappingDerivationRequestBody {
  if (!value || typeof value !== "object") {
    throw new DsplHttpServerError(400, "La solicitud DSPL debe ser un objeto JSON.");
  }
  const body = value as Partial<DsplMappingDerivationRequestBody>;
  const action = body.action || "plan";
  if (action !== "plan" && action !== "build" && action !== "deploy") {
    throw new DsplHttpServerError(400, "action debe ser plan, build o deploy.");
  }
  if (!isStableId(body.projectId) || !isStableId(body.productLineId) || !isModel(body.featureModel) || !isModel(body.mappingModel)) {
    throw new DsplHttpServerError(400, "projectId, productLineId, featureModel y mappingModel deben tener formato DSPL válido.");
  }
  if ((action === "build" || action === "deploy") && (!body.expectedPlanDigest || !/^sha256:[a-f0-9]{64}$/.test(body.expectedPlanDigest))) {
    throw new DsplHttpServerError(400, "build y deploy requieren expectedPlanDigest de un plan válido.");
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
    throw new DsplHttpServerError(422, "El registro DSPL contiene una ruta relativa no autorizada.");
  }
  const root = path.dirname(path.resolve(registryPath));
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new DsplHttpServerError(422, "El registro DSPL intenta resolver fuera de su directorio.");
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
    sendJson(response, 403, { error: "El origen no está autorizado para usar el orquestador DSPL." });
    return false;
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
  return true;
}

export function createDsplHttpHandler(config: DsplHttpServerConfig): http.RequestListener {
  const resourceRegistryPath = config.resourceRegistryPath;
  const resourceRegistry = resourceRegistryPath
    ? loadJson<DsplResourceRegistry>(resourceRegistryPath)
    : undefined;
  const resolver = new DerivationResolver();
  const mappingModelAdapter = new DsplMappingModelAdapter();
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
    stateDirectory: config.externalProjectStateDirectory || "/tmp/variamos-dspl-external-projects",
    descriptorSchemaPath:
      config.projectDescriptorSchemaPath ||
      path.join(process.cwd(), "contracts/schemas/variamos-project.schema.json"),
    allowLocalGitRepositories: config.allowLocalGitRepositories || false,
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
      throw new DsplHttpServerError(422, "El DeploymentMapping debe declarar catalog_ref y target_ref estables.");
    }
    const external = externalProjects.resources(catalogRef, targetRef);
    if (external) {
      return {
        catalog: external.catalog,
        target: external.target,
        targetEntry: external.targetEntry,
        providers: new ArtifactProviderRegistry([
          new GitArtifactProvider({ repositories: external.gitRepositories }),
          new LocalArtifactProvider({ roots: config.localRoots || {} }),
        ]),
      };
    }
    if (!resourceRegistry || !resourceRegistryPath) {
      throw new DsplHttpServerError(503, "El orquestador no tiene un registro de recursos DSPL configurado.");
    }
    const catalogRelativePath = resourceRegistry.catalogs[catalogRef];
    const targetEntry = resourceRegistry.targets[targetRef];
    if (!catalogRelativePath || !targetEntry) {
      throw new DsplHttpServerError(422, "El catálogo o target referenciado no está autorizado por el registro DSPL.");
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
      sendJson(response, 200, { status: "ok", service: "dspl-orchestrator" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/dspl/v1/providers") {
      sendJson(response, 200, {
        schemaVersion: "dspl-provider-index/v1",
        providers: externalProjects.providerIndex(),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/dspl/v1/descriptors/validate") {
      try {
        const body = await readJsonBody(request) as { descriptor?: unknown; requireReady?: boolean };
        const result = externalProjects.validateDescriptor(body?.descriptor, Boolean(body?.requireReady));
        sendJson(response, result.valid ? 200 : 422, result);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "No se pudo validar el descriptor." });
      }
      return;
    }
    if (request.method === "POST" && request.url === "/api/dspl/v1/descriptors/draft") {
      try {
        const body = await readJsonBody(request) as {
          projectId?: string;
          projectName?: string;
          features?: Array<{ id: string; name?: string }>;
        };
        const descriptor = externalProjects.createDraft(
          body.projectId || "",
          body.projectName || "",
          Array.isArray(body.features) ? body.features : []
        );
        sendJson(response, 200, {
          descriptor,
          validation: externalProjects.validateDescriptor(descriptor),
        });
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "No se pudo generar el borrador." });
      }
      return;
    }
    if (
      request.method === "POST" &&
      (request.url === "/api/dspl/v1/connections/validate" || request.url === "/api/dspl/v1/connections")
    ) {
      try {
        const body = await readJsonBody(request) as GitProjectConnectionInput;
        const result = externalProjects.validateConnection(
          body,
          request.url === "/api/dspl/v1/connections"
        );
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error instanceof ExternalProjectError ? 422 : 400, {
          error: error instanceof Error ? error.message : "No se pudo validar la conexión Git.",
        });
      }
      return;
    }
    const connectionMatch = request.url?.match(/^\/api\/dspl\/v1\/connections\/([^/]+)$/);
    if (request.method === "GET" && connectionMatch) {
      try {
        sendJson(response, 200, externalProjects.getConnection(decodeURIComponent(connectionMatch[1])));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : "Conexión no encontrada." });
      }
      return;
    }
    const descriptorMatch = request.url?.match(
      /^\/api\/dspl\/v1\/connections\/([^/]+)\/descriptor\/validate$/
    );
    if (request.method === "POST" && descriptorMatch) {
      try {
        const result = externalProjects.validateStoredDescriptor(decodeURIComponent(descriptorMatch[1]));
        sendJson(response, result.valid ? 200 : 422, result);
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "No se pudo validar el descriptor." });
      }
      return;
    }
    if (request.method === "POST" && request.url === "/api/dspl/v1/imports") {
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
        sendJson(response, 422, { error: error instanceof Error ? error.message : "No se pudo importar el proyecto." });
      }
      return;
    }
    const importMatch = request.url?.match(/^\/api\/dspl\/v1\/imports\/([^/]+)$/);
    if (request.method === "GET" && importMatch) {
      try {
        sendJson(response, 200, externalProjects.getImport(decodeURIComponent(importMatch[1])));
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : "Importación no encontrada." });
      }
      return;
    }
    if (request.method === "GET" && request.url === "/api/dspl/v1/profiles") {
      try {
        if (!resourceRegistry || !resourceRegistryPath) throw new DsplHttpServerError(404, "No hay perfiles DSPL configurados.");
        const profiles = Object.entries(resourceRegistry.profiles || {}).map(([id, profile]) => {
          const catalogPath = resourceRegistry.catalogs[profile.catalogRef];
          const targetEntry = resourceRegistry.targets[profile.targetRef];
          if (!catalogPath || !targetEntry) throw new DsplHttpServerError(422, `El perfil '${id}' no referencia recursos autorizados.`);
          const catalog = loadJson<ArtifactCatalog>(resolveRegistryPath(resourceRegistryPath, catalogPath));
          const target = loadJson<DeploymentTarget>(resolveRegistryPath(resourceRegistryPath, targetEntry.path));
          return {
            id, name: profile.name, mappingRef: profile.mappingRef, catalogRef: profile.catalogRef, targetRef: profile.targetRef,
            builderAdapter: catalog.derivation.builderAdapter, testAdapter: catalog.derivation.testAdapter || null, deployerAdapter: target.adapter,
            artifacts: catalog.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, version: artifact.version })),
          };
        });
        sendJson(response, 200, {
          schemaVersion: "dspl-profile-index/v1",
          profiles: [...profiles, ...externalProjects.importedProfiles()],
        });
      } catch (error) {
        const statusCode = error instanceof DsplHttpServerError ? error.statusCode : 422;
        sendJson(response, statusCode, { error: error instanceof Error ? error.message : "No se pudieron leer los perfiles DSPL." });
      }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/dspl/v1/catalogs/")) {
      try {
        if (!resourceRegistry || !resourceRegistryPath) {
          throw new DsplHttpServerError(404, "No hay catálogos DSPL públicos configurados.");
        }
        const catalogRef = decodeURIComponent(request.url.slice("/api/dspl/v1/catalogs/".length));
        const externalCatalog = externalProjects.catalogSummary(catalogRef);
        if (externalCatalog) {
          sendJson(response, 200, externalCatalog);
          return;
        }
        if (!isStableId(catalogRef) || !resourceRegistry.catalogs[catalogRef]) {
          throw new DsplHttpServerError(404, "El catálogo solicitado no está autorizado.");
        }
        const catalog = loadJson<ArtifactCatalog>(resolveRegistryPath(resourceRegistryPath, resourceRegistry.catalogs[catalogRef]));
        sendJson(response, 200, {
          id: catalog.id,
          version: catalog.version,
          artifacts: catalog.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, version: artifact.version })),
        });
      } catch (error) {
        const statusCode = error instanceof DsplHttpServerError ? error.statusCode : 422;
        sendJson(response, statusCode, { error: error instanceof Error ? error.message : "No se pudo leer el catálogo DSPL." });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/dspl/v1/derivations") {
      sendJson(response, 404, { error: "Ruta DSPL no encontrada." });
      return;
    }

    try {
      const input = validateMappingRequestBody(await readJsonBody(request));
        const featureErrors = validateFeatureModel(input.featureModel);
        if (featureErrors.length) throw new DsplHttpServerError(422, `Configuración de features inválida: ${featureErrors.join(" | ")}`);
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
          throw new DsplHttpServerError(409, "El modelo o el mapping cambió después de generar el plan; genera un nuevo plan antes de continuar.");
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
            throw new DsplHttpServerError(422, `No existe builder autorizado para '${resources.catalog.derivation.builderAdapter}'.`);
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
            throw new DsplHttpServerError(422, `No existe deployer autorizado para '${resources.target.adapter}'.`);
          }
        }
        sendJson(response, 200, responseBody);
    } catch (error) {
      const statusCode = error instanceof DsplHttpServerError ? error.statusCode : 422;
      const message = error instanceof Error ? error.message : "No se pudo completar la derivación DSPL.";
      sendJson(response, statusCode, { error: message });
    }
  };
}

export function createLocalDsplHttpServerConfig(
  workspaceRoot: string = process.cwd()
): DsplHttpServerConfig {
  const environment = process.env;
  const origins = environment.DSPL_UI_ORIGINS || [
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://127.0.0.1:3002",
    "http://localhost:3002",
  ].join(",");

  return {
    gitRepositories: {},
    outputRoot: environment.DSPL_OUTPUT_ROOT || "/tmp/variamos-dspl/products",
    releaseStateDirectory: environment.DSPL_RELEASE_STATE || "/tmp/variamos-dspl/releases",
    allowedOrigins: origins.split(",").map((origin) => origin.trim()).filter(Boolean),
    resourceRegistryPath: environment.DSPL_RESOURCE_REGISTRY_PATH || path.join(
      workspaceRoot,
      "contracts/resource-registry.local.json"
    ),
    externalProjectStateDirectory:
      environment.DSPL_EXTERNAL_PROJECT_STATE || "/tmp/variamos-dspl-external-projects",
    projectDescriptorSchemaPath:
      environment.DSPL_PROJECT_DESCRIPTOR_SCHEMA ||
      path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
    allowLocalGitRepositories:
      environment.DSPL_ALLOW_LOCAL_GIT_REPOSITORIES === "true",
  };
}
