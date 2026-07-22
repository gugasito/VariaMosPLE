import { Artifact } from "../../contracts";

export interface MaterializedArtifact {
  artifactId: string;
  content: Buffer;
  provider: string;
  sourceLocation: string;
  sourceReference?: string;
}

export interface ArtifactProvider {
  readonly provider: string;
  read(artifact: Artifact): MaterializedArtifact;
}

export class ArtifactProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactProviderError";
    Object.setPrototypeOf(this, ArtifactProviderError.prototype);
  }
}

export class ArtifactProviderRegistry {
  private readonly providers = new Map<string, ArtifactProvider>();

  constructor(providers: ArtifactProvider[]) {
    providers.forEach((provider) => this.register(provider));
  }

  public register(provider: ArtifactProvider): void {
    if (this.providers.has(provider.provider)) {
      throw new ArtifactProviderError(
        `El provider '${provider.provider}' ya está registrado.`
      );
    }
    this.providers.set(provider.provider, provider);
  }

  public read(artifact: Artifact): MaterializedArtifact {
    const provider = this.providers.get(artifact.source.provider);
    if (!provider) {
      throw new ArtifactProviderError(
        `No existe un provider registrado para '${artifact.source.provider}'.`
      );
    }
    return provider.read(artifact);
  }
}
