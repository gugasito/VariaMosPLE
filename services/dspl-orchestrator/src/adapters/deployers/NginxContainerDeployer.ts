import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { DeploymentManifest } from "../../contracts";

const RELEASE_SCHEMA_VERSION = "nginx-container-release/v1";
const DEFAULT_IMAGE = "nginx:1.27-alpine";
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_INTERVAL_MS = 400;

export interface DockerCommandRunner {
  run(args: string[]): string;
}

export interface HealthCheckRequest {
  url: string;
  expectedManifestId: string;
  timeoutMs: number;
}

export type HealthChecker = (request: HealthCheckRequest) => Promise<void>;

export interface NginxReleaseRecord {
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  releaseId: string;
  manifestId: string;
  product: {
    id: string;
    configurationId: string;
  };
  targetId: string;
  containerName: string;
  image: string;
  imageId: string;
  endpoint: {
    host: "127.0.0.1";
    port: number;
    url: string;
  };
  distribution: {
    directory: string;
    indexDigest: string;
  };
  previousReleaseId?: string;
  deployedAt: string;
}

export interface NginxContainerDeploymentRequest {
  manifest: DeploymentManifest;
  distributionDirectory: string;
  stateDirectory: string;
  hostPort: number;
  image?: string;
  healthCheckTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export interface NginxContainerDeploymentResult {
  status: "deployed" | "already-active";
  release: NginxReleaseRecord;
  statePath: string;
}

export interface NginxRollbackRequest {
  targetId: string;
  stateDirectory: string;
  hostPort: number;
  healthCheckTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export interface NginxRollbackResult {
  status: "rolled-back";
  activeRelease: NginxReleaseRecord;
  replacedRelease: NginxReleaseRecord;
  statePath: string;
}

export interface NginxContainerDeployerOptions {
  docker?: DockerCommandRunner;
  healthChecker?: HealthChecker;
}

export class NginxContainerDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NginxContainerDeploymentError";
    Object.setPrototypeOf(this, NginxContainerDeploymentError.prototype);
  }
}

class SystemDockerCommandRunner implements DockerCommandRunner {
  public run(args: string[]): string {
    try {
      return execFileSync("docker", args, {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      const stderrDetails = stderr ? stderr.toString().trim() : "";
      const details = [asErrorMessage(error), stderrDetails].filter(Boolean).join(" ");
      throw new NginxContainerDeploymentError(
        `Docker no pudo ejecutar '${args.join(" ")}': ${details}`
      );
    }
  }
}

function calculateDigest(content: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function writeAtomically(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertStableIdentifier(value: string, field: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new NginxContainerDeploymentError(
      `El campo '${field}' no es un identificador estable válido.`
    );
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new NginxContainerDeploymentError(
      "El puerto local debe ser un entero entre 1024 y 65535."
    );
  }
}

function assertImage(image: string): void {
  if (!image || /\s/.test(image) || image.length > 512) {
    throw new NginxContainerDeploymentError(
      "La imagen de Nginx debe ser una referencia Docker no vacía y sin espacios."
    );
  }
}

function createReleaseId(manifestId: string): string {
  const suffix = crypto
    .createHash("sha256")
    .update(manifestId)
    .digest("hex")
    .slice(0, 12);
  return `release-${suffix}`;
}

function createContainerName(targetId: string, releaseId: string): string {
  const targetPart = targetId.replace(/[^a-z0-9]+/g, "-").slice(0, 32);
  const suffix = releaseId.replace("release-", "");
  return `variamos-dspl-${targetPart}-${suffix}`.slice(0, 63);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultHealthChecker(request: HealthCheckRequest): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const httpRequest = http.get(request.url, { timeout: request.timeoutMs }, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length <= 256 * 1024) {
          body += chunk;
        }
      });
      response.on("end", () => {
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 400) {
          reject(
            new NginxContainerDeploymentError(
              `Health check respondió HTTP ${statusCode} en '${request.url}'.`
            )
          );
          return;
        }

        const marker = `data-manifest-id="${request.expectedManifestId}"`;
        if (!body.includes(marker)) {
          reject(
            new NginxContainerDeploymentError(
              `Health check respondió, pero no corresponde al manifest '${request.expectedManifestId}'.`
            )
          );
          return;
        }

        resolve();
      });
    });

    httpRequest.on("timeout", () => {
      httpRequest.destroy(
        new NginxContainerDeploymentError(`Health check agotó su tiempo de espera en '${request.url}'.`)
      );
    });
    httpRequest.on("error", reject);
  });
}

export class NginxContainerDeployer {
  private readonly docker: DockerCommandRunner;
  private readonly healthChecker: HealthChecker;

  constructor(options: NginxContainerDeployerOptions = {}) {
    this.docker = options.docker || new SystemDockerCommandRunner();
    this.healthChecker = options.healthChecker || defaultHealthChecker;
  }

  public async deploy(
    request: NginxContainerDeploymentRequest
  ): Promise<NginxContainerDeploymentResult> {
    const deploymentPlan = this.assertDeploymentPlan(request.manifest);
    const verifiedDistribution = this.assertDistribution(
      request.distributionDirectory,
      request.manifest
    );
    assertPort(request.hostPort);
    const image = request.image || DEFAULT_IMAGE;
    assertImage(image);
    this.assertDockerAvailable();

    const stateDirectory = this.getTargetStateDirectory(
      request.stateDirectory,
      request.manifest.target.id
    );
    const statePath = path.join(stateDirectory, "current-release.json");
    const endpointUrl = `http://127.0.0.1:${request.hostPort}${deploymentPlan.healthPath}`;
    const releaseId = createReleaseId(request.manifest.manifestId);
    const containerName = createContainerName(request.manifest.target.id, releaseId);

    const previousRelease = this.readCurrentRelease(statePath);

    if (
      previousRelease &&
      previousRelease.manifestId === request.manifest.manifestId &&
      previousRelease.endpoint.port === request.hostPort &&
      this.isContainerRunning(previousRelease.containerName)
    ) {
      await this.waitForHealthy({
        url: previousRelease.endpoint.url,
        expectedManifestId: previousRelease.manifestId,
        timeoutMs: request.healthCheckTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS,
        intervalMs: request.healthCheckIntervalMs || DEFAULT_HEALTH_INTERVAL_MS,
      });
      return { status: "already-active", release: previousRelease, statePath };
    }

    const previousWasRunning = Boolean(
      previousRelease && this.isContainerRunning(previousRelease.containerName)
    );
    const distribution = this.createReleaseDistributionSnapshot(
      verifiedDistribution,
      stateDirectory,
      releaseId,
      request.manifest
    );
    let previousStopped = false;
    let candidateCreated = false;

    try {
      if (previousWasRunning && previousRelease) {
        this.docker.run(["stop", previousRelease.containerName]);
        previousStopped = true;
      }

      if (this.containerExists(containerName)) {
        this.docker.run(["rm", "--force", containerName]);
      }

      this.docker.run([
        "run",
        "--detach",
        "--name",
        containerName,
        "--label",
        `variamos.dspl.manifest-id=${request.manifest.manifestId}`,
        "--label",
        `variamos.dspl.target-id=${request.manifest.target.id}`,
        "--publish",
        `127.0.0.1:${request.hostPort}:80`,
        "--mount",
        `type=bind,src=${distribution.directory},dst=/usr/share/nginx/html,readonly`,
        "--read-only",
        "--tmpfs",
        "/var/cache/nginx",
        "--tmpfs",
        "/var/run",
        "--tmpfs",
        "/var/log/nginx",
        image,
      ]);
      candidateCreated = true;

      await this.waitForHealthy({
        url: endpointUrl,
        expectedManifestId: request.manifest.manifestId,
        timeoutMs: request.healthCheckTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS,
        intervalMs: request.healthCheckIntervalMs || DEFAULT_HEALTH_INTERVAL_MS,
      });

      const release: NginxReleaseRecord = {
        schemaVersion: RELEASE_SCHEMA_VERSION,
        releaseId,
        manifestId: request.manifest.manifestId,
        product: request.manifest.product,
        targetId: request.manifest.target.id,
        containerName,
        image,
        imageId: this.docker.run(["image", "inspect", "--format", "{{.Id}}", image]),
        endpoint: {
          host: "127.0.0.1",
          port: request.hostPort,
          url: endpointUrl,
        },
        distribution,
        previousReleaseId: previousRelease?.releaseId,
        deployedAt: new Date().toISOString(),
      };

      this.writeRelease(stateDirectory, release);
      writeAtomically(statePath, `${JSON.stringify(release, null, 2)}\n`);
      return { status: "deployed", release, statePath };
    } catch (error) {
      const recovery = await this.recoverPreviousRelease({
        candidateCreated,
        candidateName: containerName,
        previousRelease,
        previousStopped,
        timeoutMs: request.healthCheckTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS,
        intervalMs: request.healthCheckIntervalMs || DEFAULT_HEALTH_INTERVAL_MS,
      });
      const recoveryDetails = recovery.length > 0 ? ` Recuperación: ${recovery.join(" ")}` : "";
      throw new NginxContainerDeploymentError(
        `No se pudo desplegar '${request.manifest.manifestId}': ${asErrorMessage(error)}.${recoveryDetails}`
      );
    }
  }

  public async rollback(request: NginxRollbackRequest): Promise<NginxRollbackResult> {
    assertStableIdentifier(request.targetId, "targetId");
    assertPort(request.hostPort);
    this.assertDockerAvailable();

    const stateDirectory = this.getTargetStateDirectory(request.stateDirectory, request.targetId);
    const statePath = path.join(stateDirectory, "current-release.json");
    const replacedRelease = this.readCurrentRelease(statePath);
    if (!replacedRelease) {
      throw new NginxContainerDeploymentError(
        `No existe una liberación activa registrada para '${request.targetId}'.`
      );
    }
    if (!replacedRelease.previousReleaseId) {
      throw new NginxContainerDeploymentError(
        `La liberación '${replacedRelease.releaseId}' no tiene una liberación previa para restaurar.`
      );
    }
    if (replacedRelease.endpoint.port !== request.hostPort) {
      throw new NginxContainerDeploymentError(
        "El puerto solicitado no coincide con el de la liberación activa registrada."
      );
    }

    const activeRelease = this.readRelease(
      path.join(stateDirectory, `${replacedRelease.previousReleaseId}.json`)
    );
    if (!activeRelease) {
      throw new NginxContainerDeploymentError(
        `No se encontró el registro de la liberación previa '${replacedRelease.previousReleaseId}'.`
      );
    }

    const replacedWasRunning = this.isContainerRunning(replacedRelease.containerName);
    let replacementStopped = false;
    let restoredStarted = false;

    try {
      if (replacedWasRunning) {
        this.docker.run(["stop", replacedRelease.containerName]);
        replacementStopped = true;
      }
      if (!this.isContainerRunning(activeRelease.containerName)) {
        this.docker.run(["start", activeRelease.containerName]);
        restoredStarted = true;
      }
      await this.waitForHealthy({
        url: activeRelease.endpoint.url,
        expectedManifestId: activeRelease.manifestId,
        timeoutMs: request.healthCheckTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS,
        intervalMs: request.healthCheckIntervalMs || DEFAULT_HEALTH_INTERVAL_MS,
      });
      writeAtomically(statePath, `${JSON.stringify(activeRelease, null, 2)}\n`);
      return { status: "rolled-back", activeRelease, replacedRelease, statePath };
    } catch (error) {
      const recovery: string[] = [];
      if (restoredStarted) {
        try {
          this.docker.run(["stop", activeRelease.containerName]);
          recovery.push("se detuvo la liberación previa que no superó el health check.");
        } catch (stopError) {
          recovery.push(`no se pudo detener la liberación previa: ${asErrorMessage(stopError)}.`);
        }
      }
      if (replacementStopped) {
        try {
          this.docker.run(["start", replacedRelease.containerName]);
          recovery.push("se restauró la liberación que estaba activa antes del rollback.");
        } catch (startError) {
          recovery.push(`no se pudo restaurar la liberación original: ${asErrorMessage(startError)}.`);
        }
      }
      throw new NginxContainerDeploymentError(
        `No se pudo hacer rollback en '${request.targetId}': ${asErrorMessage(error)}. ${recovery.join(" ")}`
      );
    }
  }

  private assertDeploymentPlan(manifest: DeploymentManifest): { healthPath: string } {
    assertStableIdentifier(manifest.manifestId, "manifestId");
    assertStableIdentifier(manifest.target.id, "target.id");
    const hasNginxDeploy = manifest.operations.some(
      (operation) => operation.type === "deploy" && operation.adapter === "nginx-container-v1"
    );
    const hasHttpVerification = manifest.operations.some(
      (operation) => operation.type === "verify" && operation.adapter === "http-health-check-v1"
    );
    const healthCheck = manifest.verification.find(
      (verification) => verification.type === "http-health-check"
    );

    if (!hasNginxDeploy || !hasHttpVerification || !healthCheck?.path) {
      throw new NginxContainerDeploymentError(
        "El manifest no declara el plan deploy/verify requerido para nginx-container-v1."
      );
    }
    if (!healthCheck.path.startsWith("/") || healthCheck.path.startsWith("//")) {
      throw new NginxContainerDeploymentError(
        "El path del health check debe ser relativo al servidor HTTP."
      );
    }
    if (manifest.rollback.strategy !== "previous-successful-release") {
      throw new NginxContainerDeploymentError(
        "nginx-container-v1 requiere rollback 'previous-successful-release'."
      );
    }

    return { healthPath: healthCheck.path };
  }

  private assertDistribution(
    distributionDirectory: string,
    manifest: DeploymentManifest
  ): NginxReleaseRecord["distribution"] {
    let directory: string;
    try {
      directory = fs.realpathSync(path.resolve(distributionDirectory));
    } catch (error) {
      throw new NginxContainerDeploymentError(
        `No se pudo acceder al directorio de distribución: ${asErrorMessage(error)}`
      );
    }
    const indexPath = path.join(directory, "index.html");
    const metadataPath = path.join(directory, "build-metadata.json");

    if (!fs.statSync(directory).isDirectory()) {
      throw new NginxContainerDeploymentError("El directorio de distribución no es un directorio.");
    }
    if (!fs.existsSync(indexPath) || !fs.existsSync(metadataPath)) {
      throw new NginxContainerDeploymentError(
        "El directorio de distribución debe contener index.html y build-metadata.json."
      );
    }
    if (!fs.lstatSync(indexPath).isFile() || !fs.lstatSync(metadataPath).isFile()) {
      throw new NginxContainerDeploymentError(
        "index.html y build-metadata.json deben ser archivos regulares, no enlaces."
      );
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch (error) {
      throw new NginxContainerDeploymentError(
        `No se pudo leer build-metadata.json: ${asErrorMessage(error)}`
      );
    }
    if (!this.matchesBuildMetadata(metadata, manifest)) {
      throw new NginxContainerDeploymentError(
        "build-metadata.json no corresponde al manifest que se intenta desplegar."
      );
    }

    return {
      directory,
      indexDigest: calculateDigest(fs.readFileSync(indexPath)),
    };
  }

  private createReleaseDistributionSnapshot(
    distribution: NginxReleaseRecord["distribution"],
    stateDirectory: string,
    releaseId: string,
    manifest: DeploymentManifest
  ): NginxReleaseRecord["distribution"] {
    const releaseDirectory = path.join(stateDirectory, "releases", releaseId);
    const snapshotDirectory = path.join(releaseDirectory, "site");

    if (fs.existsSync(snapshotDirectory)) {
      return this.assertDistribution(snapshotDirectory, manifest);
    }

    fs.mkdirSync(releaseDirectory, { recursive: true });
    const temporaryDirectory = path.join(
      releaseDirectory,
      `site.${process.pid}.${Date.now()}.tmp`
    );
    const sourceIndex = path.join(distribution.directory, "index.html");
    const sourceMetadata = path.join(distribution.directory, "build-metadata.json");

    try {
      fs.mkdirSync(temporaryDirectory);
      fs.copyFileSync(sourceIndex, path.join(temporaryDirectory, "index.html"));
      fs.copyFileSync(sourceMetadata, path.join(temporaryDirectory, "build-metadata.json"));
      fs.renameSync(temporaryDirectory, snapshotDirectory);
    } catch (error) {
      throw new NginxContainerDeploymentError(
        `No se pudo crear el snapshot inmutable de la release '${releaseId}': ${asErrorMessage(error)}`
      );
    }

    return this.assertDistribution(snapshotDirectory, manifest);
  }

  private matchesBuildMetadata(metadata: unknown, manifest: DeploymentManifest): boolean {
    if (!metadata || typeof metadata !== "object") {
      return false;
    }
    const candidate = metadata as {
      manifestId?: unknown;
      productId?: unknown;
      artifacts?: unknown;
    };
    if (
      candidate.manifestId !== manifest.manifestId ||
      candidate.productId !== manifest.product.id ||
      !Array.isArray(candidate.artifacts) ||
      candidate.artifacts.length !== manifest.artifacts.length
    ) {
      return false;
    }

    const expected = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact.digest]));
    return candidate.artifacts.every((artifact) => {
      if (!artifact || typeof artifact !== "object") {
        return false;
      }
      const entry = artifact as { id?: unknown; digest?: unknown };
      return typeof entry.id === "string" && expected.get(entry.id) === entry.digest;
    });
  }

  private assertDockerAvailable(): void {
    this.docker.run(["version", "--format", "{{.Server.Version}}"]);
  }

  private getTargetStateDirectory(stateDirectory: string, targetId: string): string {
    assertStableIdentifier(targetId, "targetId");
    const root = path.resolve(stateDirectory);
    const directory = path.join(root, targetId);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  private readCurrentRelease(statePath: string): NginxReleaseRecord | undefined {
    return this.readRelease(statePath);
  }

  private readRelease(releasePath: string): NginxReleaseRecord | undefined {
    if (!fs.existsSync(releasePath)) {
      return undefined;
    }
    try {
      const release = JSON.parse(fs.readFileSync(releasePath, "utf8")) as NginxReleaseRecord;
      this.assertReleaseRecord(release);
      return release;
    } catch (error) {
      if (error instanceof NginxContainerDeploymentError) {
        throw error;
      }
      throw new NginxContainerDeploymentError(
        `El registro de release '${releasePath}' no es válido: ${asErrorMessage(error)}`
      );
    }
  }

  private assertReleaseRecord(release: NginxReleaseRecord): void {
    if (
      release.schemaVersion !== RELEASE_SCHEMA_VERSION ||
      typeof release.releaseId !== "string" ||
      typeof release.manifestId !== "string" ||
      typeof release.containerName !== "string" ||
      release.endpoint?.host !== "127.0.0.1" ||
      !Number.isInteger(release.endpoint?.port) ||
      typeof release.endpoint?.url !== "string" ||
      typeof release.distribution?.directory !== "string" ||
      typeof release.distribution?.indexDigest !== "string"
    ) {
      throw new NginxContainerDeploymentError("El registro de release no cumple nginx-container-release/v1.");
    }
  }

  private writeRelease(stateDirectory: string, release: NginxReleaseRecord): void {
    writeAtomically(
      path.join(stateDirectory, `${release.releaseId}.json`),
      `${JSON.stringify(release, null, 2)}\n`
    );
  }

  private containerExists(containerName: string): boolean {
    try {
      this.docker.run(["inspect", "--format", "{{.Id}}", containerName]);
      return true;
    } catch (_error) {
      return false;
    }
  }

  private isContainerRunning(containerName: string): boolean {
    try {
      return this.docker.run(["inspect", "--format", "{{.State.Running}}", containerName]) === "true";
    } catch (_error) {
      return false;
    }
  }

  private async waitForHealthy({
    url,
    expectedManifestId,
    timeoutMs,
    intervalMs,
  }: {
    url: string;
    expectedManifestId: string;
    timeoutMs: number;
    intervalMs: number;
  }): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() <= deadline) {
      try {
        await this.healthChecker({
          url,
          expectedManifestId,
          timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())),
        });
        return;
      } catch (error) {
        lastError = error;
        if (Date.now() + intervalMs > deadline) {
          break;
        }
        await sleep(intervalMs);
      }
    }

    throw new NginxContainerDeploymentError(
      `El health check no confirmó '${expectedManifestId}' en '${url}': ${asErrorMessage(lastError)}`
    );
  }

  private async recoverPreviousRelease({
    candidateCreated,
    candidateName,
    previousRelease,
    previousStopped,
    timeoutMs,
    intervalMs,
  }: {
    candidateCreated: boolean;
    candidateName: string;
    previousRelease?: NginxReleaseRecord;
    previousStopped: boolean;
    timeoutMs: number;
    intervalMs: number;
  }): Promise<string[]> {
    const recovery: string[] = [];
    if (candidateCreated) {
      try {
        this.docker.run(["rm", "--force", candidateName]);
        recovery.push("se eliminó el candidato que no superó la verificación.");
      } catch (error) {
        recovery.push(`no se pudo eliminar el candidato: ${asErrorMessage(error)}.`);
      }
    }
    if (previousStopped && previousRelease) {
      try {
        this.docker.run(["start", previousRelease.containerName]);
        await this.waitForHealthy({
          url: previousRelease.endpoint.url,
          expectedManifestId: previousRelease.manifestId,
          timeoutMs,
          intervalMs,
        });
        recovery.push("se restauró la liberación previa exitosa.");
      } catch (error) {
        recovery.push(`no se pudo restaurar la liberación previa: ${asErrorMessage(error)}.`);
      }
    }
    return recovery;
  }
}
