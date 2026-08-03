import Ajv2020, { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { ArtifactCatalog, DeploymentTarget } from "../contracts";
import {
  ExternalProjectConnection,
  ExternalProjectConnectionInput,
  GitProjectConnection,
  GitProjectConnectionInput,
  LocalDirectoryConnection,
  LocalDirectoryConnectionInput,
  VariamosProjectDescriptor,
  VariamosProjectProfile,
} from "../domain/ProjectDescriptor";

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
const BUILDER_TARGET_ADAPTERS = new Map<string, string>([
  ["static-site-v1", "nginx-container-v1"],
  ["node-modular-monolith-v1", "node-container-v1"],
]);
const ALLOWED_BUILDERS = new Set(BUILDER_ARTIFACT_KINDS.keys());
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
    provider: "git" | "local";
    requestedRef?: string;
    resolvedCommit?: string;
    snapshotDigest?: string;
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
  allowLocalDirectories?: boolean;
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
    fs.mkdirSync(this.checkoutDirectory(), { recursive: true });
    this.loadState();
  }

  public providerIndex() {
    return [
      {
        id: "git-remote",
        provider: "git",
        name: "Remote Git repository",
        availability: "available",
        descriptorPath: ".variamos/spl.json",
        supportsCredentialRef: true,
        help: "Connects an HTTPS or SSH URL and pins the branch, tag, or commit before planning.",
        plannedFields: ["repositoryUrl", "requestedRef", "descriptorPath", "credentialRef"],
      },
      {
        id: "git-local",
        provider: "git",
        name: "Local Git repository",
        availability: this.options.allowLocalGitRepositories ? "available" : "configuration-required",
        descriptorPath: ".variamos/spl.json",
        supportsCredentialRef: false,
        help: this.options.allowLocalGitRepositories
          ? "Connects an absolute Git path accessible to the orchestrator process."
          : "Requires the operator to enable SPL_ALLOW_LOCAL_GIT_REPOSITORIES=true.",
        plannedFields: ["repositoryPath", "requestedRef", "descriptorPath"],
      },
      {
        id: "local-directory",
        provider: "local",
        name: "Local folder without Git",
        availability: this.options.allowLocalDirectories ? "available" : "configuration-required",
        descriptorPath: ".variamos/spl.json",
        supportsCredentialRef: false,
        help: this.options.allowLocalDirectories
          ? "Connects an authorized local folder and creates an immutable content snapshot."
          : "Requires the operator to enable SPL_ALLOW_LOCAL_DIRECTORIES=true.",
        plannedFields: ["authorizedRoot", "descriptorPath", "snapshotPolicy"],
      },
    ];
  }

  public validateDescriptor(value: unknown, requireReady = false): { valid: boolean; errors: string[] } {
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
      if (ALLOWED_BUILDERS.has(profile.builderAdapter) && !this.compatibleTargets(profile, selectedArtifacts).length) {
        errors.push(`Profile '${profile.id}' does not match any target authorized for its builder and capabilities.`);
      }
    });
    descriptor.artifacts.forEach((artifact) => (artifact.dependsOn || []).forEach((id) => {
      if (!artifactIds.has(id)) errors.push(`Artifact '${artifact.id}' depends on missing artifact '${id}'.`);
      if (id === artifact.id) errors.push(`Artifact '${artifact.id}' cannot depend on itself.`);
    }));
    if (requireReady && descriptor.status !== "ready") errors.push("The descriptor must be ready before it can be imported.");
    return { valid: errors.length === 0, errors };
  }

  public validateConnection(input: ExternalProjectConnectionInput, persist = false) {
    if (input.provider === "local") return this.validateLocalConnection(input, persist);
    return this.validateGitConnection(input, persist);
  }

  private validateGitConnection(input: GitProjectConnectionInput, persist: boolean) {
    this.assertGitConnectionInput(input);
    if (persist && (!input.expectedResolvedCommit || !input.expectedDescriptorDigest)) {
      throw new ExternalProjectError(
        "Saving a connection requires the commit and digest returned by the preview; validate it again before saving."
      );
    }
    const descriptorPath = safePath(input.descriptorPath || ".variamos/spl.json", "descriptorPath");
    const checkoutPath = path.join(this.checkoutDirectory(), input.id);
    this.prepareCheckout(input.repositoryUrl, checkoutPath);
    const resolvedCommit = this.resolveCommit(checkoutPath, input.requestedRef);
    const descriptorContent = this.gitShow(checkoutPath, resolvedCommit, descriptorPath, 1024 * 1024);
    let descriptor: VariamosProjectDescriptor;
    try {
      descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    } catch (_error) {
      throw new ExternalProjectError("The project descriptor does not contain valid JSON.");
    }
    const validation = this.validateDescriptor(descriptor, true);
    if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
    const connection: GitProjectConnection = {
      ...input,
      descriptorPath,
      resolvedCommit,
      checkoutPath,
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
      this.connections.set(connection.id, connection);
      this.writeJson(path.join(this.connectionDirectory(), `${connection.id}.json`), connection);
    }
    return { connection: this.publicConnection(connection), descriptor, validation };
  }

  private validateLocalConnection(input: LocalDirectoryConnectionInput, persist: boolean) {
    this.assertLocalConnectionInput(input);
    if (persist && (!input.expectedSnapshotDigest || !input.expectedDescriptorDigest)) {
      throw new ExternalProjectError(
        "Saving a local folder requires the snapshot and digest returned by the preview; validate it again before saving."
      );
    }
    const rootPath = fs.realpathSync(input.rootPath);
    const descriptorPath = safePath(input.descriptorPath || ".variamos/spl.json", "descriptorPath");
    const descriptorContent = this.readLocalFile(rootPath, descriptorPath, 1024 * 1024);
    let descriptor: VariamosProjectDescriptor;
    try {
      descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    } catch (_error) {
      throw new ExternalProjectError("The project descriptor does not contain valid JSON.");
    }
    const validation = this.validateDescriptor(descriptor, true);
    if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
    const snapshotFiles = [
      { relativePath: descriptorPath, content: descriptorContent },
      ...descriptor.artifacts
        .map((artifact) => ({
          relativePath: safePath(artifact.source.path, `Path for artifact '${artifact.id}'`),
          content: this.readLocalFile(rootPath, artifact.source.path, 5 * 1024 * 1024),
        }))
        .filter((item, index, items) =>
          items.findIndex((candidate) => candidate.relativePath === item.relativePath) === index
        ),
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const snapshotDigest = this.snapshotDigest(snapshotFiles);
    const descriptorDigest = digest(descriptorContent);
    if (input.expectedSnapshotDigest && input.expectedSnapshotDigest !== snapshotDigest) {
      throw new ExternalProjectError("The local folder changed after the preview; validate it again before saving.");
    }
    if (input.expectedDescriptorDigest && input.expectedDescriptorDigest !== descriptorDigest) {
      throw new ExternalProjectError("The descriptor changed after the preview; validate it again before saving.");
    }
    const snapshotPath = path.join(this.snapshotDirectory(), input.id, snapshotDigest.replace("sha256:", ""));
    if (persist) this.persistSnapshot(snapshotPath, snapshotFiles);
    const connection: LocalDirectoryConnection = {
      ...input,
      rootPath,
      descriptorPath,
      snapshotPolicy: "content-digest-v1",
      sourceLocation: `external.local.${input.id}`,
      snapshotDigest,
      snapshotPath,
      descriptorDigest,
      validatedAt: new Date().toISOString(),
    };
    if (persist) {
      this.connections.set(connection.id, connection);
      this.writeJson(path.join(this.connectionDirectory(), `${connection.id}.json`), connection);
    }
    return { connection: this.publicConnection(connection), descriptor, validation };
  }

  public getConnection(id: string) {
    const connection = this.connections.get(id);
    if (!connection) throw new ExternalProjectError(`Connection '${id}' does not exist.`);
    return this.publicConnection(connection);
  }

  public validateStoredDescriptor(connectionId: string) {
    const connection = this.requireConnection(connectionId);
    const content = this.readConnectionFile(connection, connection.descriptorPath, 1024 * 1024);
    const descriptor = JSON.parse(content.toString("utf8"));
    return {
      ...this.validateDescriptor(descriptor, true),
      descriptorDigest: digest(content),
      ...(connection.provider === "git"
        ? { resolvedCommit: connection.resolvedCommit }
        : { snapshotDigest: connection.snapshotDigest }),
    };
  }

  public importProject(connectionId: string, profileId: string, targetRef?: string): ImportedExternalProfile {
    const connection = this.requireConnection(connectionId);
    const descriptorContent = this.readConnectionFile(connection, connection.descriptorPath, 1024 * 1024);
    const descriptor = JSON.parse(descriptorContent.toString("utf8")) as VariamosProjectDescriptor;
    const validation = this.validateDescriptor(descriptor, true);
    if (!validation.valid) throw new ExternalProjectError(`Invalid descriptor: ${validation.errors.join(" | ")}`);
    if (digest(descriptorContent) !== connection.descriptorDigest) {
      throw new ExternalProjectError("The descriptor differs from the validated connection; validate the connection again.");
    }
    const descriptorProfile = descriptor.profiles.find((item) => item.id === profileId);
    if (!descriptorProfile) throw new ExternalProjectError(`The descriptor does not contain profile '${profileId}'.`);
    const allowedIds = new Set(descriptorProfile.artifactIds || descriptor.artifacts.map((artifact) => artifact.id));
    const selectedArtifacts = descriptor.artifacts.filter((artifact) => allowedIds.has(artifact.id));
    if (selectedArtifacts.length !== allowedIds.size) throw new ExternalProjectError("The profile contains incomplete artifact references.");
    const target = this.selectTarget(descriptorProfile, selectedArtifacts, targetRef);
    const revision = connection.provider === "git" ? connection.resolvedCommit : connection.snapshotDigest;
    const catalogRef = `external.catalog.${shortDigest(`${connection.id}:${revision}:${profileId}`)}`;
    const catalog: ArtifactCatalog = {
      schemaVersion: "artifact-catalog/v1",
      id: catalogRef,
      version: "1.0.0",
      derivation: { builderAdapter: descriptorProfile.builderAdapter, ...(descriptorProfile.testAdapter ? { testAdapter: descriptorProfile.testAdapter } : {}) },
      artifacts: selectedArtifacts.map((artifact) => {
        const content = this.readConnectionFile(connection, artifact.source.path, 5 * 1024 * 1024);
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
            : { provider: "local", location: connection.sourceLocation, path: artifact.source.path },
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
        provider: connection.provider,
        ...(connection.provider === "git"
          ? { requestedRef: connection.requestedRef, resolvedCommit: connection.resolvedCommit }
          : { snapshotDigest: connection.snapshotDigest }),
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
    if (!item) throw new ExternalProjectError(`Import '${id}' does not exist.`);
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
    if (!target) throw new ExternalProjectError(`Imported target '${targetRef}' is no longer authorized.`);
    return {
      catalog: imported.catalog,
      target: target.target,
      targetEntry: { port: target.port, releaseState: target.releaseState, ...(target.dataState ? { dataState: target.dataState } : {}) },
      gitRepositories: connection.provider === "git"
        ? { [connection.repositoryUrl]: connection.checkoutPath }
        : {},
      localRoots: connection.provider === "local"
        ? { [connection.sourceLocation]: connection.snapshotPath }
        : {},
    };
  }

  private publicConnection(connection: ExternalProjectConnection) {
    if (connection.provider === "local") {
      const {
        snapshotPath: _snapshotPath,
        expectedSnapshotDigest: _expectedSnapshotDigest,
        expectedDescriptorDigest: _expectedDescriptorDigest,
        ...safe
      } = connection;
      return { ...safe, usesCredentialRef: false };
    }
    const {
      checkoutPath: _checkoutPath,
      credentialRef: _credentialRef,
      expectedResolvedCommit: _expectedResolvedCommit,
      expectedDescriptorDigest: _expectedDescriptorDigest,
      ...safe
    } = connection;
    return { ...safe, usesCredentialRef: Boolean(connection.credentialRef) };
  }

  private assertGitConnectionInput(input: GitProjectConnectionInput): void {
    if (!STABLE_ID.test(input.id)) throw new ExternalProjectError("The connection ID is not stable.");
    if (input.provider !== "git") throw new ExternalProjectError("The requested provider is not supported.");
    if (!SAFE_REF.test(input.requestedRef) || input.requestedRef.includes("..") || input.requestedRef.includes("@{")) {
      throw new ExternalProjectError("The Git branch, tag, or reference is not safe.");
    }
    if (input.credentialRef && !/^secret:\/\/[a-z0-9][a-z0-9/_-]*$/.test(input.credentialRef)) {
      throw new ExternalProjectError("credentialRef must be an opaque secret:// reference.");
    }
    this.assertRepositoryUrl(input.repositoryUrl);
  }

  private assertLocalConnectionInput(input: LocalDirectoryConnectionInput): void {
    if (!STABLE_ID.test(input.id)) throw new ExternalProjectError("The connection ID is not stable.");
    if (!this.options.allowLocalDirectories) {
      throw new ExternalProjectError("Local folders without Git are not enabled in this environment.");
    }
    if (!path.isAbsolute(input.rootPath)) {
      throw new ExternalProjectError("rootPath must be an authorized absolute path on the orchestrator host.");
    }
    if (input.snapshotPolicy && input.snapshotPolicy !== "content-digest-v1") {
      throw new ExternalProjectError("The requested snapshot policy is not supported.");
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(fs.realpathSync(input.rootPath));
    } catch (_error) {
      throw new ExternalProjectError("The selected local folder does not exist or is not accessible.");
    }
    if (!stats.isDirectory()) throw new ExternalProjectError("rootPath must point to a folder.");
  }

  private assertRepositoryUrl(value: string): void {
    const isLocal = path.isAbsolute(value);
    if (isLocal) {
      if (!this.options.allowLocalGitRepositories) throw new ExternalProjectError("Local Git paths are not enabled in this environment.");
      return;
    }
    if (/^git@[^:]+:[^\s]+$/.test(value)) return;
    let parsed: URL;
    try { parsed = new URL(value); } catch (_error) { throw new ExternalProjectError("repositoryUrl must be HTTPS, SSH, or an authorized local path."); }
    if (!["https:", "ssh:"].includes(parsed.protocol)) throw new ExternalProjectError("Only HTTPS or SSH repositories are allowed.");
    if (parsed.username || parsed.password) throw new ExternalProjectError("Do not include credentials in repositoryUrl; use credentialRef.");
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new ExternalProjectError("A loopback Git host cannot be used as a remote.");
  }

  private prepareCheckout(repositoryUrl: string, checkoutPath: string): void {
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
      fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
      execFileSync("git", ["clone", "--no-checkout", "--origin", "origin", "--", repositoryUrl, checkoutPath], { env: environment, stdio: "pipe", timeout: 60000, windowsHide: true });
    } else {
      const origin = execFileSync("git", ["-C", checkoutPath, "config", "--get", "remote.origin.url"], { encoding: "utf8", windowsHide: true }).trim();
      if (origin !== repositoryUrl) throw new ExternalProjectError("The managed checkout does not match the requested repository.");
      execFileSync("git", ["-C", checkoutPath, "fetch", "--force", "--tags", "origin"], { env: environment, stdio: "pipe", timeout: 60000, windowsHide: true });
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

  private readConnectionFile(
    connection: ExternalProjectConnection,
    relativePath: string,
    maxBytes: number
  ): Buffer {
    return connection.provider === "git"
      ? this.gitShow(connection.checkoutPath, connection.resolvedCommit, relativePath, maxBytes)
      : this.readLocalFile(connection.snapshotPath, relativePath, maxBytes);
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

  private snapshotDigest(files: Array<{ relativePath: string; content: Buffer }>): string {
    const hash = crypto.createHash("sha256");
    files.forEach((file) => {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(file.content);
      hash.update("\0");
    });
    return `sha256:${hash.digest("hex")}`;
  }

  private persistSnapshot(
    snapshotPath: string,
    files: Array<{ relativePath: string; content: Buffer }>
  ): void {
    if (fs.existsSync(snapshotPath)) return;
    const temporary = `${snapshotPath}.${process.pid}.tmp`;
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    files.forEach((file) => {
      const destination = path.join(temporary, file.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, file.content, { mode: 0o600 });
    });
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
    fs.renameSync(temporary, snapshotPath);
  }

  private compatibleTargets(
    profile: VariamosProjectProfile,
    artifacts: VariamosProjectDescriptor["artifacts"],
    requested?: string
  ): ExternalProjectTarget[] {
    const requiredCapabilities = new Set([
      ...profile.requiredTargetCapabilities,
      ...artifacts.flatMap((artifact) => artifact.requiresCapabilities || []),
    ]);
    const targetAdapter = BUILDER_TARGET_ADAPTERS.get(profile.builderAdapter);
    return this.options.targets().filter((item) =>
      (!requested || item.ref === requested) &&
      Boolean(targetAdapter) &&
      item.target.adapter === targetAdapter &&
      [...requiredCapabilities].every((capability) => item.target.capabilities.includes(capability))
    );
  }

  private selectTarget(
    profile: VariamosProjectProfile,
    artifacts: VariamosProjectDescriptor["artifacts"],
    requested?: string
  ): ExternalProjectTarget {
    const candidates = this.compatibleTargets(profile, artifacts, requested);
    if (candidates.length === 0) throw new ExternalProjectError("No authorized target is compatible with the descriptor profile.");
    return candidates.sort((left, right) => {
      const leftGeneric = left.ref.startsWith("variamos.") ? 0 : 1;
      const rightGeneric = right.ref.startsWith("variamos.") ? 0 : 1;
      return leftGeneric - rightGeneric || left.ref.localeCompare(right.ref);
    })[0];
  }

  private artifactAdapter(profile: VariamosProjectProfile, kind: string): string {
    if (profile.builderAdapter === "static-site-v1" && kind === "html-fragment") return "static-fragment-v1";
    if (profile.builderAdapter === "node-modular-monolith-v1") return "node-module-v1";
    throw new ExternalProjectError(`Builder '${profile.builderAdapter}' does not support '${kind}' artifacts.`);
  }

  private requireConnection(id: string): ExternalProjectConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new ExternalProjectError(`Connection '${id}' does not exist.`);
    return connection;
  }

  private connectionDirectory() { return path.join(this.options.stateDirectory, "connections"); }
  private importDirectory() { return path.join(this.options.stateDirectory, "imports"); }
  private checkoutDirectory() { return path.join(this.options.stateDirectory, "checkouts"); }
  private snapshotDirectory() { return path.join(this.options.stateDirectory, "snapshots"); }

  private loadState(): void {
    for (const fileName of fs.readdirSync(this.connectionDirectory()).filter((item) => item.endsWith(".json"))) {
      const value = JSON.parse(fs.readFileSync(path.join(this.connectionDirectory(), fileName), "utf8")) as ExternalProjectConnection;
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
