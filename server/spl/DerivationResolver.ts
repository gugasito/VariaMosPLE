import path from "path";
import {
  Artifact,
  ArtifactCatalog,
  BindingDocument,
  DeploymentManifest,
  DerivationRequest,
  ProductConfiguration,
} from "./contracts";

type SchemaName = "catalog" | "binding" | "configuration" | "target" | "manifest";

type ContractValidator = {
  createValidator: () => unknown;
  validateDocument: (
    validator: unknown,
    schemaName: SchemaName,
    document: unknown
  ) => { valid: boolean; errors: string[] };
};

export class DerivationResolutionError extends Error {
  public readonly diagnostics: string[];

  constructor(diagnostics: string[]) {
    super(`Derivation could not be resolved: ${diagnostics.join(" | ")}`);
    this.name = "DerivationResolutionError";
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, DerivationResolutionError.prototype);
  }
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function getContractValidator(): ContractValidator {
  const validatorModulePath = path.resolve(
    __dirname,
    "../../../contracts/scripts/validate-contracts.cjs"
  );

  return require(validatorModulePath) as ContractValidator;
}

export class DerivationResolver {
  public resolve(request: DerivationRequest): DeploymentManifest {
    const diagnostics = this.validateRequestContracts(request);
    diagnostics.push(...this.validateRequestConsistency(request));

    const selectedFeatures = request.configuration.selections
      .filter((selection) => selection.selected)
      .sort((left, right) => left.featureId.localeCompare(right.featureId));

    if (selectedFeatures.length === 0) {
      diagnostics.push("The configuration does not contain selected features to derive.");
    }

    if (request.configuration.modelVersion !== request.sourceModel.version) {
      diagnostics.push(
        "The configuration version does not match the declared source model version."
      );
    }

    const artifactById = new Map(
      request.catalog.artifacts.map((artifact) => [artifact.id, artifact])
    );
    const bindingByFeatureId = new Map(
      request.bindings.bindings.map((binding) => [binding.featureId, binding])
    );
    const requestedArtifactIds = new Set<string>();

    selectedFeatures.forEach((selection) => {
      const binding = bindingByFeatureId.get(selection.featureId);
      if (!binding) {
        diagnostics.push(
          `Selected feature '${selection.featureId}' does not have a binding.`
        );
        return;
      }

      binding.actions.forEach((action) => {
        if (action.type !== "include") {
          diagnostics.push(
            `Binding '${binding.id}' uses action '${action.type}', which is not supported by the v1 resolver.`
          );
          return;
        }

        if (!action.artifactId) {
          diagnostics.push(
            `Binding '${binding.id}' includes an action without artifactId.`
          );
          return;
        }

        requestedArtifactIds.add(action.artifactId);
      });
    });

    const resolvedArtifacts = this.resolveArtifactClosure(
      requestedArtifactIds,
      artifactById,
      diagnostics
    );

    resolvedArtifacts.forEach((artifact) => {
      artifact.requiresCapabilities.forEach((capability) => {
        if (!request.target.capabilities.includes(capability)) {
          diagnostics.push(
            `Target '${request.target.id}' does not provide capability '${capability}', which is required by '${artifact.id}'.`
          );
        }
      });
    });

    if (diagnostics.length > 0) {
      throw new DerivationResolutionError(diagnostics);
    }

    const manifest = this.createManifest(request, selectedFeatures, resolvedArtifacts);
    const manifestDiagnostics = this.validateGeneratedManifest(manifest);

    if (manifestDiagnostics.length > 0) {
      throw new DerivationResolutionError(manifestDiagnostics);
    }

    return manifest;
  }

  private validateRequestContracts(request: DerivationRequest): string[] {
    const { createValidator, validateDocument } = getContractValidator();
    const validator = createValidator();
    const documents: Array<[SchemaName, unknown]> = [
      ["catalog", request.catalog],
      ["binding", request.bindings],
      ["configuration", request.configuration],
      ["target", request.target],
    ];

    return documents.flatMap(([schemaName, document]) => {
      const result = validateDocument(validator, schemaName, document);
      return result.valid
        ? []
        : result.errors.map((error) => `${schemaName}: ${error}`);
    });
  }

  private validateRequestConsistency(request: DerivationRequest): string[] {
    const diagnostics: string[] = [];
    const artifactIds = new Set<string>();
    const featureIds = new Set<string>();
    const bindingFeatureIds = new Set<string>();

    request.catalog.artifacts.forEach((artifact) => {
      if (artifactIds.has(artifact.id)) {
        diagnostics.push(`The catalog contains duplicate artifact '${artifact.id}'.`);
      }
      artifactIds.add(artifact.id);
    });

    request.configuration.selections.forEach((selection) => {
      if (featureIds.has(selection.featureId)) {
        diagnostics.push(
          `The configuration contains duplicate feature '${selection.featureId}'.`
        );
      }
      featureIds.add(selection.featureId);
    });

    request.bindings.bindings.forEach((binding) => {
      if (bindingFeatureIds.has(binding.featureId)) {
        diagnostics.push(
          `Feature '${binding.featureId}' has more than one v1 binding.`
        );
      }
      bindingFeatureIds.add(binding.featureId);

      binding.actions.forEach((action) => {
        if (action.artifactId && !artifactIds.has(action.artifactId)) {
          diagnostics.push(
            `Binding '${binding.id}' references missing artifact '${action.artifactId}'.`
          );
        }
      });
    });

    return diagnostics;
  }

  private resolveArtifactClosure(
    requestedArtifactIds: Set<string>,
    artifactById: Map<string, Artifact>,
    diagnostics: string[]
  ): Artifact[] {
    const resolved = new Set<string>();
    const resolving = new Set<string>();
    const orderedArtifacts: Artifact[] = [];

    const visit = (artifactId: string, trail: string[]): void => {
      if (resolved.has(artifactId)) {
        return;
      }

      if (resolving.has(artifactId)) {
        diagnostics.push(
          `A dependency cycle was detected: ${[...trail, artifactId].join(" -> ")}.`
        );
        return;
      }

      const artifact = artifactById.get(artifactId);
      if (!artifact) {
        diagnostics.push(`Artifact '${artifactId}', requested by a binding, does not exist.`);
        return;
      }

      resolving.add(artifactId);
      [...(artifact.dependsOn || [])]
        .sort()
        .forEach((dependencyId) => visit(dependencyId, [...trail, artifactId]));
      resolving.delete(artifactId);

      if (!resolved.has(artifactId)) {
        resolved.add(artifactId);
        orderedArtifacts.push(artifact);
      }
    };

    [...requestedArtifactIds].sort().forEach((artifactId) => visit(artifactId, []));
    return orderedArtifacts;
  }

  private createManifest(
    request: DerivationRequest,
    selectedFeatures: ProductConfiguration["selections"],
    artifacts: Artifact[]
  ): DeploymentManifest {
    const productId = request.productId || request.configuration.productLineId;
    const target = { id: request.target.id } as DeploymentManifest["target"];

    if (request.target.credentialsRef) {
      target.credentialsRef = request.target.credentialsRef;
    }

    const isStaticTarget = request.target.capabilities.includes("static-http");
    const isHttpApiTarget = request.target.capabilities.includes("http-api");
    const healthPath = isStaticTarget ? "/" : isHttpApiTarget ? "/health" : undefined;
    const testAdapter = request.catalog.derivation.testAdapter || "contract-validation-v1";

    return {
      schemaVersion: "spl-deployment-manifest/v1",
      manifestId: `manifest.${productId}.${request.configuration.id}`,
      product: {
        id: productId,
        configurationId: request.configuration.id,
      },
      sourceModel: request.sourceModel,
      features: selectedFeatures.map((selection) => ({
        id: selection.featureId,
        selected: true,
      })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        version: artifact.version,
        digest: artifact.integrity.digest,
      })),
      operations: [
        { type: "generate", adapter: request.catalog.derivation.builderAdapter },
        { type: "build", adapter: request.catalog.derivation.builderAdapter },
        { type: "test", adapter: testAdapter },
        { type: "deploy", adapter: request.target.adapter },
        {
          type: "verify",
          adapter: healthPath ? "http-health-check-v1" : "smoke-test-v1",
        },
      ],
      target,
      verification: healthPath
        ? [{ type: "http-health-check", path: healthPath }]
        : [{ type: "smoke-test" }],
      rollback: {
        strategy: "previous-successful-release",
      },
    };
  }

  private validateGeneratedManifest(manifest: DeploymentManifest): string[] {
    const { createValidator, validateDocument } = getContractValidator();
    const validator = createValidator();
    const result = validateDocument(validator, "manifest", manifest);

    return result.valid
      ? []
      : result.errors.map((error) => `manifest generado: ${error}`);
  }
}
