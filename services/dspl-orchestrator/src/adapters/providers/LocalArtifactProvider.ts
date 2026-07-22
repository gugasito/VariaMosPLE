import fs from "fs";
import path from "path";
import { Artifact } from "../../contracts";
import {
  ArtifactProvider,
  ArtifactProviderError,
  MaterializedArtifact,
} from "./ArtifactProvider";

export interface LocalArtifactProviderOptions {
  roots: Record<string, string>;
  maxArtifactBytes?: number;
}

function assertSafeRelativePath(artifact: Artifact): string {
  const artifactPath = artifact.source.path;
  if (!artifactPath || path.isAbsolute(artifactPath) || artifactPath.split(/[\\/]/).includes("..")) {
    throw new ArtifactProviderError(
      `El path del artefacto local '${artifact.id}' no es relativo y seguro.`
    );
  }
  return artifactPath;
}

export class LocalArtifactProvider implements ArtifactProvider {
  public readonly provider = "local";
  private readonly maxArtifactBytes: number;

  constructor(private readonly options: LocalArtifactProviderOptions) {
    this.maxArtifactBytes = options.maxArtifactBytes || 5 * 1024 * 1024;
  }

  public read(artifact: Artifact): MaterializedArtifact {
    const root = this.options.roots[artifact.source.location];
    if (!root) {
      throw new ArtifactProviderError(
        `No existe una raíz local registrada para '${artifact.source.location}'.`
      );
    }

    const artifactPath = assertSafeRelativePath(artifact);
    const rootPath = path.resolve(root);
    const fullPath = path.resolve(rootPath, artifactPath);

    if (!fullPath.startsWith(`${rootPath}${path.sep}`)) {
      throw new ArtifactProviderError(
        `La resolución de '${artifact.id}' intenta salir de la raíz local autorizada.`
      );
    }

    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > this.maxArtifactBytes) {
        throw new ArtifactProviderError(
          `El artefacto '${artifact.id}' supera el límite de ${this.maxArtifactBytes} bytes.`
        );
      }

      return {
        artifactId: artifact.id,
        content: fs.readFileSync(fullPath),
        provider: this.provider,
        sourceLocation: artifact.source.location,
      };
    } catch (error) {
      if (error instanceof ArtifactProviderError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ArtifactProviderError(
        `No se pudo leer el artefacto local '${artifact.id}': ${message}`
      );
    }
  }
}
