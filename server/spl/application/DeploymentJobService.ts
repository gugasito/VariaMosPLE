import crypto from "crypto";
import {
  DeploymentCredentialLease,
  DeploymentTargetAdapterRegistry,
  RemoteDeploymentError,
} from "../adapters/deployers/DeploymentTargetAdapter";
import { calculateDirectoryDigest } from "../adapters/deployers/SshComposeDeployer";
import { DeploymentManifest } from "../contracts";
import { SecureStateRepository } from "../security/AtomicStateStore";
import { ProjectAuthorizer } from "../security/Authorization";
import {
  createEphemeralSshCredential,
  EphemeralSshCredentialError,
  EphemeralSshCredentialLease,
} from "../security/EphemeralSshCredential";
import { SafeAuditLogger } from "../security/SafeAuditLogger";
import {
  AuthenticatedProjectActor,
  BuildRecord,
  DeploymentExecution,
  DeploymentExecutionStatus,
  DeploymentTargetConnection,
  EphemeralSshCredentialInput,
} from "../security/SecureTypes";
import { DeploymentTargetService } from "./DeploymentTargetService";

export class DeploymentJobServiceError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "DeploymentJobServiceError";
    Object.setPrototypeOf(this, DeploymentJobServiceError.prototype);
  }
}

export interface BuildRecordInput {
  projectId: string;
  manifest: DeploymentManifest;
  planDigest: string;
  targetRef: string;
  targetRevision?: number;
  outputDirectory: string;
  tests: {
    status: string;
    results?: Array<{ name: string; status: string }>;
  };
  builderAdapter: string;
  actor: AuthenticatedProjectActor;
}

export interface CreateDeploymentInput {
  projectId: string;
  buildId: string;
  targetRef: string;
  targetRevision: number;
  expectedPlanDigest: string;
  idempotencyKey: string;
  ephemeralCredential?: EphemeralSshCredentialInput;
}

const ACTIVE_STATUSES = new Set<DeploymentExecutionStatus>([
  "queued",
  "authorizing",
  "resolving-credential",
  "connecting",
  "uploading",
  "deploying",
  "verifying",
]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

function digestJson(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class BuildRecordService {
  constructor(private readonly repository: SecureStateRepository) {}

  public record(input: BuildRecordInput): BuildRecord {
    if (input.tests.status !== "passed") {
      throw new DeploymentJobServiceError(422, "A build can be recorded only after all required tests pass.");
    }
    const outputDigest = calculateDirectoryDigest(input.outputDirectory);
    const manifestDigest = digestJson(input.manifest);
    const buildId = `build-${crypto.createHash("sha256").update(JSON.stringify({
      projectId: input.projectId,
      manifestDigest,
      planDigest: input.planDigest,
      targetRef: input.targetRef,
      targetRevision: input.targetRevision || null,
      outputDigest,
    })).digest("hex").slice(0, 24)}`;
    const existing = this.repository.getBuild(input.projectId, buildId);
    if (existing) return existing;
    const record: BuildRecord = {
      schemaVersion: "spl-build-record/v1",
      buildId,
      projectId: input.projectId,
      manifest: input.manifest,
      manifestDigest,
      planDigest: input.planDigest,
      targetRef: input.targetRef,
      ...(input.targetRevision ? { targetRevision: input.targetRevision } : {}),
      outputDirectory: input.outputDirectory,
      outputDigest,
      tests: {
        status: "passed",
        ...(input.tests.results ? { results: input.tests.results } : {}),
      },
      builderAdapter: input.builderAdapter,
      createdAt: new Date().toISOString(),
      createdBy: input.actor.userId,
    };
    this.repository.putBuild(record);
    return record;
  }
}

export interface DeploymentJobServiceOptions {
  repository: SecureStateRepository;
  targets: DeploymentTargetService;
  adapters: DeploymentTargetAdapterRegistry;
  authorizer: ProjectAuthorizer;
  audit: SafeAuditLogger;
}

export class DeploymentJobService {
  private readonly ephemeralCredentials = new Map<string, EphemeralSshCredentialLease>();

  constructor(private readonly options: DeploymentJobServiceOptions) {}

  public create(
    actor: AuthenticatedProjectActor,
    input: CreateDeploymentInput
  ): { execution: DeploymentExecution; created: boolean } {
    this.assertCreateInput(input);
    if (actor.projectId !== input.projectId) {
      throw new DeploymentJobServiceError(403, "The deployment project does not match the authorized project.");
    }
    const existing = this.options.repository.listDeployments(input.projectId)
      .find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const sameRequest =
        existing.buildId === input.buildId &&
        existing.targetRef === input.targetRef &&
        existing.targetRevision === input.targetRevision &&
        existing.expectedPlanDigest === input.expectedPlanDigest;
      if (!sameRequest) {
        throw new DeploymentJobServiceError(409, "The idempotency key was already used for a different deployment.");
      }
      this.disposeUnneededEphemeral(input.ephemeralCredential);
      return { execution: existing, created: false };
    }
    const build = this.options.repository.getBuild(input.projectId, input.buildId);
    if (!build) throw new DeploymentJobServiceError(404, "The tested build does not exist.");
    if (
      build.planDigest !== input.expectedPlanDigest ||
      build.targetRef !== input.targetRef ||
      build.targetRevision !== input.targetRevision ||
      build.tests.status !== "passed"
    ) {
      throw new DeploymentJobServiceError(409, "The build, approved plan, target, or target revision does not match.");
    }
    const target = this.options.targets.get(actor.userId, input.targetRef);
    if (target.status !== "active" || target.revision !== input.targetRevision) {
      throw new DeploymentJobServiceError(409, "The deployment target is disabled or has changed since the build.");
    }
    const active = this.options.repository.listDeployments(input.projectId)
      .find((item) => item.targetRef === input.targetRef && ACTIVE_STATUSES.has(item.status));
    if (active) throw new DeploymentJobServiceError(409, "Another deployment is already active for this target.");
    const now = new Date().toISOString();
    const ephemeralCredential = this.prepareEphemeralCredential(target, input.ephemeralCredential);
    const execution: DeploymentExecution = {
      schemaVersion: "spl-deployment-execution/v1",
      executionId: `deploy-${crypto.randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      projectId: input.projectId,
      buildId: input.buildId,
      targetRef: input.targetRef,
      targetOwnerUserId: actor.userId,
      targetRevision: input.targetRevision,
      expectedPlanDigest: input.expectedPlanDigest,
      status: "queued",
      createdAt: now,
      createdBy: actor.userId,
      updatedAt: now,
      stageMessage: "Deployment queued.",
    };
    try {
      this.options.repository.putDeployment(execution);
      this.ephemeralCredentials.set(execution.executionId, ephemeralCredential);
      this.options.audit.record({
        event: "credential.ephemeral-accepted",
        result: "succeeded",
        actorId: actor.userId,
        projectId: input.projectId,
        targetRef: input.targetRef,
        executionId: execution.executionId,
        details: { authenticationMode: ephemeralCredential.payload.schemaVersion === "ssh-pem/v1" ? "prompt-pem" : "prompt-password", persisted: false },
      });
      this.options.audit.record({
        event: "deployment.queued",
        result: "requested",
        actorId: actor.userId,
        projectId: input.projectId,
        targetRef: input.targetRef,
        executionId: execution.executionId,
        details: { buildId: input.buildId, targetRevision: input.targetRevision },
      });
      setImmediate(() => {
        void this.run(execution.executionId, actor);
      });
      return { execution, created: true };
    } catch (error) {
      ephemeralCredential?.dispose();
      this.ephemeralCredentials.delete(execution.executionId);
      throw error;
    }
  }

  public get(projectId: string, executionId: string): DeploymentExecution {
    const execution = this.options.repository.getDeployment(projectId, executionId);
    if (!execution) throw new DeploymentJobServiceError(404, "The deployment execution does not exist.");
    return execution;
  }

  public list(projectId: string): DeploymentExecution[] {
    return this.options.repository.listDeployments(projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public cancel(
    actor: AuthenticatedProjectActor,
    executionId: string
  ): DeploymentExecution {
    const execution = this.get(actor.projectId, executionId);
    if (!ACTIVE_STATUSES.has(execution.status)) return execution;
    const now = new Date().toISOString();
    const cancelled: DeploymentExecution = execution.status === "queued"
      ? {
        ...execution,
        status: "cancelled",
        cancelRequestedAt: now,
        updatedAt: now,
        finishedAt: now,
        stageMessage: "Deployment cancelled before execution.",
      }
      : {
        ...execution,
        cancelRequestedAt: now,
        updatedAt: now,
        stageMessage: "Cancellation requested; the current safe step will finish first.",
      };
    this.options.repository.putDeployment(cancelled);
    if (cancelled.status === "cancelled") this.discardEphemeral(executionId);
    this.options.audit.record({
      event: "deployment.cancel-requested",
      result: "requested",
      actorId: actor.userId,
      projectId: actor.projectId,
      targetRef: execution.targetRef,
      executionId,
    });
    return cancelled;
  }

  public cancelByCredential(projectId: string, credentialRef: string): void {
    const targetIds = new Set(
      this.options.repository.allTargets()
        .filter((target) => target.deploymentCredentialRef === credentialRef)
        .map((target) => target.id)
    );
    const now = new Date().toISOString();
    this.options.repository.listDeployments(projectId).forEach((execution) => {
      if (!targetIds.has(execution.targetRef) || !ACTIVE_STATUSES.has(execution.status)) return;
      this.options.repository.putDeployment({
        ...execution,
        ...(execution.status === "queued"
          ? { status: "cancelled" as const, finishedAt: now }
          : {}),
        cancelRequestedAt: now,
        updatedAt: now,
        stageMessage: "Deployment blocked because its credential was revoked.",
      });
    });
  }

  /** Dispose passwords retained only for queued in-memory deployment work. */
  public shutdown(): void {
    this.ephemeralCredentials.forEach((credential) => credential.dispose());
    this.ephemeralCredentials.clear();
  }

  private async run(executionId: string, originalActor: AuthenticatedProjectActor): Promise<void> {
    let execution = this.options.repository.findDeployment(executionId);
    if (!execution || execution.status !== "queued") return;
    let credential: DeploymentCredentialLease | undefined;
    try {
      execution = this.update(execution, "authorizing", "Revalidating owner permission.");
      const actor = await this.options.authorizer.reauthorize(
        originalActor,
        execution.projectId,
        "deployment:manage"
      );
      const latestBeforeCredential = this.options.repository.findDeployment(executionId);
      if (!latestBeforeCredential || latestBeforeCredential.cancelRequestedAt) {
        this.finishCancelled(executionId, originalActor.userId);
        return;
      }
      const build = this.options.repository.getBuild(execution.projectId, execution.buildId);
      if (!build) throw new DeploymentJobServiceError(404, "The immutable build record no longer exists.");
      const target = this.options.targets.get(actor.userId, execution.targetRef);
      if (execution.targetOwnerUserId && execution.targetOwnerUserId !== actor.userId) {
        throw new DeploymentJobServiceError(404, "The deployment target does not exist.");
      }
      if (target.status !== "active" || target.revision !== execution.targetRevision) {
        throw new DeploymentJobServiceError(409, "The target changed after the deployment was queued.");
      }
      execution = this.update(
        execution,
        "resolving-credential",
        "Using the one-time SSH password for this deployment only."
      );
      credential = this.ephemeralCredentials.get(executionId);
      this.ephemeralCredentials.delete(executionId);
      if (!credential) {
        throw new DeploymentJobServiceError(409, "The one-time SSH password is unavailable; enter it again and retry the deployment.");
      }
      const adapter = this.options.adapters.require(target.adapter);
      const result = await adapter.deploy({
          build,
          target,
          credential,
          executionId,
          previousRelease: this.options.repository.getRelease(execution.projectId, target.id),
          updateStage: (status, message) => {
            const latest = this.options.repository.findDeployment(executionId);
            if (latest && ACTIVE_STATUSES.has(latest.status)) this.update(latest, status, message);
          },
          isCancellationRequested: () =>
            Boolean(this.options.repository.findDeployment(executionId)?.cancelRequestedAt),
      });
      this.options.repository.putRelease(result.release);
      const latest = this.options.repository.findDeployment(executionId) || execution;
      const now = new Date().toISOString();
      const succeeded: DeploymentExecution = {
          ...latest,
          status: "succeeded",
          updatedAt: now,
          finishedAt: now,
          stageMessage: result.status === "already-active"
            ? "The tested release was already active and verified."
            : "Deployment completed and verified.",
          releaseId: result.release.releaseId,
          publicUrl: result.publicUrl,
      };
      this.options.repository.putDeployment(succeeded);
      this.options.audit.record({
          event: "deployment.finished",
          result: "succeeded",
          actorId: actor.userId,
          projectId: succeeded.projectId,
          targetRef: succeeded.targetRef,
          executionId,
          details: { releaseId: succeeded.releaseId },
      });
    } catch (error) {
      const latest = this.options.repository.findDeployment(executionId);
      if (!latest || !ACTIVE_STATUSES.has(latest.status)) return;
      const now = new Date().toISOString();
      const remote = error instanceof RemoteDeploymentError ? error : undefined;
      const cancelled = latest.cancelRequestedAt || remote?.code === "DEPLOYMENT_CANCELLED";
      const rolledBack = !cancelled && Boolean(remote?.rollback?.attempted && remote.rollback.succeeded);
      const status: DeploymentExecutionStatus = cancelled
        ? "cancelled"
        : rolledBack
          ? "rolled-back"
          : "failed";
      const failed: DeploymentExecution = {
        ...latest,
        status,
        updatedAt: now,
        finishedAt: now,
        stageMessage: cancelled
          ? "Deployment cancelled; candidate cleanup and recovery completed where possible."
          : rolledBack
            ? "Deployment failed and rollback completed safely."
            : "Deployment failed.",
        errorCode: remote?.code || "DEPLOYMENT_FAILED",
        safeError: this.options.audit.safeError(error),
        ...(remote?.rollback
          ? {
            rollback: {
              attempted: remote.rollback.attempted,
              succeeded: remote.rollback.succeeded,
              ...(remote.rollback.error
                ? { safeError: this.options.audit.safeError(remote.rollback.error) }
                : {}),
            },
          }
          : {}),
      };
      this.options.repository.putDeployment(failed);
      this.options.audit.record({
        event: rolledBack ? "deployment.rolled-back" : cancelled ? "deployment.cancelled" : "deployment.finished",
        result: rolledBack || cancelled ? "succeeded" : "failed",
        actorId: originalActor.userId,
        projectId: failed.projectId,
        targetRef: failed.targetRef,
        executionId,
        details: { errorCode: failed.errorCode, rollback: failed.rollback },
      });
    } finally {
      credential?.dispose();
      this.discardEphemeral(executionId);
    }
  }

  private prepareEphemeralCredential(
    target: DeploymentTargetConnection,
    raw: EphemeralSshCredentialInput | undefined
  ): EphemeralSshCredentialLease {
    if ((target.authentication?.mode !== "prompt-password" && target.authentication?.mode !== "prompt-pem") || target.deploymentCredentialRef) {
      this.disposeUnneededEphemeral(raw);
      throw new DeploymentJobServiceError(409, "Managed SSH-key targets are no longer supported. Register an SSH password or PEM target.");
    }
    let credential: EphemeralSshCredentialLease;
    try {
      credential = createEphemeralSshCredential(raw, this.options.audit);
    } catch (error) {
      if (error instanceof EphemeralSshCredentialError) {
        throw new DeploymentJobServiceError(400, error.message);
      }
      throw error;
    }
    if (credential.payload.username !== target.authentication?.username) {
      credential.dispose();
      throw new DeploymentJobServiceError(400, "The supplied SSH username does not match this target.");
    }
    const expectedSchema = target.authentication.mode === "prompt-pem" ? "ssh-pem/v1" : "ssh-password/v1";
    if (credential.payload.schemaVersion !== expectedSchema) {
      credential.dispose();
      throw new DeploymentJobServiceError(400, "The supplied SSH credential does not match this target.");
    }
    return credential;
  }

  private disposeUnneededEphemeral(raw: EphemeralSshCredentialInput | undefined): void {
    if (!raw) return;
    try {
      createEphemeralSshCredential(raw, this.options.audit).dispose();
    } catch (_error) {
      // It is unneeded for the existing/key-backed job; any password-shaped
      // value was still registered with the redactor before validation.
    }
  }

  private discardEphemeral(executionId: string): void {
    const credential = this.ephemeralCredentials.get(executionId);
    this.ephemeralCredentials.delete(executionId);
    credential?.dispose();
  }

  private update(
    execution: DeploymentExecution,
    status: DeploymentExecutionStatus,
    message: string
  ): DeploymentExecution {
    const now = new Date().toISOString();
    const updated: DeploymentExecution = {
      ...execution,
      status,
      updatedAt: now,
      stageMessage: message,
      ...(execution.startedAt ? {} : { startedAt: now }),
    };
    this.options.repository.putDeployment(updated);
    return updated;
  }

  private finishCancelled(executionId: string, actorId: string): void {
    const execution = this.options.repository.findDeployment(executionId);
    if (!execution) return;
    const now = new Date().toISOString();
    this.options.repository.putDeployment({
      ...execution,
      status: "cancelled",
      updatedAt: now,
      finishedAt: now,
      stageMessage: "Deployment cancelled before credentials were resolved.",
    });
    this.options.audit.record({
      event: "deployment.cancelled",
      result: "succeeded",
      actorId,
      projectId: execution.projectId,
      targetRef: execution.targetRef,
      executionId,
    });
  }

  private assertCreateInput(input: CreateDeploymentInput): void {
    if (
      !input.projectId ||
      !input.buildId ||
      !input.targetRef ||
      !Number.isInteger(input.targetRevision) ||
      input.targetRevision < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(input.expectedPlanDigest) ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    ) {
      throw new DeploymentJobServiceError(400, "The deployment request is invalid.");
    }
  }
}
