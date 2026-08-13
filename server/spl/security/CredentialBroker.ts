import crypto from "crypto";
import { execFileSync } from "child_process";
import { SecureStateRepository } from "./AtomicStateStore";
import { SafeAuditLogger } from "./SafeAuditLogger";
import {
  AuthenticatedProjectActor,
  CredentialBinding,
  CredentialBindingSubject,
  CredentialPayload,
  CredentialProviderId,
  CredentialPurpose,
  CredentialType,
  PublicCredentialBinding,
} from "./SecureTypes";

export interface SecretDescription {
  versionIdsToStages: Record<string, string[]>;
  tags: Record<string, string>;
}

export interface SecretValue {
  versionId: string;
  secretString: string;
}

export interface CredentialProvider {
  readonly id: CredentialProviderId;
  describeSecret(secretId: string): Promise<SecretDescription>;
  getSecretValue(secretId: string, options: {
    versionId?: string;
    versionStage?: "AWSCURRENT";
  }): Promise<SecretValue>;
}

export class CredentialProviderRegistry {
  private readonly providers = new Map<CredentialProviderId, CredentialProvider>();

  constructor(providers: CredentialProvider[]) {
    providers.forEach((provider) => {
      if (this.providers.has(provider.id)) throw new Error(`Credential provider '${provider.id}' is duplicated.`);
      this.providers.set(provider.id, provider);
    });
  }

  public require(id: CredentialProviderId): CredentialProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new CredentialBrokerError("The configured credential provider is unavailable.");
    return provider;
  }
}

export interface AwsSecretsManagerProviderOptions {
  region: string;
  client?: {
    send(command: unknown): Promise<Record<string, unknown>>;
  };
}

export class AwsSecretsManagerCredentialProvider implements CredentialProvider {
  public readonly id = "aws-secrets-manager" as const;
  private readonly client: { send(command: unknown): Promise<Record<string, unknown>> };
  private readonly DescribeSecretCommand: new (input: unknown) => unknown;
  private readonly GetSecretValueCommand: new (input: unknown) => unknown;

  constructor(options: AwsSecretsManagerProviderOptions) {
    if (!options.region) throw new Error("SPL_AWS_REGION is required for AWS Secrets Manager.");
    // Dynamic loading keeps AWS SDK types outside the TypeScript 4.2 surface
    // while still using the official runtime SDK and its default IAM chain.
    const sdk = require("@aws-sdk/client-secrets-manager") as {
      SecretsManagerClient: new (input: unknown) => { send(command: unknown): Promise<Record<string, unknown>> };
      DescribeSecretCommand: new (input: unknown) => unknown;
      GetSecretValueCommand: new (input: unknown) => unknown;
    };
    this.client = options.client || new sdk.SecretsManagerClient({ region: options.region });
    this.DescribeSecretCommand = sdk.DescribeSecretCommand;
    this.GetSecretValueCommand = sdk.GetSecretValueCommand;
  }

  public async describeSecret(secretId: string): Promise<SecretDescription> {
    const response = await this.client.send(new this.DescribeSecretCommand({ SecretId: secretId }));
    const tags = Object.fromEntries(
      (Array.isArray(response.Tags) ? response.Tags : [])
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .filter((item) => typeof item.Key === "string" && typeof item.Value === "string")
        .map((item) => [item.Key as string, item.Value as string])
    );
    const stages = response.VersionIdsToStages && typeof response.VersionIdsToStages === "object"
      ? response.VersionIdsToStages as Record<string, string[]>
      : {};
    return { tags, versionIdsToStages: stages };
  }

  public async getSecretValue(
    secretId: string,
    options: { versionId?: string; versionStage?: "AWSCURRENT" }
  ): Promise<SecretValue> {
    const response = await this.client.send(new this.GetSecretValueCommand({
      SecretId: secretId,
      ...(options.versionId ? { VersionId: options.versionId } : {}),
      ...(options.versionStage ? { VersionStage: options.versionStage } : {}),
    }));
    const versionId = response.VersionId;
    if (typeof versionId !== "string" || !versionId) {
      throw new CredentialBrokerError("The secret provider did not identify the returned version.");
    }
    if (typeof response.SecretString !== "string") {
      throw new CredentialBrokerError("Binary secrets are not supported for SPL credentials.");
    }
    return { versionId, secretString: response.SecretString };
  }
}

export interface MacOsKeychainProviderOptions {
  service?: string;
  platform?: NodeJS.Platform;
  readSecret?: (account: string, service: string) => string;
}

interface ParsedKeychainReference {
  account: string;
  projectId: string;
  purpose: CredentialPurpose;
  credentialType: CredentialType;
}

const KEYCHAIN_REFERENCE_HOST = "variamos-spl-local";
const SUPPORTED_CREDENTIAL_TYPES: CredentialType[] = [
  "git-https-token-v1",
  "git-ssh-key-v1",
  "ssh-deployment-v1",
];

/**
 * Local-only credential provider used to exercise the complete remote
 * deployment flow on a developer Mac without copying private keys into
 * VariaMos or requiring an AWS account.
 */
export class MacOsKeychainCredentialProvider implements CredentialProvider {
  public readonly id = "macos-keychain" as const;
  private readonly service: string;
  private readonly readSecret: (account: string, service: string) => string;

  constructor(options: MacOsKeychainProviderOptions = {}) {
    if ((options.platform || process.platform) !== "darwin") {
      throw new Error("The macOS Keychain credential provider is available only on macOS.");
    }
    this.service = options.service || KEYCHAIN_REFERENCE_HOST;
    if (this.service !== KEYCHAIN_REFERENCE_HOST) {
      throw new Error("The macOS Keychain service name is fixed for local SPL tests.");
    }
    this.readSecret = options.readSecret || ((account, service) =>
      execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        {
          encoding: "utf8",
          // macOS can display its first-access approval sheet before returning.
          // The browser request still has a stricter 30-second upper bound.
          timeout: 15000,
          maxBuffer: 256 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }
      )
    );
  }

  public async describeSecret(secretId: string): Promise<SecretDescription> {
    const parsed = this.parseReference(secretId);
    const secretString = this.obtain(parsed.account);
    const versionId = this.versionId(secretString);
    return {
      tags: {
        "variamos:projectId": parsed.projectId,
        "variamos:purpose": parsed.purpose,
        "variamos:credentialType": parsed.credentialType,
      },
      versionIdsToStages: { [versionId]: ["AWSCURRENT"] },
    };
  }

  public async getSecretValue(
    secretId: string,
    options: { versionId?: string; versionStage?: "AWSCURRENT" }
  ): Promise<SecretValue> {
    const parsed = this.parseReference(secretId);
    const secretString = this.obtain(parsed.account);
    const versionId = this.versionId(secretString);
    if (options.versionId && options.versionId !== versionId) {
      throw new CredentialBrokerError("The requested credential version is no longer current.");
    }
    return { versionId, secretString };
  }

  private parseReference(secretId: string): ParsedKeychainReference {
    let reference: URL;
    try {
      reference = new URL(secretId);
    } catch (_error) {
      throw new CredentialBrokerError("The macOS Keychain reference is invalid.");
    }
    const segments = reference.pathname.split("/").filter(Boolean);
    const [projectId, purpose, credentialType, alias] = segments;
    if (
      reference.protocol !== "keychain:" ||
      reference.hostname !== KEYCHAIN_REFERENCE_HOST ||
      reference.username ||
      reference.password ||
      reference.search ||
      reference.hash ||
      segments.length !== 4 ||
      !projectId ||
      !STABLE_ID.test(projectId) ||
      (purpose !== "source-read" && purpose !== "deployment") ||
      !SUPPORTED_CREDENTIAL_TYPES.includes(credentialType as CredentialType) ||
      !alias ||
      !STABLE_ID.test(alias)
    ) {
      throw new CredentialBrokerError("The macOS Keychain reference is invalid.");
    }
    return {
      account: `${projectId}:${purpose}:${credentialType}:${alias}`,
      projectId,
      purpose,
      credentialType: credentialType as CredentialType,
    };
  }

  private obtain(account: string): string {
    try {
      const storedSecret = this.readSecret(account, this.service).trim();
      const encoded = storedSecret.startsWith("base64:")
        ? storedSecret.slice("base64:".length)
        : "";
      if (
        encoded &&
        (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
      ) {
        throw new Error("invalid base64");
      }
      const secret = encoded
        ? Buffer.from(encoded, "base64").toString("utf8")
        : storedSecret;
      if (!secret || Buffer.byteLength(secret, "utf8") > 256 * 1024) {
        throw new Error("invalid secret size");
      }
      return secret;
    } catch (_error) {
      throw new CredentialBrokerError("The referenced macOS Keychain item is unavailable.");
    }
  }

  private versionId(secretString: string): string {
    return `sha256:${crypto.createHash("sha256").update(secretString).digest("hex")}`;
  }
}

export class CredentialBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialBrokerError";
    Object.setPrototypeOf(this, CredentialBrokerError.prototype);
  }
}

export interface CredentialRegistrationInput {
  id: string;
  alias: string;
  purpose: CredentialPurpose;
  credentialType: CredentialType;
  externalSecretId: string;
  subject: CredentialBindingSubject;
}

export interface CredentialValidationInput {
  purpose: CredentialPurpose;
  credentialType: CredentialType;
  externalSecretId: string;
}

export interface CredentialLease {
  binding: PublicCredentialBinding;
  versionId: string;
  payload: CredentialPayload;
  dispose(): void;
}

export interface CredentialBrokerOptions {
  repository: SecureStateRepository;
  providers: CredentialProviderRegistry;
  audit: SafeAuditLogger;
  defaultProviderId?: CredentialProviderId;
  /** Test/migration seam. Runtime target deployment accepts passwords only. */
  allowDeploymentCredentials?: boolean;
  tagKeys?: {
    projectId: string;
    purpose: string;
    credentialType: string;
  };
}

const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const PRIVATE_KEY_PATTERN = /^-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----[\s\S]+-----END (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----\s*$/;

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function requiredString(value: unknown, label: string, minLength: number, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    value.length > maxLength ||
    !SAFE_TEXT.test(value)
  ) {
    throw new CredentialBrokerError(`The secret field '${label}' is invalid.`);
  }
  return value;
}

function privateKeyString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 64 ||
    value.length > 65536 ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new CredentialBrokerError("The secret field 'privateKey' is invalid.");
  }
  return value;
}

export function validateCredentialPayload(
  raw: string,
  credentialType: CredentialType
): CredentialPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (_error) {
    throw new CredentialBrokerError("The credential secret must contain a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialBrokerError("The credential secret must contain a JSON object.");
  }
  const object = value as Record<string, unknown>;
  if (credentialType === "git-https-token-v1") {
    if (!exactKeys(object, ["schemaVersion", "username", "token"])) {
      throw new CredentialBrokerError("The Git HTTPS secret contains missing or additional fields.");
    }
    if (object.schemaVersion !== "git-https-token/v1") {
      throw new CredentialBrokerError("The Git HTTPS secret uses an incompatible schemaVersion.");
    }
    return {
      schemaVersion: "git-https-token/v1",
      username: requiredString(object.username, "username", 1, 256),
      token: requiredString(object.token, "token", 8, 16384),
    };
  }
  const expectedSchema = credentialType === "git-ssh-key-v1"
    ? "git-ssh-key/v1"
    : "ssh-deployment/v1";
  if (!exactKeys(object, ["schemaVersion", "username", "privateKey"], ["passphrase"])) {
    throw new CredentialBrokerError("The SSH secret contains missing or additional fields.");
  }
  if (object.schemaVersion !== expectedSchema) {
    throw new CredentialBrokerError("The SSH secret uses an incompatible schemaVersion.");
  }
  const privateKey = privateKeyString(object.privateKey);
  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new CredentialBrokerError("The SSH private key is not in a supported PEM or OpenSSH format.");
  }
  const passphrase = object.passphrase === undefined
    ? undefined
    : requiredString(object.passphrase, "passphrase", 1, 4096);
  if (credentialType === "git-ssh-key-v1") {
    return {
      schemaVersion: "git-ssh-key/v1",
      username: requiredString(object.username, "username", 1, 256),
      privateKey,
      ...(passphrase ? { passphrase } : {}),
    };
  }
  return {
    schemaVersion: "ssh-deployment/v1",
    username: requiredString(object.username, "username", 1, 256),
    privateKey,
    ...(passphrase ? { passphrase } : {}),
  };
}

export class CredentialBroker {
  private readonly tagKeys: { projectId: string; purpose: string; credentialType: string };
  private readonly defaultProviderId: CredentialProviderId;

  constructor(private readonly options: CredentialBrokerOptions) {
    this.defaultProviderId = options.defaultProviderId || "aws-secrets-manager";
    this.tagKeys = options.tagKeys || {
      projectId: "variamos:projectId",
      purpose: "variamos:purpose",
      credentialType: "variamos:credentialType",
    };
  }

  public list(projectId: string): PublicCredentialBinding[] {
    return this.options.repository.listBindings(projectId)
      .filter((item) => item.purpose === "source-read")
      .map((item) => this.publicBinding(item));
  }

  public get(projectId: string, id: string): PublicCredentialBinding {
    return this.publicBinding(this.requireBinding(projectId, id));
  }

  public async validateReference(
    projectId: string,
    input: CredentialValidationInput
  ): Promise<{ valid: true; versionId: string; credentialType: CredentialType }> {
    this.assertValidationInput(input);
    const provider = this.options.providers.require(this.defaultProviderId);
    try {
      const description = await provider.describeSecret(input.externalSecretId);
      this.assertTags(description.tags, projectId, input.purpose, input.credentialType);
      const secret = await provider.getSecretValue(input.externalSecretId, { versionStage: "AWSCURRENT" });
      if (!(description.versionIdsToStages[secret.versionId] || []).includes("AWSCURRENT")) {
        throw new CredentialBrokerError("The provider did not return the AWSCURRENT version.");
      }
      const payload = validateCredentialPayload(secret.secretString, input.credentialType);
      this.options.audit.redactor.registerPayload(payload);
      this.clearPayload(payload);
      return { valid: true, versionId: secret.versionId, credentialType: input.credentialType };
    } catch (error) {
      if (error instanceof CredentialBrokerError) throw error;
      throw new CredentialBrokerError("The credential provider could not validate the referenced secret.");
    }
  }

  public async register(
    actor: AuthenticatedProjectActor,
    input: CredentialRegistrationInput
  ): Promise<PublicCredentialBinding> {
    if (!STABLE_ID.test(input.id)) throw new CredentialBrokerError("The credential binding ID is invalid.");
    if (!input.alias || input.alias.length > 160 || !SAFE_TEXT.test(input.alias)) {
      throw new CredentialBrokerError("The credential alias is invalid.");
    }
    if (
      !input.subject ||
      !STABLE_ID.test(input.subject.id) ||
      (input.purpose === "deployment" && input.subject.kind !== "deployment-target") ||
      (input.purpose === "source-read" && input.subject.kind !== "source-connection")
    ) {
      throw new CredentialBrokerError("The credential binding must identify its deployment target or source connection.");
    }
    if (this.options.repository.getBinding(actor.projectId, input.id)) {
      throw new CredentialBrokerError("A credential binding with that ID already exists.");
    }
    const validated = await this.validateReference(actor.projectId, input);
    const now = new Date().toISOString();
    const binding: CredentialBinding = {
      schemaVersion: "credential-binding/v1",
      id: input.id,
      ref: `secret://projects/${actor.projectId}/${input.id}`,
      projectId: actor.projectId,
      alias: input.alias,
      provider: this.defaultProviderId,
      purpose: input.purpose,
      credentialType: input.credentialType,
      externalSecretId: input.externalSecretId,
      subject: input.subject,
      activeVersionId: validated.versionId,
      status: "active",
      createdAt: now,
      createdBy: actor.userId,
      validatedAt: now,
      validatedBy: actor.userId,
    };
    this.options.repository.putBinding(binding);
    this.options.audit.record({
      event: "credential.registered",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      credentialAlias: binding.alias,
      credentialVersionId: binding.activeVersionId,
      details: { purpose: binding.purpose, credentialType: binding.credentialType },
    });
    return this.publicBinding(binding);
  }

  public async validateCurrent(
    actor: AuthenticatedProjectActor,
    id: string,
    probe?: (lease: CredentialLease) => Promise<void>
  ): Promise<PublicCredentialBinding> {
    const binding = this.requireBinding(actor.projectId, id);
    if (binding.status === "revoked") throw new CredentialBrokerError("The credential binding is revoked.");
    const provider = this.options.providers.require(binding.provider);
    const description = await provider.describeSecret(binding.externalSecretId);
    this.assertTags(description.tags, binding.projectId, binding.purpose, binding.credentialType);
    const secret = await provider.getSecretValue(binding.externalSecretId, { versionStage: "AWSCURRENT" });
    if (!(description.versionIdsToStages[secret.versionId] || []).includes("AWSCURRENT")) {
      throw new CredentialBrokerError("The provider did not return the AWSCURRENT version.");
    }
    const payload = validateCredentialPayload(secret.secretString, binding.credentialType);
    this.options.audit.redactor.registerPayload(payload);
    const lease = this.createLease(binding, secret.versionId, payload);
    try {
      if (probe) await probe(lease);
    } finally {
      lease.dispose();
    }
    const now = new Date().toISOString();
    const rotated = secret.versionId !== binding.activeVersionId;
    const updated: CredentialBinding = {
      ...binding,
      activeVersionId: secret.versionId,
      status: "active",
      validatedAt: now,
      validatedBy: actor.userId,
      ...(rotated ? { rotatedAt: now, rotatedBy: actor.userId } : {}),
    };
    this.options.repository.putBinding(updated);
    this.options.audit.record({
      event: rotated ? "credential.rotated" : "credential.validated",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      credentialAlias: binding.alias,
      credentialVersionId: secret.versionId,
    });
    return this.publicBinding(updated);
  }

  public async resolve(
    projectId: string,
    ref: string,
    expectedPurpose: CredentialPurpose,
    acceptedTypes: CredentialType[],
    auditContext: { actorId: string; targetRef?: string; executionId?: string }
  ): Promise<CredentialLease> {
    const binding = this.options.repository.findBindingByRef(projectId, ref);
    if (!binding || binding.status !== "active" || !binding.activeVersionId) {
      throw new CredentialBrokerError("The credential binding is missing, inactive, or revoked.");
    }
    if (binding.purpose !== expectedPurpose || !acceptedTypes.includes(binding.credentialType)) {
      throw new CredentialBrokerError("The credential binding is not compatible with this operation.");
    }
    const provider = this.options.providers.require(binding.provider);
    try {
      const description = await provider.describeSecret(binding.externalSecretId);
      this.assertTags(description.tags, binding.projectId, binding.purpose, binding.credentialType);
      const secret = await provider.getSecretValue(binding.externalSecretId, {
        versionId: binding.activeVersionId,
      });
      if (secret.versionId !== binding.activeVersionId) {
        throw new CredentialBrokerError("The provider returned a different secret version than the active binding.");
      }
      const payload = validateCredentialPayload(secret.secretString, binding.credentialType);
      this.options.audit.redactor.registerPayload(payload);
      this.options.audit.record({
        event: "credential.version-used",
        result: "succeeded",
        actorId: auditContext.actorId,
        projectId,
        targetRef: auditContext.targetRef,
        executionId: auditContext.executionId,
        credentialAlias: binding.alias,
        credentialVersionId: binding.activeVersionId,
      });
      return this.createLease(binding, secret.versionId, payload);
    } catch (error) {
      if (error instanceof CredentialBrokerError) throw error;
      throw new CredentialBrokerError("The active credential version could not be obtained.");
    }
  }

  public revoke(actor: AuthenticatedProjectActor, id: string): PublicCredentialBinding {
    const binding = this.requireBinding(actor.projectId, id);
    if (binding.status === "revoked") return this.publicBinding(binding);
    const now = new Date().toISOString();
    const revoked: CredentialBinding = {
      ...binding,
      status: "revoked",
      revokedAt: now,
      revokedBy: actor.userId,
    };
    this.options.repository.putBinding(revoked);
    this.options.audit.record({
      event: "credential.revoked",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      credentialAlias: binding.alias,
      credentialVersionId: binding.activeVersionId,
      details: { externalActionPending: true },
    });
    return this.publicBinding(revoked);
  }

  public confirmExternalRevocation(
    actor: AuthenticatedProjectActor,
    id: string
  ): PublicCredentialBinding {
    const binding = this.requireBinding(actor.projectId, id);
    if (binding.status !== "revoked") {
      throw new CredentialBrokerError("The binding must be revoked before confirming external removal.");
    }
    const now = new Date().toISOString();
    const updated: CredentialBinding = {
      ...binding,
      externalRevocationConfirmedAt: now,
      externalRevocationConfirmedBy: actor.userId,
    };
    this.options.repository.putBinding(updated);
    this.options.audit.record({
      event: "credential.external-revocation-confirmed",
      result: "succeeded",
      actorId: actor.userId,
      projectId: actor.projectId,
      credentialAlias: binding.alias,
      credentialVersionId: binding.activeVersionId,
    });
    return this.publicBinding(updated);
  }

  private requireBinding(projectId: string, id: string): CredentialBinding {
    const binding = this.options.repository.getBinding(projectId, id);
    if (!binding) throw new CredentialBrokerError("The credential binding does not exist.");
    return binding;
  }

  private assertValidationInput(input: CredentialValidationInput): void {
    if (!["source-read", "deployment"].includes(input.purpose)) {
      throw new CredentialBrokerError("The credential purpose is invalid.");
    }
    if (!["git-https-token-v1", "git-ssh-key-v1", "ssh-deployment-v1"].includes(input.credentialType)) {
      throw new CredentialBrokerError("The credential type is invalid.");
    }
    if (input.purpose === "deployment" && this.options.allowDeploymentCredentials !== true) {
      throw new CredentialBrokerError(
        "Managed deployment credentials are not supported. SSH targets use a username and a password entered for each attempt."
      );
    }
    if (
      !input.externalSecretId ||
      input.externalSecretId.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(input.externalSecretId)
    ) {
      throw new CredentialBrokerError("The credential secret identifier is invalid.");
    }
    if (input.purpose === "source-read" && input.credentialType === "ssh-deployment-v1") {
      throw new CredentialBrokerError("A deployment SSH key cannot authenticate a source repository.");
    }
    if (input.purpose === "deployment" && input.credentialType !== "ssh-deployment-v1") {
      throw new CredentialBrokerError("The SSH/Compose target requires an ssh-deployment-v1 credential.");
    }
  }

  private assertTags(
    tags: Record<string, string>,
    projectId: string,
    purpose: CredentialPurpose,
    credentialType: CredentialType
  ): void {
    const expected: Record<string, string> = {
      [this.tagKeys.projectId]: projectId,
      [this.tagKeys.purpose]: purpose,
      [this.tagKeys.credentialType]: credentialType,
    };
    const invalid = Object.entries(expected).some(([key, value]) => tags[key] !== value);
    if (invalid) throw new CredentialBrokerError("The credential metadata tags do not match this project, purpose, and credential type.");
  }

  private publicBinding(binding: CredentialBinding): PublicCredentialBinding {
    const { externalSecretId: _externalSecretId, ...safe } = binding;
    return safe;
  }

  private createLease(
    binding: CredentialBinding,
    versionId: string,
    payload: CredentialPayload
  ): CredentialLease {
    let disposed = false;
    return {
      binding: this.publicBinding(binding),
      versionId,
      payload,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.clearPayload(payload);
      },
    };
  }

  private clearPayload(payload: CredentialPayload): void {
    const mutable = payload as unknown as Record<string, string | undefined>;
    if (mutable.token) mutable.token = crypto.randomBytes(16).toString("hex");
    if (mutable.privateKey) mutable.privateKey = crypto.randomBytes(16).toString("hex");
    if (mutable.passphrase) mutable.passphrase = crypto.randomBytes(16).toString("hex");
    if (mutable.username) mutable.username = "";
  }
}
