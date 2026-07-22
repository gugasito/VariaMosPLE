import Ajv2020, { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { ArtifactCatalog, DeploymentTarget } from "../contracts";
import {
  GitProjectConnection,
  GitProjectConnectionInput,
  VariamosProjectDescriptor,
  VariamosProjectProfile,
} from "../domain/ProjectDescriptor";

const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const ALLOWED_BUILDERS = new Set(["static-site-v1", "node-modular-monolith-v1"]);
const ALLOWED_TESTERS = new Set(["html-validation-v1", "node-test-v1"]);

export interface ExternalProjectTarget {
  ref: string;
  target: DeploymentTarget;
  port: number;
  releaseState: string;
  dataState?: string;
}

export interface ImportedExternalProfile {
  id: string;
  name: string;
  mappingRef: string;
  catalogRef: string;
  targetRef: string;
  builderAdapter: string;
  testAdapter: string | null;
  deployerAdapter: string;
  artifacts: Array<{ id: string; kind: string; version: string; label?: string }>;
  provenance: {
    connectionId: string;
    requestedRef: string;
    resolvedCommit: string;
    descriptorPath: string;
    descriptorDigest: string;
  };
}

interface StoredImport {
  id: string;
  connectionId: string;
  catalog: ArtifactCatalog;
  profile: ImportedExternalProfile;
}

export interface ExternalProjectServiceOptions {
  stateDirectory: string;
  descriptorSchemaPath: string;
  allowLocalGitRepositories?: boolean;
  targets: () => ExternalProjectTarget[];
}

export class ExternalProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalProjectError";
    Object.setPrototypeOf(this, ExternalProjectError.prototype);
  }
}

function digest(content: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function shortDigest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safePath(value: string, label: string): string {
  if (!value || path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")) {
    throw new ExternalProjectError(`${label} debe ser una ruta relativa segura.`);
  }
  return value;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}

export class ExternalProjectService {
  private readonly validateSchema: ValidateFunction;
  private readonly connections = new Map<string, GitProjectConnection>();
  private readonly imports = new Map<string, StoredImport>();

  constructor(private readonly options: ExternalProjectServiceOptions) {
    const schema = JSON.parse(fs.readFileSync(options.descriptorSchemaPath, "utf8"));
    this.validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    fs.mkdirSync(this.connectionDirectory(), { recursive: true });
    fs.mkdirSync(this.importDirectory(), { recursive: true });
    fs.mkdirSync(this.checkoutDirectory(), { recursive: true });
    this.loadState();
  }

  public providerIndex() {
    return [{
      id: "git",
      name: "Repositorio Git",
      descriptorPath: ".variamos/dspl.json",
      supportsCredentialRef: true,
      help: "Conecta un repositorio y fija una rama o tag a un commit antes de planificar.",
    }];
  }

  public validateDescriptor(value: unknown, requireReady = false): { valid: boolean; errors: string[] } {
    const schemaValid = this.validateSchema(value);
    const errors = schemaValid ? [] : formatSchemaErrors(this.validateSchema.errors);
    if (!schemaValid || !value || typeof value !== "object") return { valid: false, errors };
    const descriptor = value as VariamosProjectDescriptor;
    const artifactIds = new Set<string>();
    descriptor.artifacts.forEach((artifact) => {
      if (artifactIds.has(artifact.id)) errors.push(`El id de artefacto '${artifact.id}' está duplicado.`);
      artifactIds.add(artifact.id);
    });
    const profileIds = new Set<string>();
    descriptor.profiles.forEach((profile) => {
      if (profileIds.has(profile.id)) errors.push(`El id de perfil '${profile.id}' está duplicado.`);
      profileIds.add(profile.id);
      if (!ALLOWED_BUILDERS.has(profile.builderAdapter)) errors.push(`El builder '${profile.builderAdapter}' no está autorizado.`);
      if (profile.testAdapter && !ALLOWED_TESTERS.has(profile.testAdapter)) errors.push(`El tester '${profile.testAdapter}' no está autorizado.`);
      (profile.artifactIds || []).forEach((id) => {
        if (!artifactIds.has(id)) errors.push(`El perfil '${profile.id}' referencia el artefacto inexistente '${id}'.`);
      });
    });
    descriptor.artifacts.forEach((artifact) => (artifact.dependsOn || []).forEach((id) => {
      if (!artifactIds.has(id)) errors.push(`El artefacto '${artifact.id}' depende del artefacto inexistente '${id}'.`);
      if (id === artifact.id) errors.push(`El artefacto '${artifact.id}' no puede depender de sí mismo.`);
    }));
    if (requireReady && descriptor.status !== "ready") errors.push("El descriptor debe estar listo antes de importarse.");
    return { valid: errors.length === 0, errors };
  }

  public validateConnection(input: GitProjectConnectionInput, persist = false) {
    this.assertConnectionInput(input);
    if (persist && (!input.expectedResolvedCommit || !input.expectedDescriptorDigest)) {
      throw new ExternalProjectError(
        "Guardar una conexión requiere el commit y el digest obtenidos en la vista previa; valida nuevamente antes de guardar."
      );
    }
    const descriptorPath = safePath(input.descriptorPath || ".variamos/dspl.json", "descriptorPath");
    const checkoutPath = path.join(this.checkoutDirectory(), input.id);
    this.prepareCheckout(input.repositoryUrl, checkoutPath);
    const resolvedCommit = this.resolveCommit(checkoutPath, input.requestedRef);
    const descriptorContent = this.gitShow(checkoutPath, resolvedCommit, descriptorPath, 1024 * 1024);
    let descriptor: VariamosProjectDescriptor;
    try {
      descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    } catch (_error) {
      throw new ExternalProjectError("El descriptor del proyecto no contiene JSON válido.");
    }
    const validation = this.validateDescriptor(descriptor, true);
    if (!validation.valid) throw new ExternalProjectError(`Descriptor inválido: ${validation.errors.join(" | ")}`);
    const connection: GitProjectConnection = {
      ...input,
      descriptorPath,
      resolvedCommit,
      checkoutPath,
      descriptorDigest: digest(descriptorContent),
      validatedAt: new Date().toISOString(),
    };
    if (input.expectedResolvedCommit && input.expectedResolvedCommit !== resolvedCommit) {
      throw new ExternalProjectError("La referencia Git cambió después de la vista previa; valida nuevamente antes de guardar.");
    }
    if (input.expectedDescriptorDigest && input.expectedDescriptorDigest !== connection.descriptorDigest) {
      throw new ExternalProjectError("El descriptor cambió después de la vista previa; valida nuevamente antes de guardar.");
    }
    if (persist) {
      this.connections.set(connection.id, connection);
      this.writeJson(path.join(this.connectionDirectory(), `${connection.id}.json`), connection);
    }
    return { connection: this.publicConnection(connection), descriptor, validation };
  }

  public getConnection(id: string) {
    const connection = this.connections.get(id);
    if (!connection) throw new ExternalProjectError(`No existe la conexión '${id}'.`);
    return this.publicConnection(connection);
  }

  public validateStoredDescriptor(connectionId: string) {
    const connection = this.requireConnection(connectionId);
    const content = this.gitShow(connection.checkoutPath, connection.resolvedCommit, connection.descriptorPath, 1024 * 1024);
    const descriptor = JSON.parse(content.toString("utf8"));
    return { ...this.validateDescriptor(descriptor, true), descriptorDigest: digest(content), resolvedCommit: connection.resolvedCommit };
  }

  public importProject(connectionId: string, profileId: string, targetRef?: string): ImportedExternalProfile {
    const connection = this.requireConnection(connectionId);
    const descriptorContent = this.gitShow(connection.checkoutPath, connection.resolvedCommit, connection.descriptorPath, 1024 * 1024);
    const descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    const validation = this.validateDescriptor(descriptor, true);
    if (!validation.valid) throw new ExternalProjectError(`Descriptor inválido: ${validation.errors.join(" | ")}`);
    if (digest(descriptorContent) !== connection.descriptorDigest) {
      throw new ExternalProjectError("El descriptor cambió respecto de la conexión validada; valida nuevamente la conexión.");
    }
    const descriptorProfile = descriptor.profiles.find((item) => item.id === profileId);
    if (!descriptorProfile) throw new ExternalProjectError(`El descriptor no contiene el perfil '${profileId}'.`);
    const target = this.selectTarget(descriptorProfile, targetRef);
    const allowedIds = new Set(descriptorProfile.artifactIds || descriptor.artifacts.map((artifact) => artifact.id));
    const selectedArtifacts = descriptor.artifacts.filter((artifact) => allowedIds.has(artifact.id));
    if (selectedArtifacts.length !== allowedIds.size) throw new ExternalProjectError("El perfil contiene referencias de artefactos incompletas.");
    const catalogRef = `external.catalog.${shortDigest(`${connection.id}:${connection.resolvedCommit}:${profileId}`)}`;
    const catalog: ArtifactCatalog = {
      schemaVersion: "artifact-catalog/v1",
      id: catalogRef,
      version: "1.0.0",
      derivation: { builderAdapter: descriptorProfile.builderAdapter, ...(descriptorProfile.testAdapter ? { testAdapter: descriptorProfile.testAdapter } : {}) },
      artifacts: selectedArtifacts.map((artifact) => {
        const content = this.gitShow(connection.checkoutPath, connection.resolvedCommit, artifact.source.path, 5 * 1024 * 1024);
        const calculatedDigest = digest(content);
        if (artifact.integrity && artifact.integrity.digest.toLowerCase() !== calculatedDigest) {
          throw new ExternalProjectError(`El digest declarado de '${artifact.id}' no coincide con el commit importado.`);
        }
        const entrypoint = artifact.build?.entrypoint;
        return {
          schemaVersion: "artifact/v1" as const,
          id: artifact.id,
          kind: artifact.kind,
          version: artifact.version,
          source: { provider: "git", location: connection.repositoryUrl, ref: connection.resolvedCommit, path: artifact.source.path },
          integrity: { algorithm: "sha256" as const, digest: calculatedDigest },
          build: { adapter: this.artifactAdapter(descriptorProfile, artifact.kind), entrypoint: entrypoint || null },
          ...(artifact.dependsOn ? { dependsOn: artifact.dependsOn } : {}),
          requiresCapabilities: artifact.requiresCapabilities || descriptorProfile.requiredTargetCapabilities,
        };
      }),
    };
    const importId = `external.import.${shortDigest(`${catalogRef}:${target.ref}`)}`;
    const profile: ImportedExternalProfile = {
      id: importId,
      name: `${descriptor.project.name} — ${descriptorProfile.name}`,
      mappingRef: `mapping.${shortDigest(importId)}.v1`,
      catalogRef,
      targetRef: target.ref,
      builderAdapter: descriptorProfile.builderAdapter,
      testAdapter: descriptorProfile.testAdapter || null,
      deployerAdapter: target.target.adapter,
      artifacts: selectedArtifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, version: artifact.version, label: artifact.label })),
      provenance: {
        connectionId,
        requestedRef: connection.requestedRef,
        resolvedCommit: connection.resolvedCommit,
        descriptorPath: connection.descriptorPath,
        descriptorDigest: connection.descriptorDigest,
      },
    };
    const stored: StoredImport = { id: importId, connectionId, catalog, profile };
    this.imports.set(importId, stored);
    this.writeJson(path.join(this.importDirectory(), `${importId}.json`), stored);
    return profile;
  }

  public importedProfiles(): ImportedExternalProfile[] {
    return [...this.imports.values()].map((item) => item.profile);
  }

  public getImport(id: string): ImportedExternalProfile {
    const item = this.imports.get(id);
    if (!item) throw new ExternalProjectError(`No existe la importación '${id}'.`);
    return item.profile;
  }

  public catalogSummary(catalogRef: string) {
    const imported = [...this.imports.values()].find((item) => item.catalog.id === catalogRef);
    if (!imported) return undefined;
    return {
      id: imported.catalog.id,
      version: imported.catalog.version,
      artifacts: imported.profile.artifacts,
      provenance: imported.profile.provenance,
    };
  }

  public resources(catalogRef: string, targetRef: string) {
    const imported = [...this.imports.values()].find((item) => item.catalog.id === catalogRef && item.profile.targetRef === targetRef);
    if (!imported) return undefined;
    const connection = this.requireConnection(imported.connectionId);
    const target = this.options.targets().find((item) => item.ref === targetRef);
    if (!target) throw new ExternalProjectError(`El target importado '${targetRef}' ya no está autorizado.`);
    return {
      catalog: imported.catalog,
      target: target.target,
      targetEntry: { port: target.port, releaseState: target.releaseState, ...(target.dataState ? { dataState: target.dataState } : {}) },
      gitRepositories: { [connection.repositoryUrl]: connection.checkoutPath },
    };
  }

  public createDraft(projectId: string, projectName: string, features: Array<{ id: string; name?: string }>): VariamosProjectDescriptor {
    if (!STABLE_ID.test(projectId)) throw new ExternalProjectError("projectId debe ser un ID estable en minúsculas.");
    if (!projectName.trim()) throw new ExternalProjectError("projectName es obligatorio.");
    return {
      schemaVersion: "variamos-project/v1",
      status: "draft",
      project: { id: projectId, name: projectName.trim() },
      artifacts: [],
      profiles: [],
      artifactProposals: features.map((feature) => ({
        featureId: feature.id,
        label: `Artefacto por definir para '${feature.name || feature.id}'`,
        questions: [
          "¿Es un archivo, módulo, configuración, plantilla, prueba o imagen de contenedor?",
          "¿Cuál es su ID estable y su versión real?",
          "¿En qué ruta relativa existe dentro del repositorio?",
        ],
      })),
      pending: [
        {
          kind: "profile",
          featureId: "project",
          question: "¿Qué builder autorizado, pruebas y capacidades de destino necesita este proyecto?",
        },
        ...features.flatMap((feature) => [
          {
            kind: "artifact" as const,
            featureId: feature.id,
            question: `¿Qué artefacto real implementa la feature '${feature.name || feature.id}'?`,
          },
          {
            kind: "path" as const,
            featureId: feature.id,
            question: `¿Cuál es la ruta relativa comprobada de ese artefacto para '${feature.name || feature.id}'?`,
          },
          {
            kind: "binding" as const,
            featureId: feature.id,
            question: `¿Debe '${feature.name || feature.id}' vincularse a uno o a varios artefactos declarados?`,
          },
        ]),
      ],
    };
  }

  private publicConnection(connection: GitProjectConnection) {
    const {
      checkoutPath: _checkoutPath,
      credentialRef: _credentialRef,
      expectedResolvedCommit: _expectedResolvedCommit,
      expectedDescriptorDigest: _expectedDescriptorDigest,
      ...safe
    } = connection;
    return { ...safe, usesCredentialRef: Boolean(connection.credentialRef) };
  }

  private assertConnectionInput(input: GitProjectConnectionInput): void {
    if (!STABLE_ID.test(input.id)) throw new ExternalProjectError("El ID de conexión no tiene formato estable.");
    if (input.provider !== "git") throw new ExternalProjectError("El provider solicitado no está soportado.");
    if (!SAFE_REF.test(input.requestedRef) || input.requestedRef.includes("..") || input.requestedRef.includes("@{")) {
      throw new ExternalProjectError("La rama, tag o referencia Git no es segura.");
    }
    if (input.credentialRef && !/^secret:\/\/[a-z0-9][a-z0-9/_-]*$/.test(input.credentialRef)) {
      throw new ExternalProjectError("credentialRef debe ser una referencia secret:// opaca.");
    }
    this.assertRepositoryUrl(input.repositoryUrl);
  }

  private assertRepositoryUrl(value: string): void {
    const isLocal = path.isAbsolute(value);
    if (isLocal) {
      if (!this.options.allowLocalGitRepositories) throw new ExternalProjectError("Las rutas Git locales no están habilitadas en este entorno.");
      return;
    }
    if (/^git@[^:]+:[^\s]+$/.test(value)) return;
    let parsed: URL;
    try { parsed = new URL(value); } catch (_error) { throw new ExternalProjectError("repositoryUrl debe ser HTTPS, SSH o una ruta local autorizada."); }
    if (!["https:", "ssh:"].includes(parsed.protocol)) throw new ExternalProjectError("Sólo se permiten repositorios HTTPS o SSH.");
    if (parsed.username || parsed.password) throw new ExternalProjectError("No incluyas credenciales dentro de repositoryUrl; usa credentialRef.");
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new ExternalProjectError("El host Git loopback no está permitido como remoto.");
  }

  private prepareCheckout(repositoryUrl: string, checkoutPath: string): void {
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
      fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
      execFileSync("git", ["clone", "--no-checkout", "--origin", "origin", "--", repositoryUrl, checkoutPath], { env: environment, stdio: "pipe", timeout: 60000, windowsHide: true });
    } else {
      const origin = execFileSync("git", ["-C", checkoutPath, "config", "--get", "remote.origin.url"], { encoding: "utf8", windowsHide: true }).trim();
      if (origin !== repositoryUrl) throw new ExternalProjectError("El checkout administrado no corresponde al repositorio solicitado.");
      execFileSync("git", ["-C", checkoutPath, "fetch", "--force", "--tags", "origin"], { env: environment, stdio: "pipe", timeout: 60000, windowsHide: true });
    }
  }

  private resolveCommit(checkoutPath: string, requestedRef: string): string {
    const candidates = [requestedRef, `refs/remotes/origin/${requestedRef}`, `refs/tags/${requestedRef}`];
    for (const candidate of candidates) {
      try {
        return execFileSync("git", ["-C", checkoutPath, "rev-parse", "--verify", `${candidate}^{commit}`], { encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
      } catch (_error) { /* prueba la siguiente forma explícita */ }
    }
    throw new ExternalProjectError(`No se pudo resolver '${requestedRef}' a un commit Git.`);
  }

  private gitShow(checkoutPath: string, commit: string, relativePath: string, maxBuffer: number): Buffer {
    safePath(relativePath, "La ruta del artefacto");
    try {
      return execFileSync("git", ["-C", checkoutPath, "show", `${commit}:${relativePath}`], { encoding: "buffer", maxBuffer, timeout: 20000, windowsHide: true }) as Buffer;
    } catch (_error) {
      throw new ExternalProjectError(`No existe '${relativePath}' en el commit '${commit}'.`);
    }
  }

  private selectTarget(profile: VariamosProjectProfile, requested?: string): ExternalProjectTarget {
    const candidates = this.options.targets().filter((item) =>
      (!requested || item.ref === requested) &&
      profile.requiredTargetCapabilities.every((capability) => item.target.capabilities.includes(capability)) &&
      (profile.builderAdapter === "static-site-v1" ? item.target.adapter === "nginx-container-v1" : item.target.adapter === "node-container-v1")
    );
    if (candidates.length === 0) throw new ExternalProjectError("No existe un target autorizado compatible con el perfil del descriptor.");
    return candidates.sort((left, right) => {
      const leftGeneric = left.ref.startsWith("variamos.") ? 0 : 1;
      const rightGeneric = right.ref.startsWith("variamos.") ? 0 : 1;
      return leftGeneric - rightGeneric || left.ref.localeCompare(right.ref);
    })[0];
  }

  private artifactAdapter(profile: VariamosProjectProfile, kind: string): string {
    if (profile.builderAdapter === "static-site-v1" && kind === "html-fragment") return "static-fragment-v1";
    if (profile.builderAdapter === "node-modular-monolith-v1") return "node-module-v1";
    throw new ExternalProjectError(`El builder '${profile.builderAdapter}' no admite artefactos '${kind}'.`);
  }

  private requireConnection(id: string): GitProjectConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new ExternalProjectError(`No existe la conexión '${id}'.`);
    return connection;
  }

  private connectionDirectory() { return path.join(this.options.stateDirectory, "connections"); }
  private importDirectory() { return path.join(this.options.stateDirectory, "imports"); }
  private checkoutDirectory() { return path.join(this.options.stateDirectory, "checkouts"); }

  private loadState(): void {
    for (const fileName of fs.readdirSync(this.connectionDirectory()).filter((item) => item.endsWith(".json"))) {
      const value = JSON.parse(fs.readFileSync(path.join(this.connectionDirectory(), fileName), "utf8")) as GitProjectConnection;
      this.connections.set(value.id, value);
    }
    for (const fileName of fs.readdirSync(this.importDirectory()).filter((item) => item.endsWith(".json"))) {
      const value = JSON.parse(fs.readFileSync(path.join(this.importDirectory(), fileName), "utf8")) as StoredImport;
      this.imports.set(value.id, value);
    }
  }

  private writeJson(fileName: string, value: unknown): void {
    const temporary = `${fileName}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, fileName);
  }
}
