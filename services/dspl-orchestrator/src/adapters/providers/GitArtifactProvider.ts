import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { Artifact } from "../../contracts";
import {
  ArtifactProvider,
  ArtifactProviderError,
  MaterializedArtifact,
} from "./ArtifactProvider";

export interface GitArtifactProviderOptions {
  repositories: Record<string, string>;
  maxArtifactBytes?: number;
}

function normalizeRemote(value: string): string {
  return value.trim().replace(/\/$/, "").replace(/\.git$/, "");
}

function assertSafeRelativePath(artifact: Artifact): string {
  const artifactPath = artifact.source.path;
  if (!artifactPath || path.isAbsolute(artifactPath) || artifactPath.split(/[\\/]/).includes("..")) {
    throw new ArtifactProviderError(
      `El path del artefacto '${artifact.id}' no es relativo y seguro.`
    );
  }
  return artifactPath;
}

export class GitArtifactProvider implements ArtifactProvider {
  public readonly provider = "git";
  private readonly maxArtifactBytes: number;

  constructor(private readonly options: GitArtifactProviderOptions) {
    this.maxArtifactBytes = options.maxArtifactBytes || 5 * 1024 * 1024;
  }

  public read(artifact: Artifact): MaterializedArtifact {
    if (!artifact.source.ref) {
      throw new ArtifactProviderError(
        `El artefacto Git '${artifact.id}' no declara una referencia inmutable.`
      );
    }

    const repositoryPath = this.options.repositories[artifact.source.location];
    if (!repositoryPath) {
      throw new ArtifactProviderError(
        `No existe un checkout registrado para '${artifact.source.location}'.`
      );
    }

    if (!fs.existsSync(repositoryPath)) {
      throw new ArtifactProviderError(
        `El checkout registrado para '${artifact.source.location}' no existe.`
      );
    }

    const artifactPath = assertSafeRelativePath(artifact);
    this.assertExpectedRemote(repositoryPath, artifact.source.location);

    try {
      const content = execFileSync(
        "git",
        ["-C", repositoryPath, "show", `${artifact.source.ref}:${artifactPath}`],
        {
          encoding: "buffer",
          maxBuffer: this.maxArtifactBytes,
          windowsHide: true,
        }
      ) as Buffer;

      return {
        artifactId: artifact.id,
        content,
        provider: this.provider,
        sourceLocation: artifact.source.location,
        sourceReference: artifact.source.ref,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ArtifactProviderError(
        `No se pudo leer '${artifact.id}' desde '${artifact.source.ref}:${artifactPath}': ${message}`
      );
    }
  }

  private assertExpectedRemote(repositoryPath: string, expectedLocation: string): void {
    try {
      const origin = execFileSync(
        "git",
        ["-C", repositoryPath, "config", "--get", "remote.origin.url"],
        { encoding: "utf8", windowsHide: true }
      );

      if (normalizeRemote(origin) !== normalizeRemote(expectedLocation)) {
        throw new ArtifactProviderError(
          `El checkout '${repositoryPath}' no corresponde al remoto esperado '${expectedLocation}'.`
        );
      }
    } catch (error) {
      if (error instanceof ArtifactProviderError) {
        throw error;
      }
      throw new ArtifactProviderError(
        `No se pudo verificar el remoto del checkout '${repositoryPath}'.`
      );
    }
  }
}
