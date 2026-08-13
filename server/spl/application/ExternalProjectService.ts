import Ajv2020, { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { SourceAuthenticationAdapterRegistry } from "../adapters/providers/SourceAuthentication";
import { CredentialLease } from "../security/CredentialBroker";
import { ArtifactCatalog, DeploymentTarget } from "../contracts";
import {
  ExternalProjectConnection,
  ExternalProjectConnectionInput,
  FolderUploadConnection,
  FolderUploadConnectionInput,
  GitProjectConnection,
  GitProjectConnectionInput,
  LegacyLocalDirectoryConnection,
  VariamosProjectDescriptor,
  VariamosProjectProfile,
} from "../domain/ProjectDescriptor";
import { TemporaryUploadError, TemporaryUploadStore } from "./TemporaryUploadStore";

const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const BUILDER_ARTIFACT_KINDS = new Map<string, Set<string>>([
  ["static-site-v1", new Set(["html-fragment"])],
  ["node-modular-monolith-v1", new Set(["source-bundle", "module", "configuration", "test-suite"])],
]);
const BUILDER_TESTERS = new Map<string, string>([
  ["static-site-v1", "html-validation-v1"],
  ["node-modular-monolith-v1", "node-test-v1"],
]);
const BUILDER_TARGET_ADAPTERS = new Map<string, Set<string>>([
  ["static-site-v1", new Set(["nginx-container-v1", "ssh-compose-v1"])],
  ["node-modular-monolith-v1", new Set(["node-container-v1", "ssh-compose-v1"])],
]);
const ALLOWED_BUILDERS = new Set(BUILDER_ARTIFACT_KINDS.keys());
const ALLOWED_TESTERS = new Set(["html-validation-v1", "node-test-v1"]);
/** Stable placeholder used only by an imported mapping until its owner picks
 * a real deployment target before planning. It is never deployable itself. */
const UNASSIGNED_TARGET_REF = "target-unassigned";

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
    provider: "git" | "upload";
    requestedRef?: string;
    resolvedCommit?: string;
    snapshotDigest?: string;
    descriptorPath: string;
    descriptorDigest: string;
  };
}

interface StoredImport {
  id: string;
  projectId?: string;
  connectionId: string;
  catalog: ArtifactCatalog;
  profile: ImportedExternalProfile;
}

export interface ExternalProjectServiceOptions {
  stateDirectory: string;
  descriptorSchemaPath: string;
  folderUploadEnabled?: boolean;
  uploadStore?: TemporaryUploadStore;
  targets: (ownerUserId?: string) => ExternalProjectTarget[];
  sourceAuthentication?: SourceAuthenticationAdapterRegistry;
  remoteGitConfigured?: boolean;
}

export interface ExternalProjectSecurityContext {
  actorId: string;
  projectId?: string;
}

export class ExternalProjectError extends Error {
  constructor(message: string, public readonly statusCode = 422, public readonly code?: string, public readonly requiresReupload = false) {
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
    throw new ExternalProjectError(`${label} must be a safe relative path.`);
  }
  return value;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}

export class ExternalProjectService {
  private readonly validateSchema: ValidateFunction;
  private readonly connections = new Map<string, ExternalProjectConnection>();
  private readonly imports = new Map<string, StoredImport>();

  constructor(private readonly options: ExternalProjectServiceOptions) {
    const schema = JSON.parse(fs.readFileSync(options.descriptorSchemaPath, "utf8"));
    this.validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    fs.mkdirSync(this.connectionDirectory(), { recursive: true });
    fs.mkdirSync(this.importDirectory(), { recursive: true });
    this.loadState();
  }

  public providerIndex() {
    return [
      {
        id: "git-remote",
        provider: "git",
        name: "Remote Git repository",
        availability: this.options.remoteGitConfigured === false
          ? "configuration-required"
          : "available",
        descriptorPath: ".variamos/spl.json",
        supportsCredentialRef: true,
        help: this.options.remoteGitConfigured === false
          ? "Requires an operator-configured Git host allowlist."
          : "Connects an HTTPS or SSH URL and pins the branch, tag, or commit before planning.",
        plannedFields: ["repositoryUrl", "requestedRef", "descriptorPath", "credentialRef"],
      },
      {
        id: "folder-upload",
        provider: "upload",
        name: "Upload project folder",
        availability: this.options.folderUploadEnabled ? "available" : "configuration-required",
        descriptorPath: ".variamos/spl.json",
        supportsCredentialRef: false,
        help: this.options.folderUploadEnabled
          ? "Uploads only .variamos/spl.json and its declared artifacts to VariaMos temporarily."
          : "Requires the operator to enable SPL_FOLDER_UPLOAD_ENABLED=true.",
        plannedFields: ["uploadId", "snapshotDigest", "descriptorDigest"],
      },
    ];
  }

  /**
   * A descriptor describes source artifacts and profiles. It remains valid
   * even before the owner configures a deployment target; compatibility is
   * deliberately enforced later, when a profile is imported into a mapping.
   */
  public validateDescriptor(value: unknown, requireReady = false, _ownerUserId?: string): { valid: boolean; errors: string[] } {
    const schemaValid = this.validateSchema(value);
    const errors = schemaValid ? [] : formatSchemaErrors(this.validateSchema.errors);
    if (!schemaValid || !value || typeof value !== "object") return { valid: false, errors };
    const descriptor = value as VariamosProjectDescriptor;
    const artifactIds = new Set<string>();
    descriptor.artifacts.forEach((artifact) => {
      if (artifactIds.has(artifact.id)) errors.push(`Artifact ID '${artifact.id}' is duplicated.`);
      artifactIds.add(artifact.id);
    });
    const profileIds = new Set<string>();
    descriptor.profiles.forEach((profile) => {
      if (profileIds.has(profile.id)) errors.push(`Profile ID '${profile.id}' is duplicated.`);
      profileIds.add(profile.id);
      if (!ALLOWED_BUILDERS.has(profile.builderAdapter)) errors.push(`Builder '${profile.builderAdapter}' is not authorized.`);
      if (profile.testAdapter && !ALLOWED_TESTERS.has(profile.testAdapter)) errors.push(`Test adapter '${profile.testAdapter}' is not authorized.`);
      const expectedTester = BUILDER_TESTERS.get(profile.builderAdapter);
      if (expectedTester && !profile.testAdapter) {
        errors.push(`Profile '${profile.id}' must declare test adapter '${expectedTester}'.`);
      } else if (expectedTester && profile.testAdapter !== expectedTester) {
        errors.push(`Builder '${profile.builderAdapter}' requires test adapter '${expectedTester}', not '${profile.testAdapter}'.`);
      }
      const selectedIds = profile.artifactIds || descriptor.artifacts.map((artifact) => artifact.id);
      const selectedIdSet = new Set(selectedIds);
      selectedIds.forEach((id) => {
        if (!artifactIds.has(id)) errors.push(`Profile '${profile.id}' references missing artifact '${id}'.`);
      });
      const selectedArtifacts = descriptor.artifacts.filter((artifact) => selectedIdSet.has(artifact.id));
      const allowedKinds = BUILDER_ARTIFACT_KINDS.get(profile.builderAdapter);
      selectedArtifacts.forEach((artifact) => {
        if (allowedKinds && !allowedKinds.has(artifact.kind)) {
          errors.push(`Builder '${profile.builderAdapter}' does not support type '${artifact.kind}' for artifact '${artifact.id}'.`);
        }
        (artifact.dependsOn || []).forEach((dependency) => {
          if (!selectedIdSet.has(dependency)) {
            errors.push(`Profile '${profile.id}' includes '${artifact.id}' but not its dependency '${dependency}'.`);
          }
        });
      });
    });
    descriptor.artifacts.forEach((artifact) => (artifact.dependsOn || []).forEach((id) => {
      if (!artifactIds.has(id)) errors.push(`Artifact '${artifact.id}' depends on missing artifact '${id}'.`);
      if (id === artifact.id) errors.push(`Artifact '${artifact.id}' cannot depend on itself.`);
    }));
    if (requireReady && descriptor.status !== "ready") errors.push("The descriptor must be ready before it can be imported.");
    return { valid: errors.length === 0, errors };
  }

  public async validateConnection(
    input: ExternalProjectConnectionInput,
    persist = false,
    security: ExternalProjectSecurityContext
  ) {
    if (input.provider === "upload") return this.validateUploadConnection(input, persist, security);
    return this.validateGitConnection(input, persist, security);
  }

  private async validateGitConnection(
    input: GitProjectConnectionInput,
    persist: boolean,
    security: ExternalProjectSecurityContext
  ) {
    this.assertGitConnectionInput(input);
    if (persist && (!input.expectedResolvedCommit || !input.expectedDescriptorDigest)) {
      throw new ExternalProjectError(
        "Saving a connection requires the commit and digest returned by the preview; validate it again before saving."
      );
    }
    const descriptorPath = safePath(input.descriptorPath || ".variamos/spl.json", "descriptorPath");
    const authentication = this.options.sourceAuthentication
      ? await this.options.sourceAuthentication.require(input.repositoryUrl).prepare({
        projectId: security.projectId || input.projectId,
        actorId: security.actorId,
        connectionId: input.id,
        repositoryUrl: input.repositoryUrl,
        credentialRef: input.credentialRef,
        sshHostKeyFingerprint: input.sshHostKeyFingerprint,
      })
      : {
        environment: { GIT_TERMINAL_PROMPT: "0" },
        gitPrefixArguments: [] as string[],
        dispose: () => undefined,
      };
    const workspace = this.createTemporaryGitWorkspace();
    let resolvedCommit: string;
    let descriptorContent: Buffer;
    try {
      this.prepareCheckout(input.repositoryUrl, workspace, authentication);
      resolvedCommit = this.resolveCommit(workspace, input.requestedRef);
      descriptorContent = this.gitShow(workspace, resolvedCommit, descriptorPath, 1024 * 1024);
    } finally {
      authentication.dispose();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    let descriptor: VariamosProjectDescriptor;
    try {
      descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    } catch (_error) {
      throw new ExternalProjectError("The project descriptor does not contain valid JSON.");
    }
    const validation = this.validateDescriptor(descriptor, true, security.actorId);
    if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
    const connection: GitProjectConnection = {
      ...input,
      descriptorPath,
      resolvedCommit,
      descriptorDigest: digest(descriptorContent),
      validatedAt: new Date().toISOString(),
    };
    if (input.expectedResolvedCommit && input.expectedResolvedCommit !== resolvedCommit) {
      throw new ExternalProjectError("The Git reference changed after the preview; validate it again before saving.");
    }
    if (input.expectedDescriptorDigest && input.expectedDescriptorDigest !== connection.descriptorDigest) {
      throw new ExternalProjectError("The descriptor changed after the preview; validate it again before saving.");
    }
    if (persist) {
      this.connections.set(this.connectionKey(connection.id, connection.projectId), connection);
      this.writeJson(path.join(this.connectionDirectory(), this.connectionFileName(connection)), connection);
    }
    return { connection: this.publicConnection(connection), descriptor, validation };
  }

  private validateUploadConnection(input: FolderUploadConnectionInput, persist: boolean, security: ExternalProjectSecurityContext) {
    this.assertUploadConnectionInput(input);
    if (persist && (!input.expectedSnapshotDigest || !input.expectedDescriptorDigest)) {
      throw new ExternalProjectError(
        "Saving an uploaded folder requires the digests returned by the upload; upload it again before saving."
      );
    }
    const projectId = input.projectId || security.projectId;
    if (!projectId) throw new ExternalProjectError("An uploaded folder must be associated with a project.");
    let lease;
    try { lease = this.options.uploadStore?.acquire(input.uploadId, projectId, security.actorId); }
    catch (error) {
      if (error instanceof TemporaryUploadError) throw new ExternalProjectError(error.message, error.statusCode, error.code, error.requiresReupload);
      throw error;
    }
    if (!lease) throw new ExternalProjectError("Folder uploads are not enabled in this environment.");
    const descriptorPath = safePath(input.descriptorPath || ".variamos/spl.json", "descriptorPath");
    try {
      const descriptorContent = this.readLocalFile(lease.upload.root, descriptorPath, 1024 * 1024);
      let descriptor: VariamosProjectDescriptor;
      try { descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor; }
      catch (_error) { throw new ExternalProjectError("The project descriptor does not contain valid JSON."); }
      const validation = this.validateDescriptor(descriptor, true, security.actorId);
      if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
      const expectedFiles = new Set([descriptorPath, ...descriptor.artifacts.map((artifact) => safePath(artifact.source.path, `Path for artifact '${artifact.id}'`))]);
      for (const relativePath of expectedFiles) this.readLocalFile(lease.upload.root, relativePath, relativePath === descriptorPath ? 1024 * 1024 : 5 * 1024 * 1024);
      if (input.expectedSnapshotDigest && input.expectedSnapshotDigest !== lease.upload.snapshotDigest) throw new ExternalProjectError("The uploaded folder differs from the validated snapshot.");
      if (input.expectedDescriptorDigest && input.expectedDescriptorDigest !== lease.upload.descriptorDigest) throw new ExternalProjectError("The descriptor differs from the validated upload.");
      const connection: FolderUploadConnection = {
        ...input, projectId, descriptorPath, sourceLocation: `external.upload.${input.id}`,
        snapshotDigest: lease.upload.snapshotDigest, descriptorDigest: lease.upload.descriptorDigest, sourceExpiresAt: lease.upload.expiresAt, validatedAt: new Date().toISOString(),
      };
      if (persist) { this.connections.set(this.connectionKey(connection.id, projectId), connection); this.writeJson(path.join(this.connectionDirectory(), this.connectionFileName(connection)), connection); }
      return { connection: this.publicConnection(connection), descriptor, validation, upload: this.publicUpload(lease.upload) };
    } finally { lease.release(); }
  }

  public getConnection(id: string, projectId?: string) {
    const connection = this.requireConnection(id, projectId);
    return this.publicConnection(connection);
  }

  public validateStoredDescriptor(connectionId: string, projectId?: string, ownerUserId?: string) {
    const connection = this.requireConnection(connectionId, projectId);
    const lease = this.acquireConnectionSource(connection, projectId);
    try {
    const content = this.readLocalFile(lease.root, connection.descriptorPath || ".variamos/spl.json", 1024 * 1024);
    const descriptor = JSON.parse(content.toString("utf8"));
    return {
      ...this.validateDescriptor(descriptor, true, ownerUserId),
      descriptorDigest: digest(content),
      ...(connection.provider === "git"
        ? { resolvedCommit: connection.resolvedCommit }
        : { snapshotDigest: connection.snapshotDigest }),
    };
    } finally { lease.release(); }
  }

  public async validateSourceCredential(
    connectionId: string,
    projectId: string,
    actorId: string,
    credential: CredentialLease
  ): Promise<void> {
    const connection = this.requireConnection(connectionId, projectId);
    if (connection.provider !== "git" || !connection.credentialRef) {
      throw new ExternalProjectError("The credential is not associated with a private Git connection.");
    }
    if (!this.options.sourceAuthentication) {
      throw new ExternalProjectError("Source authentication is not configured.");
    }
    const authentication = await this.options.sourceAuthentication
      .require(connection.repositoryUrl)
      .prepare({
        projectId,
        actorId,
        connectionId,
        repositoryUrl: connection.repositoryUrl,
        credentialRef: connection.credentialRef,
        sshHostKeyFingerprint: connection.sshHostKeyFingerprint,
        credentialLease: credential,
      });
    try {
      execFileSync(
        "git",
        [
          ...authentication.gitPrefixArguments,
          "ls-remote",
          "--exit-code",
          "--",
          connection.repositoryUrl,
          connection.requestedRef,
        ],
        {
          env: authentication.environment,
          stdio: "pipe",
          timeout: 60_000,
          windowsHide: true,
        }
      );
    } catch (_error) {
      throw new ExternalProjectError("The new credential version could not read the configured Git reference.");
    } finally {
      authentication.dispose();
    }
  }

  public importProject(
    connectionId: string,
    profileId: string,
    targetRef?: string,
    projectId?: string,
    ownerUserId?: string
  ): ImportedExternalProfile {
    const connection = this.requireConnection(connectionId, projectId);
    const lease = this.acquireConnectionSource(connection, projectId, ownerUserId);
    try {
    const descriptorContent = this.readLocalFile(lease.root, connection.descriptorPath || ".variamos/spl.json", 1024 * 1024);
    const descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    const validation = this.validateDescriptor(descriptor, true, ownerUserId);
    if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
    if (digest(descriptorContent) !== connection.descriptorDigest) {
      throw new ExternalProjectError("The descriptor differs from the validated connection; validate the connection again.");
    }
    const descriptorProfile = descriptor.profiles.find((item) => item.id === profileId);
    if (!descriptorProfile) throw new ExternalProjectError(`The descriptor does not contain profile '${profileId}'.`);
    const allowedIds = new Set(descriptorProfile.artifactIds || descriptor.artifacts.map((artifact) => artifact.id));
    const selectedArtifacts = descriptor.artifacts.filter((artifact) => allowedIds.has(artifact.id));
    if (selectedArtifacts.length !== allowedIds.size) throw new ExternalProjectError("The profile contains incomplete artifact references.");
    const target = this.compatibleTargets(descriptorProfile, selectedArtifacts, targetRef, ownerUserId)
      .sort((left, right) => left.ref.localeCompare(right.ref))[0];
    if (targetRef && !target) {
      throw new ExternalProjectError("The selected deployment target is not compatible with the descriptor profile.");
    }
    const revision = connection.provider === "git" ? connection.resolvedCommit : connection.snapshotDigest;
    const catalogRef = `external.catalog.${shortDigest(`${projectId || connection.projectId || "legacy"}:${connection.id}:${revision}:${profileId}`)}`;
    const catalog: ArtifactCatalog = {
      schemaVersion: "artifact-catalog/v1",
      id: catalogRef,
      version: "1.0.0",
      derivation: { builderAdapter: descriptorProfile.builderAdapter, ...(descriptorProfile.testAdapter ? { testAdapter: descriptorProfile.testAdapter } : {}) },
      artifacts: selectedArtifacts.map((artifact) => {
        const content = this.readLocalFile(lease.root, artifact.source.path, 5 * 1024 * 1024);
        const calculatedDigest = digest(content);
        if (artifact.integrity && artifact.integrity.digest.toLowerCase() !== calculatedDigest) {
          throw new ExternalProjectError(`The declared digest for '${artifact.id}' does not match the imported commit.`);
        }
        const entrypoint = artifact.build?.entrypoint;
        return {
          schemaVersion: "artifact/v1" as const,
          id: artifact.id,
          kind: artifact.kind,
          version: artifact.version,
          source: connection.provider === "git"
            ? { provider: "git", location: connection.repositoryUrl, ref: connection.resolvedCommit, path: artifact.source.path }
            : { provider: "local", location: connection.provider === "upload" ? connection.sourceLocation : "external.legacy.unsupported", path: artifact.source.path },
          integrity: { algorithm: "sha256" as const, digest: calculatedDigest },
          build: { adapter: this.artifactAdapter(descriptorProfile, artifact.kind), entrypoint: entrypoint || null },
          ...(artifact.dependsOn ? { dependsOn: artifact.dependsOn } : {}),
          requiresCapabilities: artifact.requiresCapabilities || descriptorProfile.requiredTargetCapabilities,
        };
      }),
    };
    const importId = `external.import.${shortDigest(catalogRef)}`;
    const profile: ImportedExternalProfile = {
      id: importId,
      name: `${descriptor.project.name} — ${descriptorProfile.name}`,
      mappingRef: `mapping.${shortDigest(importId)}.v1`,
      catalogRef,
      targetRef: target?.ref || UNASSIGNED_TARGET_REF,
      builderAdapter: descriptorProfile.builderAdapter,
      testAdapter: descriptorProfile.testAdapter || null,
      // Both supported builders can later be deployed through SSH Compose.
      // The concrete target is intentionally selected before the first plan.
      deployerAdapter: target?.target.adapter || "ssh-compose-v1",
      artifacts: selectedArtifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, version: artifact.version, label: artifact.label })),
      provenance: {
        connectionId,
        provider: connection.provider === "git" ? "git" : "upload",
        ...(connection.provider === "git"
          ? { requestedRef: connection.requestedRef, resolvedCommit: connection.resolvedCommit }
          : { snapshotDigest: connection.snapshotDigest }),
        descriptorPath: connection.descriptorPath || ".variamos/spl.json",
        descriptorDigest: connection.descriptorDigest || "",
      },
    };
    const stored: StoredImport = {
      id: importId,
      connectionId,
      projectId: connection.projectId || projectId,
      catalog,
      profile,
    };
    this.imports.set(importId, stored);
    this.writeJson(path.join(this.importDirectory(), `${importId}.json`), stored);
    return profile;
    } finally { lease.release(); }
  }

  public importedProfiles(projectId?: string): ImportedExternalProfile[] {
    return [...this.imports.values()]
      .filter((item) => !projectId || item.projectId === projectId)
      .map((item) => item.profile);
  }

  public getImport(id: string, projectId?: string): ImportedExternalProfile {
    const item = this.imports.get(id);
    if (!item) throw new ExternalProjectError(`Import '${id}' does not exist.`);
    if (projectId && item.projectId !== projectId) {
      throw new ExternalProjectError("The import belongs to another project.");
    }
    return item.profile;
  }

  public catalogSummary(catalogRef: string, projectId?: string) {
    const imported = [...this.imports.values()].find((item) =>
      item.catalog.id === catalogRef && (!projectId || item.projectId === projectId)
    );
    if (!imported) return undefined;
    return {
      id: imported.catalog.id,
      version: imported.catalog.version,
      artifacts: imported.profile.artifacts,
      provenance: imported.profile.provenance,
    };
  }

  public resources(catalogRef: string, targetRef: string, projectId?: string, ownerUserId?: string) {
    const imported = [...this.imports.values()].find((item) =>
      item.catalog.id === catalogRef && (!projectId || !item.projectId || item.projectId === projectId)
    );
    if (!imported) return undefined;
    const connection = this.requireConnection(imported.connectionId, projectId);
    const target = this.options.targets(ownerUserId).find((item) => item.ref === targetRef);
    if (!target) throw new ExternalProjectError(`Imported target '${targetRef}' is no longer authorized.`);
    return {
      catalog: imported.catalog,
      target: target.target,
      targetEntry: { port: target.port, releaseState: target.releaseState, ...(target.dataState ? { dataState: target.dataState } : {}) },
      ...this.connectionRoots(connection, projectId, ownerUserId),
    };
  }

  public catalogResources(catalogRef: string, projectId?: string, requiresSource = true) {
    const imported = [...this.imports.values()].find((item) =>
      item.catalog.id === catalogRef && (!projectId || !item.projectId || item.projectId === projectId)
    );
    if (!imported) return undefined;
    const connection = this.requireConnection(imported.connectionId, projectId);
    return {
      catalog: imported.catalog,
      ...(requiresSource ? this.connectionRoots(connection, projectId) : { gitRepositories: {}, localRoots: {} }),
    };
  }

  private publicConnection(connection: ExternalProjectConnection) {
    if (connection.provider === "upload") {
      const {
        uploadId: _uploadId,
        expectedSnapshotDigest: _expectedSnapshotDigest,
        expectedDescriptorDigest: _expectedDescriptorDigest,
        ...safe
      } = connection;
      const exists = this.options.uploadStore?.status(connection.uploadId, connection.projectId || "") || "missing";
      const sourceStatus = new Date(connection.sourceExpiresAt).getTime() <= Date.now() ? "expired" : exists;
      return { ...safe, scope: "project", sourceStatus, sourceExpiresAt: connection.sourceExpiresAt, usesCredentialRef: false };
    }
    if (connection.provider === "local") return { id: connection.id, projectId: connection.projectId, provider: "local", sourceStatus: "unsupported", usesCredentialRef: false };
    const {
      credentialRef: _credentialRef,
      expectedResolvedCommit: _expectedResolvedCommit,
      expectedDescriptorDigest: _expectedDescriptorDigest,
      ...safe
    } = connection;
    return { ...safe, usesCredentialRef: Boolean(connection.credentialRef) };
  }

  private assertGitConnectionInput(input: GitProjectConnectionInput): void {
    if (!STABLE_ID.test(input.id)) throw new ExternalProjectError("The connection ID is not stable.");
    if (input.projectId && !STABLE_ID.test(input.projectId)) throw new ExternalProjectError("The project ID is not stable.");
    if (input.provider !== "git") throw new ExternalProjectError("The requested provider is not supported.");
    if (!SAFE_REF.test(input.requestedRef) || input.requestedRef.includes("..") || input.requestedRef.includes("@{")) {
      throw new ExternalProjectError("The Git branch, tag, or reference is not safe.");
    }
    if (input.credentialRef && !/^secret:\/\/[a-z0-9][a-z0-9/._-]*$/.test(input.credentialRef)) {
      throw new ExternalProjectError("credentialRef must be an opaque secret:// reference.");
    }
    this.assertRepositoryUrl(input.repositoryUrl);
    const sshRemote = /^git@[^:]+:[^\s]+$/.test(input.repositoryUrl) ||
      (() => {
        try { return new URL(input.repositoryUrl).protocol === "ssh:"; } catch (_error) { return false; }
      })();
    if (sshRemote && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(input.sshHostKeyFingerprint || "")) {
      throw new ExternalProjectError("SSH Git connections require sshHostKeyFingerprint.");
    }
  }

  private assertUploadConnectionInput(input: FolderUploadConnectionInput): void {
    if (!STABLE_ID.test(input.id)) throw new ExternalProjectError("The connection ID is not stable.");
    if (input.projectId && !STABLE_ID.test(input.projectId)) throw new ExternalProjectError("The project ID is not stable.");
    if (!this.options.folderUploadEnabled || !this.options.uploadStore) {
      throw new ExternalProjectError("Folder uploads are not enabled in this environment.");
    }
    if (!/^[0-9a-f-]{36}$/i.test(input.uploadId)) throw new ExternalProjectError("uploadId must be a valid uploaded snapshot reference.");
  }

  private assertRepositoryUrl(value: string): void {
    if (path.isAbsolute(value)) throw new ExternalProjectError("repositoryUrl must be a remote HTTPS or SSH URL.");
    if (/^git@[^:]+:[^\s]+$/.test(value)) return;
    let parsed: URL;
    try { parsed = new URL(value); } catch (_error) { throw new ExternalProjectError("repositoryUrl must be HTTPS, SSH, or an authorized local path."); }
    if (!["https:", "ssh:"].includes(parsed.protocol)) throw new ExternalProjectError("Only HTTPS or SSH repositories are allowed.");
    if (parsed.username || parsed.password) throw new ExternalProjectError("Do not include credentials in repositoryUrl; use credentialRef.");
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new ExternalProjectError("A loopback Git host cannot be used as a remote.");
  }

  private prepareCheckout(
    repositoryUrl: string,
    checkoutPath: string,
    authentication: {
      environment: NodeJS.ProcessEnv;
      gitPrefixArguments: string[];
    }
  ): void {
    try {
      if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
        fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
        execFileSync(
          "git",
          [...authentication.gitPrefixArguments, "clone", "--no-checkout", "--origin", "origin", "--", repositoryUrl, checkoutPath],
          { env: authentication.environment, stdio: "pipe", timeout: 60000, windowsHide: true }
        );
      } else {
        const origin = execFileSync("git", ["-C", checkoutPath, "config", "--get", "remote.origin.url"], { encoding: "utf8", windowsHide: true }).trim();
        if (origin !== repositoryUrl) throw new ExternalProjectError("The managed checkout does not match the requested repository.");
        execFileSync(
          "git",
          [...authentication.gitPrefixArguments, "-C", checkoutPath, "fetch", "--force", "--tags", "origin"],
          { env: authentication.environment, stdio: "pipe", timeout: 60000, windowsHide: true }
        );
      }
    } catch (error) {
      if (error instanceof ExternalProjectError) throw error;
      throw new ExternalProjectError("The Git repository could not be cloned or refreshed with the configured authentication.");
    }
  }

  private resolveCommit(checkoutPath: string, requestedRef: string): string {
    const candidates = [requestedRef, `refs/remotes/origin/${requestedRef}`, `refs/tags/${requestedRef}`];
    for (const candidate of candidates) {
      try {
        return execFileSync("git", ["-C", checkoutPath, "rev-parse", "--verify", `${candidate}^{commit}`], { encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
      } catch (_error) { /* Try the next explicit form. */ }
    }
    throw new ExternalProjectError(`Could not resolve '${requestedRef}' to a Git commit.`);
  }

  private gitShow(checkoutPath: string, commit: string, relativePath: string, maxBuffer: number): Buffer {
    safePath(relativePath, "The artifact path");
    try {
      return execFileSync("git", ["-C", checkoutPath, "show", `${commit}:${relativePath}`], { encoding: "buffer", maxBuffer, timeout: 20000, windowsHide: true }) as Buffer;
    } catch (_error) {
      throw new ExternalProjectError(`'${relativePath}' does not exist in commit '${commit}'.`);
    }
  }

  /** Holds a temporary upload lease for a source-consuming operation. Legacy paths are never read. */
  private acquireConnectionSource(
    connection: ExternalProjectConnection,
    projectId?: string,
    actorId?: string,
  ): { root: string; release: () => void } {
    if (connection.provider === "upload") {
      try {
        const lease = this.options.uploadStore?.acquire(connection.uploadId, projectId || connection.projectId || "", actorId);
        if (!lease) throw new ExternalProjectError("Folder uploads are not enabled in this environment.");
        return { root: lease.upload.root, release: lease.release };
      } catch (error) {
        if (error instanceof TemporaryUploadError) throw new ExternalProjectError(error.message, error.statusCode, error.code, error.requiresReupload);
        throw error;
      }
    }
    if (connection.provider === "local") {
      throw new ExternalProjectError("This legacy local connection is unsupported. Upload the project folder again.", 410, "SPL_SOURCE_EXPIRED", true);
    }
    // A remote checkout only exists for this operation. Credentialed sources are
    // prepared by validation; imports still fail closed if Git cannot read them.
    const workspace = this.createTemporaryGitWorkspace();
    try {
      this.prepareCheckout(connection.repositoryUrl, workspace, { environment: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, gitPrefixArguments: [] });
      const resolved = this.resolveCommit(workspace, connection.resolvedCommit);
      if (resolved !== connection.resolvedCommit) throw new ExternalProjectError("The remote Git commit no longer matches the validated connection.");
      return { root: workspace, release: () => fs.rmSync(workspace, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(workspace, { recursive: true, force: true });
      if (error instanceof ExternalProjectError) throw error;
      throw new ExternalProjectError("The remote Git source could not be read for this operation.");
    }
  }

  private connectionRoots(connection: ExternalProjectConnection, projectId?: string, actorId?: string) {
    if (connection.provider === "upload") {
      const lease = this.acquireConnectionSource(connection, projectId, actorId);
      // The caller performs synchronous derivation; release immediately after returning would race only with an external sweeper.
      // A scheduled sweep cannot run during this synchronous section, and expiry is fixed.
      lease.release();
      return { gitRepositories: {}, localRoots: { [connection.sourceLocation]: lease.root } };
    }
    if (connection.provider === "local") return { gitRepositories: {}, localRoots: {} };
    const lease = this.acquireConnectionSource(connection, projectId, actorId);
    // Derivation builders run synchronously in the same request stack. Defer
    // deletion until that stack has consumed the provider path.
    setImmediate(() => lease.release());
    return { gitRepositories: { [connection.repositoryUrl]: lease.root }, localRoots: {} };
  }

  private readLocalFile(rootPath: string, relativePath: string, maxBytes: number): Buffer {
    const safeRelativePath = safePath(relativePath, "The local path");
    const resolvedRoot = fs.realpathSync(rootPath);
    const candidate = path.resolve(resolvedRoot, safeRelativePath);
    if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new ExternalProjectError(`Path '${relativePath}' attempts to leave the authorized folder.`);
    }
    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync(candidate);
    } catch (_error) {
      throw new ExternalProjectError(`'${relativePath}' does not exist in the local folder.`);
    }
    if (!realCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new ExternalProjectError(`Path '${relativePath}' resolves outside the authorized folder.`);
    }
    const stats = fs.statSync(realCandidate);
    if (!stats.isFile()) throw new ExternalProjectError(`'${relativePath}' is not a regular file.`);
    if (stats.size > maxBytes) throw new ExternalProjectError(`'${relativePath}' exceeds the ${maxBytes}-byte limit.`);
    return fs.readFileSync(realCandidate);
  }

  public restoreUpload(connectionId: string, projectId: string, uploadId: string, actorId: string) {
    const connection = this.requireConnection(connectionId, projectId);
    if (connection.provider !== "upload") throw new ExternalProjectError("Only uploaded-folder connections can be restored.", 409);
    let upload;
    try { upload = this.options.uploadStore?.get(uploadId, projectId, actorId); }
    catch (error) {
      if (error instanceof TemporaryUploadError) throw new ExternalProjectError(error.message, error.statusCode, error.code, error.requiresReupload);
      throw error;
    }
    if (!upload) throw new ExternalProjectError("The upload does not exist.", 404);
    if (upload.snapshotDigest !== connection.snapshotDigest || upload.descriptorDigest !== connection.descriptorDigest) {
      throw new ExternalProjectError("The uploaded folder differs from this immutable catalog. Import it as a new revision instead.", 409);
    }
    connection.uploadId = uploadId;
    connection.sourceExpiresAt = upload.expiresAt;
    this.connections.set(this.connectionKey(connection.id, projectId), connection);
    this.writeJson(path.join(this.connectionDirectory(), this.connectionFileName(connection)), connection);
    return this.publicConnection(connection);
  }

  public describeUpload(uploadId: string, projectId: string, actorId: string) {
    try { return this.publicUpload(this.options.uploadStore?.get(uploadId, projectId, actorId)); }
    catch (error) {
      if (error instanceof TemporaryUploadError) throw new ExternalProjectError(error.message, error.statusCode, error.code, error.requiresReupload);
      throw error;
    }
  }

  private publicUpload(upload: { uploadId: string; snapshotDigest: string; descriptorDigest: string; fileCount: number; totalBytes: number; createdAt: string; expiresAt: string } | undefined) {
    if (!upload) throw new ExternalProjectError("The upload does not exist.", 404);
    const { uploadId, snapshotDigest, descriptorDigest, fileCount, totalBytes, createdAt, expiresAt } = upload;
    return { uploadId, snapshotDigest, descriptorDigest, fileCount, totalBytes, createdAt, expiresAt };
  }

  private compatibleTargets(
    profile: VariamosProjectProfile,
    artifacts: VariamosProjectDescriptor["artifacts"],
    requested?: string,
    ownerUserId?: string
  ): ExternalProjectTarget[] {
    const requiredCapabilities = new Set([
      ...profile.requiredTargetCapabilities,
      ...artifacts.flatMap((artifact) => artifact.requiresCapabilities || []),
    ]);
    const targetAdapters = BUILDER_TARGET_ADAPTERS.get(profile.builderAdapter);
    return this.options.targets(ownerUserId).filter((item) =>
      (!requested || item.ref === requested) &&
      Boolean(targetAdapters) &&
      Boolean(targetAdapters?.has(item.target.adapter)) &&
      [...requiredCapabilities].every((capability) => item.target.capabilities.includes(capability))
    );
  }

  private artifactAdapter(profile: VariamosProjectProfile, kind: string): string {
    if (profile.builderAdapter === "static-site-v1" && kind === "html-fragment") return "static-fragment-v1";
    if (profile.builderAdapter === "node-modular-monolith-v1") return "node-module-v1";
    throw new ExternalProjectError(`Builder '${profile.builderAdapter}' does not support '${kind}' artifacts.`);
  }

  private requireConnection(id: string, projectId?: string): ExternalProjectConnection {
    const connection = projectId
      ? this.connections.get(this.connectionKey(id, projectId))
      : this.connections.get(id) ||
        [...this.connections.values()].find((item) => item.id === id && !item.projectId);
    if (!connection) throw new ExternalProjectError(`Connection '${id}' does not exist.`);
    if (
      projectId &&
      connection.projectId &&
      connection.projectId !== projectId
    ) {
      throw new ExternalProjectError("The connection belongs to another project.");
    }
    return connection;
  }

  private connectionDirectory() { return path.join(this.options.stateDirectory, "connections"); }
  private importDirectory() { return path.join(this.options.stateDirectory, "imports"); }
  private createTemporaryGitWorkspace() {
    const directory = path.join(this.options.stateDirectory, "temporary-git", `${process.pid}-${crypto.randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private loadState(): void {
    for (const fileName of fs.readdirSync(this.connectionDirectory()).filter((item) => item.endsWith(".json"))) {
      const value = JSON.parse(fs.readFileSync(path.join(this.connectionDirectory(), fileName), "utf8")) as ExternalProjectConnection;
      this.connections.set(this.connectionKey(value.id, value.projectId), value);
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

  private connectionKey(id: string, projectId?: string): string {
    return projectId ? `${projectId}:${id}` : id;
  }

  private connectionFileName(connection: ExternalProjectConnection): string {
    return connection.projectId
      ? `${connection.projectId}--${connection.id}.json`
      : `${connection.id}.json`;
  }
}
