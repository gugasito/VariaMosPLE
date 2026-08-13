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
      `The path for artifact '${artifact.id}' is not safe and relative.`
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
        `Git artifact '${artifact.id}' does not declare an immutable reference.`
      );
    }

    const repositoryPath = this.options.repositories[artifact.source.location];
    if (!repositoryPath) {
      throw new ArtifactProviderError(
        `No checkout is registered for '${artifact.source.location}'.`
      );
    }

    if (!fs.existsSync(repositoryPath)) {
      throw new ArtifactProviderError(
        `The checkout registered for '${artifact.source.location}' does not exist.`
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
        `Could not read '${artifact.id}' from '${artifact.source.ref}:${artifactPath}': ${message}`
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
          `Checkout '${repositoryPath}' does not match the expected remote '${expectedLocation}'.`
        );
      }
    } catch (error) {
      if (error instanceof ArtifactProviderError) {
        throw error;
      }
      throw new ArtifactProviderError(
        `Could not verify the remote for checkout '${repositoryPath}'.`
      );
    }
  }
}
