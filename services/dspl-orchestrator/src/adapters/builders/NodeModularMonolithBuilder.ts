import crypto from "crypto";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { Artifact, ArtifactCatalog, DeploymentManifest } from "../../contracts";
import { ArtifactProviderRegistry } from "../providers/ArtifactProvider";

export interface NodeModularMonolithBuildRequest {
  manifest: DeploymentManifest;
  catalog: ArtifactCatalog;
  providers: ArtifactProviderRegistry;
  outputDirectory: string;
}

export interface NodeModularMonolithBuildResult {
  outputDirectory: string;
  runtimePath: string;
  metadataPath: string;
  artifacts: Array<{ id: string; digest: string; bytes: number; provider: string }>;
}

export class NodeModularMonolithBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeModularMonolithBuildError";
    Object.setPrototypeOf(this, NodeModularMonolithBuildError.prototype);
  }
}

function digest(content: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function safeOutputPath(entrypoint: string, artifactId: string): string {
  if (!entrypoint || path.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes("..") || !entrypoint.startsWith("src/")) {
    throw new NodeModularMonolithBuildError(
      `El artefacto '${artifactId}' no declara un entrypoint seguro bajo src/.`
    );
  }
  return entrypoint;
}

function writeFile(fileName: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, content);
}

function importPath(from: string, to: string): string {
  const relative = path.posix.relative(path.posix.dirname(from), to.replace(/\\/g, "/")).replace(/\.ts$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export class NodeModularMonolithBuilder {
  public build(request: NodeModularMonolithBuildRequest): NodeModularMonolithBuildResult {
    const buildOperations = request.manifest.operations.filter(
      (operation) => (operation.type === "generate" || operation.type === "build") && operation.adapter === "node-modular-monolith-v1"
    );
    if (buildOperations.length !== 2) {
      throw new NodeModularMonolithBuildError(
        "El manifest no contiene generate/build para node-modular-monolith-v1."
      );
    }

    const catalogById = new Map(request.catalog.artifacts.map((artifact) => [artifact.id, artifact]));
    const outputDirectory = path.resolve(request.outputDirectory);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    const sourceRoot = path.join(outputDirectory, "src");
    const materialized: NodeModularMonolithBuildResult["artifacts"] = [];
    const moduleEntrypoints: Array<{ artifactId: string; entrypoint: string }> = [];

    request.manifest.artifacts.forEach((manifestArtifact) => {
      const artifact = catalogById.get(manifestArtifact.id);
      if (!artifact) throw new NodeModularMonolithBuildError(`El catálogo no contiene '${manifestArtifact.id}'.`);
      this.assertArtifact(artifact, manifestArtifact);
      const entrypoint = safeOutputPath(artifact.build.entrypoint || "", artifact.id);
      const materializedArtifact = request.providers.read(artifact);
      const actualDigest = digest(materializedArtifact.content);
      if (actualDigest !== artifact.integrity.digest || actualDigest !== manifestArtifact.digest) {
        throw new NodeModularMonolithBuildError(`El digest de '${artifact.id}' no coincide con catálogo o manifest.`);
      }
      writeFile(path.join(outputDirectory, entrypoint), materializedArtifact.content);
      materialized.push({
        id: artifact.id,
        digest: actualDigest,
        bytes: materializedArtifact.content.length,
        provider: materializedArtifact.provider,
      });
      if (artifact.kind === "module") moduleEntrypoints.push({ artifactId: artifact.id, entrypoint });
    });

    const registryPath = "src/runtime/generated/registry.ts";
    const imports = moduleEntrypoints
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
      .map((module, index) =>
        `import { portalModule as module${index} } from "${importPath(registryPath, module.entrypoint)}";`
      );
    const registry = [
      ...imports,
      "",
      `export const enabledFeatures = ${JSON.stringify(request.manifest.features.filter((feature) => feature.selected).map((feature) => feature.id), null, 2)} as const;`,
      `export const portalModules = [${moduleEntrypoints.map((_module, index) => `module${index}`).join(", ")}];`,
      "",
    ].join("\n");
    writeFile(path.join(outputDirectory, registryPath), registry);

    const sourceFiles = this.findSourceFiles(sourceRoot);
    sourceFiles.forEach((sourceFile) => {
      const source = fs.readFileSync(sourceFile, "utf8");
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
          strict: true,
        },
        fileName: sourceFile,
        reportDiagnostics: true,
      });
      const diagnostics = (transpiled.diagnostics || []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
      );
      if (diagnostics.length > 0) {
        throw new NodeModularMonolithBuildError(
          `No se pudo transpilar '${sourceFile}': ${diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, " ")).join(" | ")}`
        );
      }
      const relative = path.relative(sourceRoot, sourceFile).replace(/\.ts$/, ".js");
      writeFile(path.join(outputDirectory, "dist", relative), transpiled.outputText);
    });

    const runtimePath = path.join(outputDirectory, "dist/runtime/server.js");
    if (!fs.existsSync(runtimePath)) {
      throw new NodeModularMonolithBuildError("El producto monolítico no contiene src/runtime/server.ts.");
    }
    const metadataPath = path.join(outputDirectory, "build-metadata.json");
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify({ manifestId: request.manifest.manifestId, productId: request.manifest.product.id, artifacts: materialized }, null, 2)}\n`,
      "utf8"
    );
    return { outputDirectory, runtimePath, metadataPath, artifacts: materialized };
  }

  private assertArtifact(artifact: Artifact, manifestArtifact: DeploymentManifest["artifacts"][number]): void {
    if (!["source-bundle", "module", "configuration", "test-suite"].includes(artifact.kind)) {
      throw new NodeModularMonolithBuildError(`node-modular-monolith-v1 no admite '${artifact.kind}'.`);
    }
    if (artifact.version !== manifestArtifact.version || artifact.integrity.digest !== manifestArtifact.digest) {
      throw new NodeModularMonolithBuildError(`El manifest no coincide con el catálogo para '${artifact.id}'.`);
    }
  }

  private findSourceFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return this.findSourceFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    });
  }
}
