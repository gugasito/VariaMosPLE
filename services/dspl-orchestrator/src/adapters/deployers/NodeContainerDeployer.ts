import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { DeploymentManifest } from "../../contracts";
import { DockerCommandRunner } from "./NginxContainerDeployer";

const DEFAULT_IMAGE = "node:24-alpine";
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 350;

export interface NodeReleaseRecord {
  schemaVersion: "node-container-release/v1";
  releaseId: string;
  manifestId: string;
  targetId: string;
  containerName: string;
  image: string;
  endpoint: { host: "127.0.0.1"; port: number; url: string };
  distributionDirectory: string;
  dataDirectory: string;
  previousReleaseId?: string;
  deployedAt: string;
}

export interface NodeContainerDeploymentRequest {
  manifest: DeploymentManifest;
  distributionDirectory: string;
  stateDirectory: string;
  dataDirectory: string;
  hostPort: number;
  image?: string;
}

export interface NodeContainerDeploymentResult {
  status: "deployed" | "already-active";
  release: NodeReleaseRecord;
  statePath: string;
}

export class NodeContainerDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeContainerDeploymentError";
    Object.setPrototypeOf(this, NodeContainerDeploymentError.prototype);
  }
}

class SystemDockerRunner implements DockerCommandRunner {
  public run(args: string[]): string {
    try {
      return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      const details = (error as { stderr?: Buffer }).stderr?.toString("utf8").trim() || "";
      throw new NodeContainerDeploymentError(`Docker no pudo ejecutar '${args.join(" ")}'. ${details}`.trim());
    }
  }
}

function stable(value: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function releaseId(manifestId: string): string {
  return `release-${crypto.createHash("sha256").update(manifestId).digest("hex").slice(0, 12)}`;
}

function copySnapshot(source: string, destination: string): void {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

export class NodeContainerDeployer {
  private readonly docker: DockerCommandRunner;

  constructor(docker?: DockerCommandRunner) {
    this.docker = docker || new SystemDockerRunner();
  }

  public async deploy(request: NodeContainerDeploymentRequest): Promise<NodeContainerDeploymentResult> {
    this.assertRequest(request);
    const releaseRoot = path.join(path.resolve(request.stateDirectory), request.manifest.target.id);
    const currentPath = path.join(releaseRoot, "current-release.json");
    const previous = this.readRelease(currentPath);
    const id = releaseId(request.manifest.manifestId);
    const containerName = `variamos-dspl-${request.manifest.target.id.replace(/[^a-z0-9]+/g, "-")}-${id.replace("release-", "")}`.slice(0, 63);
    const endpoint = `http://127.0.0.1:${request.hostPort}/health`;
    if (previous && previous.manifestId === request.manifest.manifestId && this.isRunning(previous.containerName)) {
      await this.waitForHealthy(endpoint, request.manifest.manifestId);
      return { status: "already-active", release: previous, statePath: currentPath };
    }

    const snapshot = path.join(releaseRoot, "snapshots", id);
    copySnapshot(request.distributionDirectory, snapshot);
    fs.mkdirSync(request.dataDirectory, { recursive: true });
    const previousWasRunning = Boolean(previous && this.isRunning(previous.containerName));
    try {
      if (previousWasRunning && previous) this.docker.run(["stop", previous.containerName]);
      if (this.containerExists(containerName)) this.docker.run(["rm", "--force", containerName]);
      const image = request.image || DEFAULT_IMAGE;
      this.docker.run([
        "run", "--detach", "--name", containerName,
        "--label", `variamos.dspl.manifest-id=${request.manifest.manifestId}`,
        "--label", `variamos.dspl.target-id=${request.manifest.target.id}`,
        "--publish", `127.0.0.1:${request.hostPort}:3000`,
        "--mount", `type=bind,src=${snapshot},dst=/app,readonly`,
        "--mount", `type=bind,src=${path.resolve(request.dataDirectory)},dst=/data`,
        "--read-only", "--tmpfs", "/tmp",
        "--env", `DSPL_MANIFEST_ID=${request.manifest.manifestId}`,
        "--env", "DSPL_DATA_DIRECTORY=/data",
        image, "node", "/app/dist/runtime/server.js",
      ]);
      await this.waitForHealthy(endpoint, request.manifest.manifestId);
      const record: NodeReleaseRecord = {
        schemaVersion: "node-container-release/v1",
        releaseId: id,
        manifestId: request.manifest.manifestId,
        targetId: request.manifest.target.id,
        containerName,
        image,
        endpoint: { host: "127.0.0.1", port: request.hostPort, url: endpoint },
        distributionDirectory: snapshot,
        dataDirectory: path.resolve(request.dataDirectory),
        previousReleaseId: previous?.releaseId,
        deployedAt: new Date().toISOString(),
      };
      fs.mkdirSync(releaseRoot, { recursive: true });
      fs.writeFileSync(path.join(releaseRoot, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fs.writeFileSync(currentPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return { status: "deployed", release: record, statePath: currentPath };
    } catch (error) {
      try {
        if (this.isRunning(containerName)) this.docker.run(["rm", "--force", containerName]);
        if (previous && previousWasRunning) this.docker.run(["start", previous.containerName]);
      } catch (_recoveryError) {
        // Se conserva el error de despliegue original; la evidencia queda en el estado local.
      }
      throw new NodeContainerDeploymentError(`No se pudo desplegar '${request.manifest.manifestId}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async rollback(targetId: string, stateDirectory: string): Promise<NodeReleaseRecord> {
    const releaseRoot = path.join(path.resolve(stateDirectory), targetId);
    const current = this.readRelease(path.join(releaseRoot, "current-release.json"));
    if (!current?.previousReleaseId) throw new NodeContainerDeploymentError("No existe una release previa para restaurar.");
    const previous = this.readRelease(path.join(releaseRoot, `${current.previousReleaseId}.json`));
    if (!previous) throw new NodeContainerDeploymentError("No existe el registro de la release previa.");
    if (this.isRunning(current.containerName)) this.docker.run(["stop", current.containerName]);
    if (!this.isRunning(previous.containerName)) this.docker.run(["start", previous.containerName]);
    await this.waitForHealthy(previous.endpoint.url, previous.manifestId);
    fs.writeFileSync(path.join(releaseRoot, "current-release.json"), `${JSON.stringify(previous, null, 2)}\n`, "utf8");
    return previous;
  }

  private assertRequest(request: NodeContainerDeploymentRequest): void {
    if (!stable(request.manifest.target.id)) throw new NodeContainerDeploymentError("target.id inválido.");
    if (!Number.isInteger(request.hostPort) || request.hostPort < 1024 || request.hostPort > 65535) throw new NodeContainerDeploymentError("Puerto local inválido.");
    if (!fs.existsSync(path.join(request.distributionDirectory, "dist/runtime/server.js"))) throw new NodeContainerDeploymentError("La distribución no contiene el runtime Node esperado.");
    if (!request.manifest.operations.some((operation) => operation.type === "deploy" && operation.adapter === "node-container-v1")) throw new NodeContainerDeploymentError("El manifest no declara node-container-v1.");
    const health = request.manifest.verification.find((entry) => entry.type === "http-health-check");
    if (!health || health.path !== "/health") throw new NodeContainerDeploymentError("El manifest no declara health check HTTP /health.");
  }

  private readRelease(fileName: string): NodeReleaseRecord | undefined {
    return fs.existsSync(fileName) ? JSON.parse(fs.readFileSync(fileName, "utf8")) as NodeReleaseRecord : undefined;
  }

  private containerExists(name: string): boolean {
    try { this.docker.run(["container", "inspect", name]); return true; } catch (_error) { return false; }
  }

  private isRunning(name: string): boolean {
    try { return this.docker.run(["inspect", "--format", "{{.State.Running}}", name]) === "true"; } catch (_error) { return false; }
  }

  private health(url: string, manifestId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = http.get(url, { timeout: 20_000 }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if ((response.statusCode || 0) >= 200 && (response.statusCode || 0) < 400 && parsed.manifestId === manifestId) return resolve();
          } catch (_error) {
            // Continúa con el diagnóstico uniforme.
          }
          reject(new NodeContainerDeploymentError(`Health check inválido en '${url}'.`));
        });
      });
      request.on("timeout", () => request.destroy(new NodeContainerDeploymentError(`Health check agotó el tiempo en '${url}'.`)));
      request.on("error", reject);
    });
  }

  /**
   * Docker devuelve el id del contenedor antes de que Node abra su socket. Un
   * único GET producía falsos negativos (socket hang up) al arrancar una imagen
   * por primera vez. El despliegue espera el mismo límite explícito que el
   * adapter Nginx, sin aceptar una respuesta que no pertenezca al manifest.
   */
  private async waitForHealthy(url: string, manifestId: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.health(url, manifestId);
        return;
      } catch (error) {
        lastError = error;
        await new Promise<void>((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError || "sin respuesta");
    throw new NodeContainerDeploymentError(`Health check agotó el tiempo en '${url}': ${detail}`);
  }
}
