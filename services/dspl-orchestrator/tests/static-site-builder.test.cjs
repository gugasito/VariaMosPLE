const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ArtifactProviderRegistry,
} = require("../dist/adapters/providers/ArtifactProvider.js");
const {
  GitArtifactProvider,
} = require("../dist/adapters/providers/GitArtifactProvider.js");
const {
  LocalArtifactProvider,
} = require("../dist/adapters/providers/LocalArtifactProvider.js");
const {
  StaticSiteBuilder,
  StaticSiteBuildError,
} = require("../dist/adapters/builders/StaticSiteBuilder.js");

function digest(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function createGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-dspl-git-"));
  const remote = "https://example.invalid/project-assets.git";
  const relativePath = "assets/card.html";
  const content = Buffer.from('<article class="card">Proyecto externo</article>\n', "utf8");

  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "tests@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "DSPL Tests"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, relativePath), content);
  execFileSync("git", ["-C", root, "add", relativePath]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"], { stdio: "ignore" });
  const ref = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  return { root, remote, relativePath, content, ref };
}

function createBuildFixture() {
  const gitFixture = createGitFixture();
  const artifact = {
    schemaVersion: "artifact/v1",
    id: "external-project.card",
    kind: "html-fragment",
    version: "1.0.0",
    source: {
      provider: "git",
      location: gitFixture.remote,
      ref: gitFixture.ref,
      path: gitFixture.relativePath,
    },
    integrity: {
      algorithm: "sha256",
      digest: digest(gitFixture.content),
    },
    build: { adapter: "static-fragment-v1", entrypoint: null },
    requiresCapabilities: ["static-http"],
  };
  const catalog = {
    schemaVersion: "artifact-catalog/v1",
    id: "external-project.catalog",
    version: "1.0.0",
    derivation: { builderAdapter: "static-site-v1", testAdapter: "html-validation-v1" },
    artifacts: [artifact],
  };
  const manifest = {
    schemaVersion: "spl-deployment-manifest/v1",
    manifestId: "manifest.external-project.configuration-001",
    product: { id: "external-project", configurationId: "configuration-001" },
    sourceModel: { projectId: "project.external", modelId: "model.external", version: "1" },
    features: [{ id: "feature.card", selected: true }],
    artifacts: [{ id: artifact.id, version: artifact.version, digest: artifact.integrity.digest }],
    operations: [
      { type: "generate", adapter: "static-site-v1" },
      { type: "build", adapter: "static-site-v1" },
      { type: "test", adapter: "html-validation-v1" },
      { type: "deploy", adapter: "nginx-container-v1" },
      { type: "verify", adapter: "http-health-check-v1" },
    ],
    target: { id: "lab-local" },
    verification: [{ type: "http-health-check", path: "/" }],
    rollback: { strategy: "previous-successful-release" },
  };
  const providers = new ArtifactProviderRegistry([
    new GitArtifactProvider({ repositories: { [gitFixture.remote]: gitFixture.root } }),
    new LocalArtifactProvider({ roots: {} }),
  ]);

  return {
    gitFixture,
    artifact,
    catalog,
    manifest,
    providers,
    outputDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "variamos-dspl-build-")),
  };
}

test("el provider Git lee un archivo desde un commit exacto sin cambiar el checkout", () => {
  const fixture = createBuildFixture();
  const materialized = fixture.providers.read(fixture.artifact);

  assert.deepEqual(materialized.content, fixture.gitFixture.content);
  assert.equal(materialized.sourceReference, fixture.gitFixture.ref);
  assert.equal(
    execFileSync("git", ["-C", fixture.gitFixture.root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    fixture.gitFixture.ref
  );
});

test("el provider local solo lee artefactos dentro de raíces registradas", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-dspl-local-"));
  fs.writeFileSync(path.join(root, "fragment.html"), "<p>Local</p>");
  const provider = new LocalArtifactProvider({ roots: { "local-fixture": root } });
  const artifact = {
    id: "local.fragment",
    source: { provider: "local", location: "local-fixture", path: "fragment.html" },
  };

  const materialized = provider.read(artifact);
  assert.equal(materialized.content.toString("utf8"), "<p>Local</p>");
});

test("el builder estático verifica el digest y construye index.html con metadata", () => {
  const fixture = createBuildFixture();
  const result = new StaticSiteBuilder().build({
    manifest: fixture.manifest,
    catalog: fixture.catalog,
    providers: fixture.providers,
    outputDirectory: fixture.outputDirectory,
  });

  const html = fs.readFileSync(result.indexPath, "utf8");
  const metadata = JSON.parse(fs.readFileSync(result.metadataPath, "utf8"));

  assert.match(html, /Proyecto externo/);
  assert.match(html, /data-artifact-id="external-project.card"/);
  assert.equal(metadata.manifestId, fixture.manifest.manifestId);
  assert.deepEqual(metadata.artifacts, [
    {
      id: "external-project.card",
      digest: fixture.artifact.integrity.digest,
      bytes: fixture.gitFixture.content.length,
      provider: "git",
    },
  ]);
});

test("el builder rechaza contenido que no coincide con el digest del manifest", () => {
  const fixture = createBuildFixture();
  fixture.manifest.artifacts[0].digest = `sha256:${"0".repeat(64)}`;

  assert.throws(
    () =>
      new StaticSiteBuilder().build({
        manifest: fixture.manifest,
        catalog: fixture.catalog,
        providers: fixture.providers,
        outputDirectory: fixture.outputDirectory,
      }),
    (error) => {
      assert.equal(error instanceof StaticSiteBuildError, true);
      assert.match(error.message, /difiere entre catálogo y manifest/);
      return true;
    }
  );
});
