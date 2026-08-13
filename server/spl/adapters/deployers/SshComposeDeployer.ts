import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { HostPolicy } from "../../security/HostPolicy";
import {
  CredentialPayload,
  DeploymentTargetConnection,
  RemoteReleaseRecord,
  EphemeralSshCredentialPayload,
  SshPasswordPayload,
} from "../../security/SecureTypes";
import {
  DeploymentTargetAdapter,
  RemoteDeploymentContext,
  RemoteDeploymentError,
  RemoteDeploymentResult,
  TargetValidationContext,
} from "./DeploymentTargetAdapter";

interface SshSession {
  exec(command: string): Promise<string>;
  uploadDirectory(localDirectory: string, remoteDirectory: string): Promise<void>;
  writeFile(remotePath: string, content: string, mode: number): Promise<void>;
  end(): void;
}

interface SshConnectRequest {
  host: string;
  port: number;
  fingerprint: string;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

type SshConnector = (request: SshConnectRequest) => Promise<SshSession>;
type HealthVerifier = (
  target: DeploymentTargetConnection,
  url: string,
  manifestId: string,
  nodeRuntime: boolean,
  isCancellationRequested?: () => boolean
) => Promise<void>;

export interface SshComposeDeployerOptions {
  sshHosts: HostPolicy;
  healthHosts: HostPolicy;
  connector?: SshConnector;
  healthVerifier?: HealthVerifier;
  healthTimeoutMs?: number;
}

const MAX_UPLOAD_FILES = 5000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SSH_OUTPUT = 512 * 1024;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function stablePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

function releaseId(manifestId: string, outputDigest: string): string {
  return `release-${crypto.createHash("sha256").update(`${manifestId}:${outputDigest}`).digest("hex").slice(0, 16)}`;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/^SHA256:/, "").replace(/=+$/, "");
}

function assertDeploymentPayload(
  payload: CredentialPayload | EphemeralSshCredentialPayload
): asserts payload is EphemeralSshCredentialPayload {
  if (payload.schemaVersion !== "ssh-password/v1" && payload.schemaVersion !== "ssh-pem/v1") {
    throw new RemoteDeploymentError(
      "SSH deployment targets accept only a one-time password or PEM private key.",
      "CREDENTIAL_TYPE"
    );
  }
}

function authenticationRequest(
  target: DeploymentTargetConnection,
  connectAddress: string,
  payload: EphemeralSshCredentialPayload
): SshConnectRequest {
  const common = {
    host: connectAddress,
    port: target.endpoint.port,
    fingerprint: target.endpoint.sshHostKeyFingerprint,
    username: payload.username,
  };
  return payload.schemaVersion === "ssh-password/v1"
    ? { ...common, password: payload.password }
    : { ...common, privateKey: payload.privateKey, ...(payload.passphrase ? { passphrase: payload.passphrase } : {}) };
}

function safeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\n") &&
    !value.includes("\r") &&
    !value.split("/").includes("..")
  );
}

function collectFiles(root: string): Array<{ relativePath: string; absolutePath: string; digest: string; size: number }> {
  const resolvedRoot = fs.realpathSync(root);
  const files: Array<{ relativePath: string; absolutePath: string; digest: string; size: number }> = [];
  const visit = (directory: string): void => {
    fs.readdirSync(directory).sort().forEach((name) => {
      const absolutePath = path.join(directory, name);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new RemoteDeploymentError("Build outputs may not contain symbolic links.", "UNSAFE_BUILD_OUTPUT");
      }
      if (stats.isDirectory()) {
        visit(absolutePath);
        return;
      }
      if (!stats.isFile()) {
        throw new RemoteDeploymentError("Build outputs may contain only regular files.", "UNSAFE_BUILD_OUTPUT");
      }
      const relativePath = path.relative(resolvedRoot, absolutePath).split(path.sep).join("/");
      if (!safeRelativePath(relativePath)) {
        throw new RemoteDeploymentError("A build output path is not safe for remote transfer.", "UNSAFE_BUILD_OUTPUT");
      }
      files.push({
        relativePath,
        absolutePath,
        size: stats.size,
        digest: crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
      });
    });
  };
  visit(resolvedRoot);
  if (!files.length) throw new RemoteDeploymentError("The tested build output is empty.", "EMPTY_BUILD_OUTPUT");
  if (files.length > MAX_UPLOAD_FILES) throw new RemoteDeploymentError("The build output contains too many files.", "BUILD_OUTPUT_LIMIT");
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_UPLOAD_BYTES) throw new RemoteDeploymentError("The build output exceeds the remote upload limit.", "BUILD_OUTPUT_LIMIT");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function calculateDirectoryDigest(root: string): string {
  const lines = collectFiles(root)
    .map((file) => `${file.digest}  ./${file.relativePath}\n`)
    .join("");
  return `sha256:${crypto.createHash("sha256").update(lines).digest("hex")}`;
}

function composeYaml(context: RemoteDeploymentContext, remoteDirectory: string): string {
  const manifest = context.build.manifest;
  const isNode = context.build.builderAdapter === "node-modular-monolith-v1";
  const image = isNode ? context.target.images.node : context.target.images.nginx;
  if (!image) {
    throw new RemoteDeploymentError(
      `The target does not define the ${isNode ? "Node" : "Nginx"} image required by this build.`,
      "TARGET_RUNTIME_IMAGE_MISSING"
    );
  }
  const containerPort = isNode ? 3000 : 80;
  const volume = isNode
    ? `      - ${JSON.stringify(`${remoteDirectory}/dist:/app:ro`)}\n      - ${JSON.stringify(`${context.target.remoteBasePath}/data:/data`)}`
    : `      - ${JSON.stringify(`${remoteDirectory}/dist:/usr/share/nginx/html:ro`)}`;
  const command = isNode ? "\n    command: [\"node\", \"/app/dist/runtime/server.js\"]" : "";
  const environment = isNode
    ? `\n    environment:\n      SPL_MANIFEST_ID: ${JSON.stringify(manifest.manifestId)}\n      SPL_DATA_DIRECTORY: /data`
    : "";
  const tmpfs = isNode
    ? "      - /tmp"
    : "      - /tmp\n      - /var/cache/nginx\n      - /var/run";
  return [
    "services:",
    "  product:",
    `    image: ${JSON.stringify(image)}`,
    `    ports:\n      - ${JSON.stringify(`${context.target.publishedPort}:${containerPort}`)}`,
    `    volumes:\n${volume}`,
    `    labels:\n      variamos.spl.manifest-id: ${JSON.stringify(manifest.manifestId)}\n      variamos.spl.target-id: ${JSON.stringify(context.target.id)}`,
    "    read_only: true",
    `    tmpfs:\n${tmpfs}`,
    "    cap_drop:",
    "      - ALL",
    ...(isNode
      ? []
      : [
          "    cap_add:",
          "      - CHOWN",
          "      - DAC_OVERRIDE",
          "      - SETGID",
          "      - SETUID",
          "      - NET_BIND_SERVICE",
        ]),
    "    security_opt:",
    "      - no-new-privileges:true",
    "    restart: unless-stopped",
    `${environment}${command}`,
    "",
  ].join("\n");
}

function verificationUrl(context: RemoteDeploymentContext): { url: string; nodeRuntime: boolean } {
  const nodeRuntime = context.build.builderAdapter === "node-modular-monolith-v1";
  const pathValue = nodeRuntime
    ? context.build.manifest.verification.find((item) => item.type === "http-health-check")?.path || "/health"
    : "/";
  return { url: new URL(pathValue, context.target.publicBaseUrl).toString(), nodeRuntime };
}

class Ssh2Session implements SshSession {
  constructor(private readonly client: any) {}

  public exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error: Error | undefined, stream: any) => {
        if (error) return reject(error);
        let stdout = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          if (stdout.length < MAX_SSH_OUTPUT) stdout += chunk;
        });
        stream.stderr.resume();
        stream.on("close", (code: number | null) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`Remote command failed with exit code ${code}.`));
        });
        return undefined;
      });
    });
  }

  public async uploadDirectory(localDirectory: string, remoteDirectory: string): Promise<void> {
    const files = collectFiles(localDirectory);
    const directories = [...new Set(files.flatMap((file) => {
      const parts = file.relativePath.split("/").slice(0, -1);
      return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
    }))].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
    const sftp = await new Promise<any>((resolve, reject) => {
      this.client.sftp((error: Error | undefined, value: any) => error ? reject(error) : resolve(value));
    });
    const mkdir = (directory: string): Promise<void> => new Promise((resolve, reject) => {
      sftp.mkdir(directory, { mode: 0o700 }, (error: Error | undefined) => {
        if (!error) {
          resolve();
          return;
        }
        sftp.stat(directory, (statError: Error | undefined, stats: { isDirectory(): boolean }) => {
          if (!statError && stats?.isDirectory()) resolve();
          else reject(error);
        });
      });
    });
    const fastPut = (local: string, remote: string): Promise<void> => new Promise((resolve, reject) => {
      sftp.fastPut(local, remote, { mode: 0o600 }, (error: Error | undefined) => error ? reject(error) : resolve());
    });
    for (const directory of directories) await mkdir(`${remoteDirectory}/${directory}`);
    for (const file of files) await fastPut(file.absolutePath, `${remoteDirectory}/${file.relativePath}`);
  }

  public writeFile(remotePath: string, content: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error: Error | undefined, sftp: any) => {
        if (error) return reject(error);
        sftp.writeFile(remotePath, content, { encoding: "utf8", mode }, (writeError: Error | undefined) =>
          writeError ? reject(writeError) : resolve()
        );
        return undefined;
      });
    });
  }

  public end(): void {
    this.client.end();
  }
}

export class SshComposeDeployer implements DeploymentTargetAdapter {
  public readonly definition = {
    id: "ssh-compose-v1",
    name: "SSH server with Docker Compose",
    availability: "available" as const,
    credentialTypes: [],
    capabilities: [
      "docker",
      "docker-compose",
      "static-http",
      "node-runtime",
      "http-api",
      "single-container",
      "persistent-data",
    ],
    authenticationModes: [
      {
        id: "prompt-password" as const,
        name: "SSH username and password",
        description: "The owner enters the password when validating and on every deployment; VariaMos never stores it.",
        storesSecret: false,
        availability: "available" as const,
      },
      {
        id: "prompt-pem" as const,
        name: "SSH username and PEM private key",
        description: "The owner selects a PEM private key when validating and deploying; VariaMos never stores it.",
        storesSecret: false,
        availability: "available" as const,
      },
    ],
    // These are versioned adapter defaults, not environment variables. The UI
    // discovers them through GET /target-adapters and may still expose them as
    // advanced, editable values for an operator-managed upgrade.
    presets: [
      {
        id: "static-website",
        name: "Static website (Nginx)",
        description: "HTML, CSS and browser JavaScript served by Nginx.",
        builderAdapters: ["static-site-v1"],
        capabilities: ["docker", "docker-compose", "static-http", "single-container"],
        defaultPublishedPort: 8080,
        images: {
          nginx: "docker.io/library/nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10",
        },
      },
      {
        id: "node-application",
        name: "Node.js application",
        description: "A tested Node.js server with an HTTP health endpoint.",
        builderAdapters: ["node-modular-monolith-v1"],
        capabilities: ["docker", "docker-compose", "node-runtime", "http-api", "single-container", "persistent-data"],
        defaultPublishedPort: 8080,
        images: {
          node: "docker.io/library/node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd",
        },
      },
    ],
    configurationSchema: {
      type: "object",
      required: [
        "name",
        "endpoint",
        "remoteBasePath",
        "publishedPort",
        "publicBaseUrl",
        "images",
        "capabilities",
        "authentication",
      ],
      properties: {
        name: { type: "string", title: "Target name" },
        environment: {
          type: "string",
          title: "Usage classification",
          enum: ["development", "staging", "production"],
        },
        endpoint: {
          type: "object",
          required: ["host", "port", "sshHostKeyFingerprint"],
          properties: {
            host: { type: "string", title: "SSH host" },
            port: { type: "integer", default: 22 },
            sshHostKeyFingerprint: { type: "string", title: "SSH SHA-256 fingerprint" },
          },
        },
        remoteBasePath: { type: "string", title: "Authorized remote base path" },
        publishedPort: { type: "integer", minimum: 1024, maximum: 65535 },
        publicBaseUrl: { type: "string", format: "uri" },
        images: {
          type: "object",
          properties: {
            nginx: { type: "string", pattern: "@sha256:" },
            node: { type: "string", pattern: "@sha256:" },
          },
        },
        capabilities: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string" },
        },
        authentication: {
          type: "object",
          required: ["mode", "username"],
          properties: {
            mode: { type: "string", enum: ["prompt-password", "prompt-pem"] },
            username: { type: "string", title: "SSH username" },
          },
        },
      },
      allOf: [
        {
          if: { properties: { capabilities: { type: "array", contains: { const: "static-http" } } } },
          then: {
            properties: {
              images: { type: "object", required: ["nginx"], properties: { nginx: {} } },
            },
          },
        },
        {
          if: {
            properties: {
              capabilities: {
                type: "array",
                contains: { enum: ["node-runtime", "http-api"] },
              },
            },
          },
          then: {
            properties: {
              images: { type: "object", required: ["node"], properties: { node: {} } },
            },
          },
        },
      ],
    },
  };

  private readonly connector: SshConnector;
  private readonly healthVerifier: HealthVerifier;

  constructor(private readonly options: SshComposeDeployerOptions) {
    this.connector = options.connector || ((request) => this.connect(request));
    this.healthVerifier = options.healthVerifier || ((target, url, manifestId, nodeRuntime, isCancellationRequested) =>
      this.verifyHealth(target, url, manifestId, nodeRuntime, isCancellationRequested)
    );
  }

  public async validate(context: TargetValidationContext): Promise<void> {
    assertDeploymentPayload(context.credential.payload);
    const authorized = await this.options.sshHosts.authorize(context.target.endpoint.host);
    const session = await this.connector(authenticationRequest(
      context.target,
      authorized.connectAddress,
      context.credential.payload
    ));
    try {
      const base = quote(context.target.remoteBasePath);
      await this.runValidationCheck(
        session,
        `test "$(id -u)" -ne 0`,
        "The SSH deployment account cannot be root.",
        "SSH_ACCOUNT_ROOT"
      );
      await this.runValidationCheck(
        session,
        `test -d ${base}`,
        "The authorized deployment directory does not exist on the SSH server.",
        "REMOTE_DIRECTORY_MISSING"
      );
      await this.runValidationCheck(
        session,
        `test -w ${base}`,
        "The SSH deployment account cannot write to the authorized deployment directory.",
        "REMOTE_DIRECTORY_NOT_WRITABLE"
      );
      await this.runValidationCheck(
        session,
        "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then exit 1; fi",
        "The SSH deployment account must not have passwordless sudo access.",
        "SSH_PASSWORDLESS_SUDO"
      );
      await this.runValidationCheck(
        session,
        "command -v docker >/dev/null 2>&1",
        "Docker is not installed or is not available in the SSH session PATH.",
        "DOCKER_NOT_AVAILABLE"
      );
      await this.runValidationCheck(
        session,
        "docker version --format '{{.Server.Version}}' >/dev/null",
        "Docker is installed, but the SSH deployment account cannot access the Docker daemon.",
        "DOCKER_ACCESS_DENIED"
      );
      await this.runValidationCheck(
        session,
        "docker compose version --short >/dev/null",
        "The Docker Compose plugin is not available to the SSH deployment account.",
        "DOCKER_COMPOSE_NOT_AVAILABLE"
      );
    } finally {
      session.end();
    }
  }

  public async deploy(context: RemoteDeploymentContext): Promise<RemoteDeploymentResult> {
    assertDeploymentPayload(context.credential.payload);
    const expectedDigest = calculateDirectoryDigest(context.build.outputDirectory);
    if (expectedDigest !== context.build.outputDigest) {
      throw new RemoteDeploymentError("The build output changed after it was recorded.", "BUILD_OUTPUT_CHANGED");
    }
    const id = releaseId(context.build.manifest.manifestId, context.build.outputDigest);
    if (context.previousRelease?.manifestId === context.build.manifest.manifestId) {
      this.throwIfCancelled(context);
      const verification = verificationUrl(context);
      await this.healthVerifier(
        context.target,
        verification.url,
        context.build.manifest.manifestId,
        verification.nodeRuntime,
        context.isCancellationRequested
      );
      this.throwIfCancelled(context);
      return { release: context.previousRelease, publicUrl: verification.url, status: "already-active" };
    }
    const authorized = await this.options.sshHosts.authorize(context.target.endpoint.host);
    context.updateStage("connecting", "Connecting to the authorized SSH target.");
    const session = await this.connector(authenticationRequest(
      context.target,
      authorized.connectAddress,
      context.credential.payload
    ));
    const remoteDirectory = `${context.target.remoteBasePath}/releases/${id}`;
    const composeProject = `variamos-${stablePart(context.build.projectId)}-${stablePart(context.target.id)}-${id.slice(-8)}`;
    let candidateStarted = false;
    let previousStopped = false;
    try {
      this.throwIfCancelled(context);
      context.updateStage("uploading", "Uploading the immutable tested build.");
      await session.exec(`install -d -m 700 -- ${quote(remoteDirectory)} ${quote(`${remoteDirectory}/dist`)}`);
      await session.uploadDirectory(context.build.outputDirectory, `${remoteDirectory}/dist`);
      const remoteDigestOutput = await session.exec(
        `cd ${quote(`${remoteDirectory}/dist`)} && find . -type f -print0 | sort -z | xargs -0 sha256sum`
      );
      const remoteDigest = `sha256:${crypto.createHash("sha256").update(remoteDigestOutput).digest("hex")}`;
      if (remoteDigest !== context.build.outputDigest) {
        throw new RemoteDeploymentError("The uploaded files do not match the tested build.", "UPLOAD_DIGEST_MISMATCH");
      }
      await session.writeFile(`${remoteDirectory}/compose.yaml`, composeYaml(context, remoteDirectory), 0o600);
      this.throwIfCancelled(context);
      context.updateStage("deploying", "Starting the candidate release with a generated Compose definition.");
      if (context.previousRelease) {
        await session.exec(
          `cd ${quote(context.previousRelease.remoteDirectory)} && docker compose -p ${quote(context.previousRelease.composeProject)} -f compose.yaml stop`
        );
        previousStopped = true;
      }
      // A failed `compose up` may still have created containers, so cleanup
      // must consider the candidate started from the moment it is attempted.
      candidateStarted = true;
      await session.exec(
        `cd ${quote(remoteDirectory)} && docker compose -p ${quote(composeProject)} -f compose.yaml pull && docker compose -p ${quote(composeProject)} -f compose.yaml up -d --remove-orphans`
      );
      this.throwIfCancelled(context);
      context.updateStage("verifying", "Verifying the public health endpoint and manifest marker.");
      const verification = verificationUrl(context);
      await this.healthVerifier(
        context.target,
        verification.url,
        context.build.manifest.manifestId,
        verification.nodeRuntime,
        context.isCancellationRequested
      );
      this.throwIfCancelled(context);
      const release: RemoteReleaseRecord = {
        schemaVersion: "ssh-compose-release/v1",
        projectId: context.build.projectId,
        targetRef: context.target.id,
        releaseId: id,
        manifestId: context.build.manifest.manifestId,
        builderAdapter: context.build.builderAdapter,
        remoteDirectory,
        composeProject,
        publicUrl: verification.url,
        deployedAt: new Date().toISOString(),
        ...(context.previousRelease ? { previousReleaseId: context.previousRelease.releaseId } : {}),
      };
      return { release, publicUrl: verification.url, status: "deployed" };
    } catch (error) {
      const rollback = { attempted: Boolean(candidateStarted || previousStopped), succeeded: false, error: undefined as string | undefined };
      if (rollback.attempted) {
        try {
          if (candidateStarted) {
            await session.exec(
              `cd ${quote(remoteDirectory)} && docker compose -p ${quote(composeProject)} -f compose.yaml down --remove-orphans`
            );
          }
          if (context.previousRelease && previousStopped) {
            await session.exec(
              `cd ${quote(context.previousRelease.remoteDirectory)} && docker compose -p ${quote(context.previousRelease.composeProject)} -f compose.yaml up -d --remove-orphans`
            );
            await this.healthVerifier(
              context.target,
              context.previousRelease.publicUrl,
              context.previousRelease.manifestId,
              context.previousRelease.builderAdapter === "node-modular-monolith-v1"
            );
          }
          rollback.succeeded = true;
        } catch (rollbackError) {
          rollback.error = rollbackError instanceof Error ? rollbackError.message : "Rollback failed.";
        }
      }
      try {
        await session.exec(`rm -rf -- ${quote(remoteDirectory)}`);
      } catch (_cleanupError) {
        // The safe error returned to the caller remains the original failure.
      }
      if (error instanceof RemoteDeploymentError) {
        throw new RemoteDeploymentError(error.message, error.code, rollback);
      }
      throw new RemoteDeploymentError(
        "The SSH/Compose deployment failed.",
        context.isCancellationRequested() ? "DEPLOYMENT_CANCELLED" : "REMOTE_DEPLOYMENT_FAILED",
        rollback
      );
    } finally {
      session.end();
    }
  }

  private throwIfCancelled(context: RemoteDeploymentContext): void {
    if (context.isCancellationRequested()) {
      throw new RemoteDeploymentError("The deployment was cancelled.", "DEPLOYMENT_CANCELLED");
    }
  }

  private async runValidationCheck(
    session: SshSession,
    command: string,
    message: string,
    code: string
  ): Promise<void> {
    try {
      await session.exec(command);
    } catch (_error) {
      throw new RemoteDeploymentError(message, code);
    }
  }

  private async connect(request: SshConnectRequest): Promise<SshSession> {
    const ssh2 = require("ssh2") as { Client: new () => any };
    const client = new ssh2.Client();
    return new Promise((resolve, reject) => {
      let settled = false;
      let fingerprintRejected = false;
      client.once("ready", () => {
        settled = true;
        resolve(new Ssh2Session(client));
      });
      client.once("error", (error: Error & { code?: string; level?: string }) => {
        if (settled) return;
        const message = String(error.message || "");
        if (fingerprintRejected) {
          reject(new RemoteDeploymentError(
            "The SSH server host-key fingerprint does not match the target configuration.",
            "SSH_FINGERPRINT_MISMATCH"
          ));
          return;
        }
        if (
          error.level === "client-authentication" ||
          /authentication|configured authentication methods failed/i.test(message)
        ) {
          reject(new RemoteDeploymentError(
            "The SSH server rejected the configured credential.",
            "SSH_AUTHENTICATION_FAILED"
          ));
          return;
        }
        if (
          ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code || "") ||
          /timed out|refused|unreachable/i.test(message)
        ) {
          reject(new RemoteDeploymentError(
            "The SSH server could not be reached at the configured host and port.",
            "SSH_UNREACHABLE"
          ));
          return;
        }
        reject(new RemoteDeploymentError(
          "The SSH connection could not be established. Verify the host, port, username, credential, and fingerprint.",
          "SSH_CONNECTION_FAILED"
        ));
      });
      client.connect({
        host: request.host,
        port: request.port,
        username: request.username,
        ...(request.password !== undefined ? { password: request.password } : {
          privateKey: request.privateKey,
          ...(request.passphrase !== undefined ? { passphrase: request.passphrase } : {}),
        }),
        readyTimeout: 20_000,
        keepaliveInterval: 5000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer | string) => {
          const calculated = crypto.createHash("sha256").update(key).digest("base64");
          const matches = normalizeFingerprint(calculated) === normalizeFingerprint(request.fingerprint);
          fingerprintRejected = !matches;
          return matches;
        },
      });
    });
  }

  private async verifyHealth(
    _target: DeploymentTargetConnection,
    urlValue: string,
    manifestId: string,
    nodeRuntime: boolean,
    isCancellationRequested?: () => boolean
  ): Promise<void> {
    const deadline = Date.now() + (this.options.healthTimeoutMs || 45_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (isCancellationRequested?.()) {
        throw new RemoteDeploymentError("The deployment was cancelled.", "DEPLOYMENT_CANCELLED");
      }
      try {
        const url = new URL(urlValue);
        const authorized = await this.options.healthHosts.authorize(url.hostname);
        const body = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          const transport = url.protocol === "https:" ? https : http;
          const request = transport.request({
            protocol: url.protocol,
            host: authorized.connectAddress,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: { host: url.host, accept: nodeRuntime ? "application/json" : "text/html" },
            timeout: 7000,
            ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
          }, (response) => {
            let content = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              if (content.length < 1024 * 1024) content += chunk;
            });
            response.on("end", () => resolve({ statusCode: response.statusCode || 500, body: content }));
          });
          request.on("timeout", () => request.destroy(new Error("health check timed out")));
          request.on("error", reject);
          request.end();
        });
        if (body.statusCode < 200 || body.statusCode >= 400) throw new Error(`HTTP ${body.statusCode}`);
        if (nodeRuntime) {
          const parsed = JSON.parse(body.body) as { manifestId?: string };
          if (parsed.manifestId !== manifestId) throw new Error("manifest marker mismatch");
        } else if (!body.body.includes(`data-manifest-id="${manifestId}"`)) {
          throw new Error("manifest marker mismatch");
        }
        return;
      } catch (error) {
        if (error instanceof RemoteDeploymentError && error.code === "DEPLOYMENT_CANCELLED") {
          throw error;
        }
        lastError = error;
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
      }
    }
    void lastError;
    throw new RemoteDeploymentError("The deployed release did not pass its public health check.", "HEALTH_CHECK_FAILED");
  }
}
