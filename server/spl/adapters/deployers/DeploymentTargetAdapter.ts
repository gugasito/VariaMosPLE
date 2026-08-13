import { CredentialLease } from "../../security/CredentialBroker";
import {
  BuildRecord,
  DeploymentExecutionStatus,
  DeploymentTargetConnection,
  RemoteReleaseRecord,
  EphemeralSshCredentialPayload,
  TargetAdapterDefinition,
} from "../../security/SecureTypes";

export type DeploymentCredentialLease = Omit<CredentialLease, "payload"> & {
  payload: CredentialLease["payload"] | EphemeralSshCredentialPayload;
} | {
  payload: EphemeralSshCredentialPayload;
  dispose(): void;
};

export interface TargetValidationContext {
  target: DeploymentTargetConnection;
  credential: DeploymentCredentialLease;
}

export interface RemoteDeploymentContext {
  build: BuildRecord;
  target: DeploymentTargetConnection;
  credential: DeploymentCredentialLease;
  executionId: string;
  previousRelease?: RemoteReleaseRecord;
  updateStage(status: DeploymentExecutionStatus, message: string): void;
  isCancellationRequested(): boolean;
}

export interface RemoteDeploymentResult {
  release: RemoteReleaseRecord;
  publicUrl: string;
  status: "deployed" | "already-active";
}

export interface DeploymentTargetAdapter {
  readonly definition: TargetAdapterDefinition;
  validate(context: TargetValidationContext): Promise<void>;
  deploy(context: RemoteDeploymentContext): Promise<RemoteDeploymentResult>;
}

export class DeploymentTargetAdapterRegistry {
  private readonly adapters = new Map<string, DeploymentTargetAdapter>();

  constructor(adapters: DeploymentTargetAdapter[]) {
    adapters.forEach((adapter) => {
      if (this.adapters.has(adapter.definition.id)) {
        throw new Error(`Deployment target adapter '${adapter.definition.id}' is duplicated.`);
      }
      this.adapters.set(adapter.definition.id, adapter);
    });
  }

  public definitions(remoteEnabled: boolean): TargetAdapterDefinition[] {
    return [...this.adapters.values()]
      .map((adapter) => ({
        ...adapter.definition,
        availability: remoteEnabled ? adapter.definition.availability : "disabled" as const,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public require(id: string): DeploymentTargetAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`No deployment target adapter is registered for '${id}'.`);
    return adapter;
  }
}

export class RemoteDeploymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly rollback?: { attempted: boolean; succeeded: boolean; error?: string }
  ) {
    super(message);
    this.name = "RemoteDeploymentError";
    Object.setPrototypeOf(this, RemoteDeploymentError.prototype);
  }
}
