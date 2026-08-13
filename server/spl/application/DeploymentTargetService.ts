import path from "path";
import {
  DeploymentTargetAdapterRegistry,
} from "../adapters/deployers/DeploymentTargetAdapter";
import { DeploymentTarget } from "../contracts";
import { SecureStateRepository } from "../security/AtomicStateStore";
import {
  createEphemeralSshCredential,
  EphemeralSshCredentialError,
} from "../security/EphemeralSshCredential";
import { HostPolicy } from "../security/HostPolicy";
import { SafeAuditLogger } from "../security/SafeAuditLogger";
import {
  AuthenticatedProjectActor,
  DeploymentTargetConnection,
  PublicDeploymentTarget,
  EphemeralSshCredentialInput,
} from "../security/SecureTypes";

export class DeploymentTargetServiceError extends Error {
  constructor(message: string, public readonly statusCode = 422) {
    super(message);
    this.name = "DeploymentTargetServiceError";
    Object.setPrototypeOf(this, DeploymentTargetServiceError.prototype);
  }
}

export interface DeploymentTargetInput {
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

export interface DeploymentTargetServiceOptions {
  repository: SecureStateRepository;
  adapters: DeploymentTargetAdapterRegistry;
  sshHosts: HostPolicy;
  healthHosts: HostPolicy;
  audit: SafeAuditLogger;
  remoteEnabled: boolean;
}

const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const HOST = /^[A-Za-z0-9.-]+$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const DIGEST_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
// Spaces are valid in operator-owned directories and remain safe because every
// shell use is single-quoted by the deployer. Shell metacharacters stay blocked.
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/ -]+$/;
const SAFE_USERNAME = /^[^\u0000-\u001f\u007f]{1,256}$/;
const ACTIVE_DEPLOYMENT_STATUSES = new Set([
  "queued",
  "authorizing",
  "resolving-credential",
  "connecting",
  "uploading",
  "deploying",
  "verifying",
]);

export class DeploymentTargetService {
  constructor(private readonly options: DeploymentTargetServiceOptions) {}

  public adapterDefinitions() {
    return this.options.adapters.definitions(this.options.remoteEnabled);
  }

  public list(ownerUserId: string): PublicDeploymentTarget[] {
    return this.options.repository.listTargets(ownerUserId)
      .filter((target) => target.authentication?.mode === "prompt-password" || target.authentication?.mode === "prompt-pem")
      .map((target) => this.publicTarget(target))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public get(ownerUserId: string, id: string): DeploymentTargetConnection {
    const target = this.options.repository.getTarget(ownerUserId, id);
    if (!target) throw new DeploymentTargetServiceError("The deployment target does not exist.", 404);
    if ((target.authentication?.mode !== "prompt-password" && target.authentication?.mode !== "prompt-pem") || target.deploymentCredentialRef) {
      throw new DeploymentTargetServiceError(
        "This historical managed-key target is no longer supported. Register it again with an SSH password or PEM key."
      );
    }
    return target;
  }

  public public(ownerUserId: string, id: string): PublicDeploymentTarget {
    return this.publicTarget(this.get(ownerUserId, id));
  }

  public async validate(
    actor: AuthenticatedProjectActor,
    input: DeploymentTargetInput,
    existing?: DeploymentTargetConnection,
    ephemeralCredential?: EphemeralSshCredentialInput
  ): Promise<{ valid: true; target: PublicDeploymentTarget }> {
    this.assertRemoteEnabled();
    this.assertInput(input);
    await Promise.all([
      this.options.sshHosts.authorize(input.endpoint.host),
      this.options.healthHosts.authorize(new URL(input.publicBaseUrl).hostname),
    ]);
    const now = new Date().toISOString();
    const images = {
      ...(input.images.nginx?.trim() ? { nginx: input.images.nginx.trim() } : {}),
      ...(input.images.node?.trim() ? { node: input.images.node.trim() } : {}),
    };
    const candidate: DeploymentTargetConnection = {
      schemaVersion: "deployment-target-connection/v1",
      ...input,
      images,
      authentication: {
        mode: input.authentication.mode,
        username: input.authentication.username,
      },
      ownerUserId: existing?.ownerUserId || actor.userId,
      status: "active",
      revision: existing ? existing.revision + 1 : 1,
      createdAt: existing?.createdAt || now,
      createdBy: existing?.createdBy || actor.userId,
      updatedAt: now,
      updatedBy: actor.userId,
      validatedAt: now,
      validatedBy: actor.userId,
    };
    let credential;
    try {
      credential = createEphemeralSshCredential(ephemeralCredential, this.options.audit);
    } catch (error) {
      if (error instanceof EphemeralSshCredentialError) {
        throw new DeploymentTargetServiceError(error.message);
      }
      throw error;
    }
    if (
      credential.payload.username !== candidate.authentication?.username
    ) {
      credential.dispose();
      throw new DeploymentTargetServiceError("The supplied SSH username does not match this target.");
    }
    const expectedSchema = candidate.authentication.mode === "prompt-pem" ? "ssh-pem/v1" : "ssh-password/v1";
    if (credential.payload.schemaVersion !== expectedSchema) {
      credential.dispose();
      throw new DeploymentTargetServiceError("The supplied SSH credential does not match this target.");
    }
    try {
      await this.options.adapters.require(candidate.adapter).validate({
        target: candidate,
        credential,
      });
    } finally {
      credential.dispose();
    }
    return { valid: true, target: this.publicTarget(candidate) };
  }

  public async create(
    actor: AuthenticatedProjectActor,
    input: DeploymentTargetInput,
    ephemeralCredential?: EphemeralSshCredentialInput
  ): Promise<PublicDeploymentTarget> {
    if (this.options.repository.getTarget(actor.userId, input.id)) {
      throw new DeploymentTargetServiceError("A target with that ID already exists.");
    }
    const validated = await this.validate(actor, input, undefined, ephemeralCredential);
    const target = this.targetFromPublic(validated.target, input.remoteBasePath, actor.userId);
    this.options.repository.putTarget(target);
    this.options.audit.record({
      event: "target.created",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      targetRef: target.id,
      details: {
        adapter: target.adapter,
        authenticationMode: target.authentication.mode,
        environment: target.environment,
        revision: target.revision,
      },
    });
    return this.publicTarget(target);
  }

  public async update(
    actor: AuthenticatedProjectActor,
    id: string,
    patch: Partial<Omit<DeploymentTargetInput, "id" | "adapter">>,
    ephemeralCredential?: EphemeralSshCredentialInput
  ): Promise<PublicDeploymentTarget> {
    const existing = this.get(actor.userId, id);
    if (existing.status === "disabled") {
      throw new DeploymentTargetServiceError("A disabled target cannot be changed.");
    }
    const input: DeploymentTargetInput = {
      id: existing.id,
      name: patch.name === undefined ? existing.name : patch.name,
      environment: patch.environment === undefined ? existing.environment : patch.environment,
      adapter: existing.adapter,
      endpoint: patch.endpoint === undefined ? existing.endpoint : patch.endpoint,
      remoteBasePath: patch.remoteBasePath === undefined ? existing.remoteBasePath : patch.remoteBasePath,
      publishedPort: patch.publishedPort === undefined ? existing.publishedPort : patch.publishedPort,
      publicBaseUrl: patch.publicBaseUrl === undefined ? existing.publicBaseUrl : patch.publicBaseUrl,
      images: patch.images === undefined ? existing.images : patch.images,
      capabilities: patch.capabilities === undefined ? existing.capabilities : patch.capabilities,
      authentication: patch.authentication === undefined ? existing.authentication : patch.authentication,
    };
    const validated = await this.validate(actor, input, existing, ephemeralCredential);
    const target = this.targetFromPublic(validated.target, input.remoteBasePath, existing.ownerUserId);
    this.options.repository.putTarget(target);
    this.options.audit.record({
      event: "target.changed",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      targetRef: target.id,
      details: { revision: target.revision },
    });
    return this.publicTarget(target);
  }

  public remove(actor: AuthenticatedProjectActor, id: string): { deleted: true; targetRef: string } {
    const target = this.options.repository.getTarget(actor.userId, id);
    if (!target) throw new DeploymentTargetServiceError("The deployment target does not exist.", 404);
    const activeDeployment = this.options.repository.allDeployments()
      .find((deployment) =>
        deployment.targetRef === id && deployment.targetOwnerUserId === actor.userId && ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status)
      );
    if (activeDeployment) {
      throw new DeploymentTargetServiceError(
        "This target cannot be deleted while a deployment is active. Cancel or finish the deployment first."
      );
    }
    if (!this.options.repository.removeTarget(actor.userId, id)) {
      throw new DeploymentTargetServiceError("The deployment target does not exist.", 404);
    }
    this.options.audit.record({
      event: "target.deleted",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      targetRef: target.id,
      details: {
        adapter: target.adapter,
        previousStatus: target.status,
        revision: target.revision,
      },
    });
    return { deleted: true, targetRef: target.id };
  }

  public asResolverTarget(target: DeploymentTargetConnection): DeploymentTarget {
    return {
      schemaVersion: "deployment-target/v1",
      id: target.id,
      adapter: target.adapter,
      capabilities: target.capabilities,
    };
  }

  private assertInput(input: DeploymentTargetInput): void {
    if (!STABLE_ID.test(input.id)) throw new DeploymentTargetServiceError("The target ID is invalid.");
    if (!input.name || input.name.length > 160 || /[\u0000-\u001f\u007f]/.test(input.name)) {
      throw new DeploymentTargetServiceError("The target name is invalid.");
    }
    if (
      input.environment !== undefined &&
      !["development", "staging", "production"].includes(input.environment)
    ) {
      throw new DeploymentTargetServiceError("The target environment is invalid.");
    }
    if (input.adapter !== "ssh-compose-v1") {
      throw new DeploymentTargetServiceError("Only ssh-compose-v1 is currently supported for remote targets.");
    }
    if (
      !input.endpoint ||
      !HOST.test(input.endpoint.host) ||
      !Number.isInteger(input.endpoint.port) ||
      input.endpoint.port < 1 ||
      input.endpoint.port > 65535 ||
      !FINGERPRINT.test(input.endpoint.sshHostKeyFingerprint)
    ) {
      throw new DeploymentTargetServiceError("The SSH endpoint or host key fingerprint is invalid.");
    }
    if (
      !SAFE_REMOTE_PATH.test(input.remoteBasePath) ||
      input.remoteBasePath === "/" ||
      path.posix.normalize(input.remoteBasePath) !== input.remoteBasePath ||
      input.remoteBasePath.split("/").includes("..")
    ) {
      throw new DeploymentTargetServiceError("The remote base path must be an absolute restricted directory.");
    }
    if (!Number.isInteger(input.publishedPort) || input.publishedPort < 1024 || input.publishedPort > 65535) {
      throw new DeploymentTargetServiceError("The published port must be between 1024 and 65535.");
    }
    let publicUrl: URL;
    try {
      publicUrl = new URL(input.publicBaseUrl);
    } catch (_error) {
      throw new DeploymentTargetServiceError("The public verification URL is invalid.");
    }
    if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.hash) {
      throw new DeploymentTargetServiceError("The public verification URL must be HTTP(S) and contain no credentials or fragment.");
    }
    if (
      !Array.isArray(input.capabilities) ||
      !input.capabilities.length ||
      new Set(input.capabilities).size !== input.capabilities.length ||
      input.capabilities.some((item) => !CAPABILITY.test(item))
    ) {
      throw new DeploymentTargetServiceError("Target capabilities must be unique stable identifiers.");
    }
    const supported = new Set(this.options.adapters.require(input.adapter).definition.capabilities);
    if (input.capabilities.some((item) => !supported.has(item))) {
      throw new DeploymentTargetServiceError("The target declares a capability not supported by its adapter.");
    }
    const needsNginx = input.capabilities.includes("static-http");
    const needsNode = input.capabilities.includes("node-runtime") || input.capabilities.includes("http-api");
    const nginxImage = input.images?.nginx || undefined;
    const nodeImage = input.images?.node || undefined;
    if (!needsNginx && !needsNode) {
      throw new DeploymentTargetServiceError("The target must support a static HTTP or Node runtime.");
    }
    if (
      (needsNginx && !nginxImage) ||
      (nginxImage !== undefined && !DIGEST_IMAGE.test(nginxImage))
    ) {
      throw new DeploymentTargetServiceError("The Nginx image is required for static HTTP and must be pinned by sha256 digest.");
    }
    if (
      (needsNode && !nodeImage) ||
      (nodeImage !== undefined && !DIGEST_IMAGE.test(nodeImage))
    ) {
      throw new DeploymentTargetServiceError("The Node image is required for a Node runtime and must be pinned by sha256 digest.");
    }
    const raw = input as DeploymentTargetInput & { deploymentCredentialRef?: unknown };
    if (
      !input.authentication ||
      (input.authentication.mode !== "prompt-password" && input.authentication.mode !== "prompt-pem") ||
      !input.authentication.username ||
      !SAFE_USERNAME.test(input.authentication.username) ||
      Object.keys(input.authentication).some((key) => !["mode", "username"].includes(key)) ||
      raw.deploymentCredentialRef !== undefined
    ) {
      throw new DeploymentTargetServiceError("SSH targets require a valid username and an ephemeral password or PEM key for each attempt.");
    }
  }

  private assertRemoteEnabled(): void {
    if (!this.options.remoteEnabled) {
      throw new DeploymentTargetServiceError("Remote deployment is disabled by the operator.");
    }
  }

  private publicTarget(target: DeploymentTargetConnection): PublicDeploymentTarget {
    const {
      deploymentCredentialRef: _deploymentCredentialRef,
      remoteBasePath: _remoteBasePath,
      ownerUserId: _ownerUserId,
      ...safe
    } = target;
    return { ...safe, scope: "personal" };
  }

  private targetFromPublic(
    target: PublicDeploymentTarget,
    remoteBasePath: string,
    ownerUserId: string
  ): DeploymentTargetConnection {
    const { scope: _scope, ...privateTarget } = target;
    return { ...privateTarget, ownerUserId, remoteBasePath };
  }
}
