import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { SplHttpServerConfig } from "./spl/SplHttpServer";

export interface UnifiedServerConfig {
  host: string;
  port: number;
  workspaceRoot: string;
  buildDirectory: string;
  spl: SplHttpServerConfig;
}

type Environment = Record<string, string | undefined>;

function boolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Configuration booleans must be either true or false.");
}

function list(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Configuration value must be one of: ${allowed.join(", ")}.`);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_error) { /* best effort */ }
}

/** The only module that loads .env and reads process environment variables. */
export function loadUnifiedServerConfig(options: {
  workspaceRoot?: string;
  environment?: Environment;
} = {}): UnifiedServerConfig {
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  if (!options.environment) dotenv.config({ path: path.join(workspaceRoot, ".env") });
  const environment = options.environment || process.env;
  if (environment.SPL_AUTH_MODE && environment.SPL_AUTH_MODE !== "variamos") {
    throw new Error("SPL_AUTH_MODE=disabled is not supported; VariaMos authentication is required.");
  }
  const gateway = (environment.VARIAMOS_PUBLIC_GATEWAY || "https://app.variamos.com").replace(/\/$/, "");
  const nodeEnvironment = environment.NODE_ENV || "development";
  const portText = environment.PORT || "3000";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  const host = environment.HOST || "127.0.0.1";
  const stateRoot = path.resolve(workspaceRoot, environment.SPL_STATE_ROOT || ".runtime/spl");
  privateDirectory(stateRoot);
  const auditSink = enumValue(environment.SPL_AUDIT_SINK, ["file", "stdout", "both"] as const, "file");
  const secretBackend = enumValue(environment.SPL_SECRET_BACKEND, ["aws", "macos-keychain", "none"] as const, "none");
  const allowedOrigins = list(environment.SPL_UI_ORIGINS);
  const publicOrigins = allowedOrigins.length ? allowedOrigins : [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  const remoteDeploymentEnabled = boolean(environment.SPL_REMOTE_DEPLOYMENT_ENABLED);
  const localTargetsEnabled = boolean(
    environment.SPL_LOCAL_TARGETS_ENABLED,
    (environment.NODE_ENV || "development") !== "production",
  );
  const folderUploadEnabled = boolean(environment.SPL_FOLDER_UPLOAD_ENABLED);
  const uploadTtlHours = positiveInteger(environment.SPL_UPLOAD_TTL_HOURS, 24, "SPL_UPLOAD_TTL_HOURS");
  const uploadMaxBytes = positiveInteger(environment.SPL_UPLOAD_MAX_BYTES, 104857600, "SPL_UPLOAD_MAX_BYTES");
  const uploadMaxFiles = positiveInteger(environment.SPL_UPLOAD_MAX_FILES, 500, "SPL_UPLOAD_MAX_FILES");
  const spl: SplHttpServerConfig = {
    gitRepositories: {},
    outputRoot: path.join(stateRoot, "projects", "products"),
    releaseStateDirectory: path.join(stateRoot, "projects", "releases"),
    externalProjectStateDirectory: path.join(stateRoot, "projects", "imports"),
    temporaryUploadDirectory: path.join(stateRoot, "temporary", "uploads"),
    secureStateDirectory: path.join(stateRoot, "secure"),
    auditFilePath: path.join(stateRoot, "audit", "spl-audit.jsonl"),
    allowedOrigins: publicOrigins,
    resourceRegistryPath: environment.SPL_RESOURCE_REGISTRY_PATH ||
      (nodeEnvironment === "production" ? undefined : path.join(workspaceRoot, "contracts/resource-registry.local.json")),
    localTargetsEnabled,
    projectDescriptorSchemaPath: path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
    folderUploadEnabled,
    uploadTtlMs: uploadTtlHours * 60 * 60 * 1000,
    uploadMaxBytes,
    uploadMaxFiles,
    remoteDeploymentEnabled,
    sessionInfoUrl: `${gateway}/variamos_ms_admin/auth/session-info`,
    projectInfoUrl: `${gateway}/vms_projects/getProject`,
    auditSink,
    secretBackend,
    localMacSshTestMode: boolean(environment.SPL_LOCAL_MAC_SSH_TEST_MODE),
    awsRegion: environment.SPL_AWS_REGION,
    gitHostAllowlist: list(environment.SPL_GIT_HOST_ALLOWLIST),
    sshHostAllowlist: list(environment.SPL_SSH_HOST_ALLOWLIST),
    healthHostAllowlist: list(environment.SPL_HEALTH_HOST_ALLOWLIST),
    runtimePlatform: process.platform,
    nodeEnvironment,
  };
  return { host, port, workspaceRoot, buildDirectory: path.join(workspaceRoot, "build"), spl };
}

export function publicGatewayForBuild(environment: Environment = process.env): string {
  return (environment.VARIAMOS_PUBLIC_GATEWAY || "https://app.variamos.com").replace(/\/$/, "");
}
