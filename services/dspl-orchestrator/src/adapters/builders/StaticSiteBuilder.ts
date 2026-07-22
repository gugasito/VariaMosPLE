import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Artifact, ArtifactCatalog, DeploymentManifest } from "../../contracts";
import {
  ArtifactProviderError,
  ArtifactProviderRegistry,
} from "../providers/ArtifactProvider";

export interface StaticSiteBuildRequest {
  manifest: DeploymentManifest;
  catalog: ArtifactCatalog;
  providers: ArtifactProviderRegistry;
  outputDirectory: string;
}

export interface StaticSiteBuildResult {
  outputDirectory: string;
  indexPath: string;
  metadataPath: string;
  artifacts: Array<{
    id: string;
    digest: string;
    bytes: number;
    provider: string;
  }>;
}

export class StaticSiteBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticSiteBuildError";
    Object.setPrototypeOf(this, StaticSiteBuildError.prototype);
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character];
  });
}

export class StaticSiteBuilder {
  public build(request: StaticSiteBuildRequest): StaticSiteBuildResult {
    this.assertStaticBuildPlan(request.manifest);

    const catalogById = new Map(
      request.catalog.artifacts.map((artifact) => [artifact.id, artifact])
    );
    const materializedArtifacts: StaticSiteBuildResult["artifacts"] = [];
    const sections: string[] = [];

    request.manifest.artifacts.forEach((manifestArtifact) => {
      const artifact = catalogById.get(manifestArtifact.id);
      if (!artifact) {
        throw new StaticSiteBuildError(
          `El manifest referencia '${manifestArtifact.id}', pero el catálogo no lo contiene.`
        );
      }

      this.assertCatalogMatchesManifest(artifact, manifestArtifact);

      if (artifact.kind !== "html-fragment") {
        throw new StaticSiteBuildError(
          `El builder estático no puede procesar el tipo '${artifact.kind}' de '${artifact.id}'.`
        );
      }

      let materialized;
      try {
        materialized = request.providers.read(artifact);
      } catch (error) {
        if (error instanceof ArtifactProviderError) {
          throw new StaticSiteBuildError(error.message);
        }
        throw error;
      }

      const calculatedDigest = calculateDigest(materialized.content);
      if (calculatedDigest !== artifact.integrity.digest) {
        throw new StaticSiteBuildError(
          `El digest de '${artifact.id}' no coincide con el catálogo.`
        );
      }

      if (calculatedDigest !== manifestArtifact.digest) {
        throw new StaticSiteBuildError(
          `El digest de '${artifact.id}' no coincide con el manifest.`
        );
      }

      materializedArtifacts.push({
        id: artifact.id,
        digest: calculatedDigest,
        bytes: materialized.content.length,
        provider: materialized.provider,
      });
      sections.push(
        `<section data-artifact-id="${escapeHtml(artifact.id)}">\n${materialized.content.toString("utf8")}\n</section>`
      );
    });

    const outputDirectory = path.resolve(request.outputDirectory);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const indexPath = path.join(outputDirectory, "index.html");
    const metadataPath = path.join(outputDirectory, "build-metadata.json");
    const productName = escapeHtml(request.manifest.product.id);
    const manifestId = escapeHtml(request.manifest.manifestId);
    const html = [
      "<!doctype html>",
      '<html lang="es">',
      "<head>",
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${productName}</title>`,
      "</head>",
      "<body>",
      "  <main>",
      `    <h1>${productName}</h1>`,
      `    <p data-manifest-id="${manifestId}">Producto derivado desde un manifest versionado.</p>`,
      sections.join("\n"),
      "  </main>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
    const metadata = {
      manifestId: request.manifest.manifestId,
      productId: request.manifest.product.id,
      artifactCount: materializedArtifacts.length,
      artifacts: materializedArtifacts,
    };

    writeAtomically(indexPath, html);
    writeAtomically(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    return {
      outputDirectory,
      indexPath,
      metadataPath,
      artifacts: materializedArtifacts,
    };
  }

  private assertStaticBuildPlan(manifest: DeploymentManifest): void {
    const staticBuildOperations = manifest.operations.filter(
      (operation) =>
        (operation.type === "generate" || operation.type === "build") &&
        operation.adapter === "static-site-v1"
    );

    if (staticBuildOperations.length !== 2) {
      throw new StaticSiteBuildError(
        "El manifest no contiene el plan generate/build requerido para static-site-v1."
      );
    }
  }

  private assertCatalogMatchesManifest(
    catalogArtifact: Artifact,
    manifestArtifact: DeploymentManifest["artifacts"][number]
  ): void {
    if (catalogArtifact.version !== manifestArtifact.version) {
      throw new StaticSiteBuildError(
        `La versión de '${catalogArtifact.id}' difiere entre catálogo y manifest.`
      );
    }
    if (catalogArtifact.integrity.digest !== manifestArtifact.digest) {
      throw new StaticSiteBuildError(
        `El digest de '${catalogArtifact.id}' difiere entre catálogo y manifest.`
      );
    }
  }
}
