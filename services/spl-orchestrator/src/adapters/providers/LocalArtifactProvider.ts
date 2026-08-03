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
      `The path for local artifact '${artifact.id}' is not safe and relative.`
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
        `No local root is registered for '${artifact.source.location}'.`
      );
    }

    const artifactPath = assertSafeRelativePath(artifact);
    const rootPath = path.resolve(root);
    const fullPath = path.resolve(rootPath, artifactPath);

    if (!fullPath.startsWith(`${rootPath}${path.sep}`)) {
      throw new ArtifactProviderError(
        `Resolving '${artifact.id}' attempts to leave the authorized local root.`
      );
    }

    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > this.maxArtifactBytes) {
        throw new ArtifactProviderError(
          `Artifact '${artifact.id}' exceeds the ${this.maxArtifactBytes}-byte limit.`
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
        `Could not read local artifact '${artifact.id}': ${message}`
      );
    }
  }
}
