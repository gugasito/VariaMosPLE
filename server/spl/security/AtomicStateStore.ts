import fs from "fs";
import path from "path";
import {
  BuildRecord,
  CredentialBinding,
  DeploymentExecution,
  DeploymentTargetConnection,
  RemoteReleaseRecord,
} from "./SecureTypes";

const SAFE_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function assertSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} must be a stable identifier.`);
  }
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch (_error) {
    // chmod is best effort on filesystems that do not expose POSIX modes.
  }
}

function atomicWrite(fileName: string, value: unknown): void {
  ensureDirectory(path.dirname(fileName));
  const temporary = `${fileName}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, fileName);
  try {
    const directoryDescriptor = fs.openSync(path.dirname(fileName), "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (_error) {
    // Some platforms do not allow fsync on directories.
  }
}

class ScopedEntityStore<T> {
  constructor(private readonly root: string, private readonly collection: string) {
    ensureDirectory(root);
  }

  private directory(scopeId: string): string {
    assertSegment(scopeId, "scope identifier");
    return path.join(this.root, scopeId, this.collection);
  }

  public list(scopeId: string): T[] {
    const directory = this.directory(scopeId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((item) => item.endsWith(".json"))
      .sort()
      .map((item) => JSON.parse(fs.readFileSync(path.join(directory, item), "utf8")) as T);
  }

  public get(scopeId: string, id: string): T | undefined {
    assertSegment(id, "id");
    const fileName = path.join(this.directory(scopeId), `${id}.json`);
    return fs.existsSync(fileName)
      ? JSON.parse(fs.readFileSync(fileName, "utf8")) as T
      : undefined;
  }

  public put(scopeId: string, id: string, value: T): void {
    assertSegment(id, "id");
    atomicWrite(path.join(this.directory(scopeId), `${id}.json`), value);
  }

  public remove(scopeId: string, id: string): boolean {
    assertSegment(id, "id");
    const directory = this.directory(scopeId);
    const fileName = path.join(directory, `${id}.json`);
    if (!fs.existsSync(fileName)) return false;
    fs.unlinkSync(fileName);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (_error) {
      // Some filesystems do not allow fsync on directories.
    }
    return true;
  }

  public find(predicate: (value: T) => boolean): T | undefined {
    return this.all().find(predicate);
  }

  public all(): T[] {
    return fs.readdirSync(this.root).sort().flatMap((scopeDirectory) => {
      const directory = path.join(this.root, scopeDirectory);
      return fs.statSync(directory).isDirectory() ? this.list(scopeDirectory) : [];
    });
  }
}

export class SecureStateRepository {
  private readonly targets: ScopedEntityStore<DeploymentTargetConnection>;
  private readonly bindings: ScopedEntityStore<CredentialBinding>;
  private readonly builds: ScopedEntityStore<BuildRecord>;
  private readonly deployments: ScopedEntityStore<DeploymentExecution>;
  private readonly releases: ScopedEntityStore<RemoteReleaseRecord>;

  constructor(root: string) {
    ensureDirectory(root);
    this.targets = new ScopedEntityStore(path.join(root, "users"), "targets");
    this.bindings = new ScopedEntityStore(path.join(root, "projects"), "credential-bindings");
    this.builds = new ScopedEntityStore(path.join(root, "projects"), "builds");
    this.deployments = new ScopedEntityStore(path.join(root, "projects"), "deployments");
    this.releases = new ScopedEntityStore(path.join(root, "projects"), "remote-releases");
    this.interruptUnfinishedDeployments();
  }

  public listTargets(ownerUserId: string) { return this.targets.list(ownerUserId); }
  public getTarget(ownerUserId: string, id: string) { return this.targets.get(ownerUserId, id); }
  public putTarget(value: DeploymentTargetConnection) { this.targets.put(value.ownerUserId, value.id, value); }
  public removeTarget(ownerUserId: string, id: string) { return this.targets.remove(ownerUserId, id); }
  public allTargets() { return this.targets.all(); }

  public listBindings(projectId: string) { return this.bindings.list(projectId); }
  public getBinding(projectId: string, id: string) { return this.bindings.get(projectId, id); }
  public findBindingByRef(projectId: string, ref: string) {
    return this.bindings.list(projectId).find((item) => item.ref === ref);
  }
  public putBinding(value: CredentialBinding) { this.bindings.put(value.projectId, value.id, value); }

  public listBuilds(projectId: string) { return this.builds.list(projectId); }
  public getBuild(projectId: string, id: string) { return this.builds.get(projectId, id); }
  public putBuild(value: BuildRecord) { this.builds.put(value.projectId, value.buildId, value); }

  public listDeployments(projectId: string) { return this.deployments.list(projectId); }
  public allDeployments() { return this.deployments.all(); }
  public getDeployment(projectId: string, id: string) { return this.deployments.get(projectId, id); }
  public findDeployment(id: string) {
    return this.deployments.find((item) => item.executionId === id);
  }
  public putDeployment(value: DeploymentExecution) {
    this.deployments.put(value.projectId, value.executionId, value);
  }

  public getRelease(projectId: string, targetRef: string) {
    return this.releases.get(projectId, targetRef);
  }
  public putRelease(value: RemoteReleaseRecord) {
    this.releases.put(value.projectId, value.targetRef, value);
  }
  public removeRelease(projectId: string, targetRef: string) {
    return this.releases.remove(projectId, targetRef);
  }

  private interruptUnfinishedDeployments(): void {
    const running = new Set([
      "queued",
      "authorizing",
      "resolving-credential",
      "connecting",
      "uploading",
      "deploying",
      "verifying",
    ]);
    this.deployments.all().forEach((deployment) => {
      if (!running.has(deployment.status)) return;
      const now = new Date().toISOString();
      this.putDeployment({
        ...deployment,
        status: "interrupted",
        updatedAt: now,
        finishedAt: now,
        errorCode: "ORCHESTRATOR_RESTARTED",
        safeError: "The orchestrator restarted while this deployment was running.",
      });
    });
  }
}
