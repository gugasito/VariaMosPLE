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
          `The manifest references '${manifestArtifact.id}', but the catalog does not contain it.`
        );
      }

      this.assertCatalogMatchesManifest(artifact, manifestArtifact);

      if (artifact.kind !== "html-fragment") {
        throw new StaticSiteBuildError(
          `The static builder cannot process type '${artifact.kind}' for '${artifact.id}'.`
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
          `The digest for '${artifact.id}' does not match the catalog.`
        );
      }

      if (calculatedDigest !== manifestArtifact.digest) {
        throw new StaticSiteBuildError(
          `The digest for '${artifact.id}' does not match the manifest.`
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
      `    <p data-manifest-id="${manifestId}">Product derived from a versioned manifest.</p>`,
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
        "The manifest does not contain the generate/build plan required by static-site-v1."
      );
    }
  }

  private assertCatalogMatchesManifest(
    catalogArtifact: Artifact,
    manifestArtifact: DeploymentManifest["artifacts"][number]
  ): void {
    if (catalogArtifact.version !== manifestArtifact.version) {
      throw new StaticSiteBuildError(
        `The version of '${catalogArtifact.id}' differs between the catalog and manifest.`
      );
    }
    if (catalogArtifact.integrity.digest !== manifestArtifact.digest) {
      throw new StaticSiteBuildError(
        `The digest of '${catalogArtifact.id}' differs between the catalog and manifest.`
      );
    }
  }
}
