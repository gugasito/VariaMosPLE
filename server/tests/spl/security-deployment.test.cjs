const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DeploymentTargetAdapterRegistry,
  RemoteDeploymentError,
} = require("../../dist/spl/adapters/deployers/DeploymentTargetAdapter.js");
const {
  SshComposeDeployer,
  calculateDirectoryDigest,
} = require("../../dist/spl/adapters/deployers/SshComposeDeployer.js");
const {
  GitHttpsAuthenticationAdapter,
  GitSshAuthenticationAdapter,
} = require("../../dist/spl/adapters/providers/SourceAuthentication.js");
const { DeploymentJobService } = require("../../dist/spl/application/DeploymentJobService.js");
const { DeploymentTargetService } = require("../../dist/spl/application/DeploymentTargetService.js");
const { SecureStateRepository } = require("../../dist/spl/security/AtomicStateStore.js");
const { VariaMosProjectAuthorizer } = require("../../dist/spl/security/Authorization.js");
const { AuthorizationError } = require("../../dist/spl/security/Authorization.js");
const {
  createSplHttpHandler,
} = require("../../dist/spl/SplHttpServer.js");
const { loadUnifiedServerConfig } = require("../../dist/config.js");
const {
  CredentialBroker,
  CredentialProviderRegistry,
  MacOsKeychainCredentialProvider,
  validateCredentialPayload,
} = require("../../dist/spl/security/CredentialBroker.js");
const { HostPolicy } = require("../../dist/spl/security/HostPolicy.js");
const { SafeAuditLogger } = require("../../dist/spl/security/SafeAuditLogger.js");

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-secure-deployment-test-"));
  const auditPath = path.join(root, "audit", "events.jsonl");
  const audit = new SafeAuditLogger({ sink: "file", filePath: auditPath });
  const repository = new SecureStateRepository(path.join(root, "state"));
  const values = {
    current: "version-1",
    returnedVersion: undefined,
    describeError: undefined,
    getError: undefined,
    tags: {
      "variamos:projectId": "project-secure",
      "variamos:purpose": "deployment",
      "variamos:credentialType": "ssh-deployment-v1",
    },
    stages: undefined,
    payloads: {
      "version-1": JSON.stringify({
        schemaVersion: "ssh-deployment/v1",
        username: "variamos-deploy",
        privateKey: PRIVATE_KEY,
      }),
    },
  };
  const provider = {
    id: "aws-secrets-manager",
    async describeSecret() {
      if (values.describeError) throw values.describeError;
      return {
        tags: values.tags,
        versionIdsToStages: values.stages || {
          [values.current]: ["AWSCURRENT"],
        },
      };
    },
    async getSecretValue(_secretId, options) {
      if (values.getError) throw values.getError;
      const versionId = values.returnedVersion || options.versionId || values.current;
      return { versionId, secretString: values.payloads[versionId] };
    },
  };
  const broker = new CredentialBroker({
    repository,
    providers: new CredentialProviderRegistry([provider]),
    audit,
    allowDeploymentCredentials: true,
  });
  const actor = {
    userId: "owner-1",
    role: "owner",
    projectId: "project-secure",
  };
  return {
    root,
    audit,
    auditPath,
    repository,
    values,
    provider,
    broker,
    actor,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function apiRequest(server, options) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: options.method || (payload ? "POST" : "GET"),
      path: options.path,
      headers: {
        ...(payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {}),
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: raw ? JSON.parse(raw) : undefined,
      }));
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

test("credential payload schemas are strict and the broker never publishes AWS identifiers or values", async () => {
  const state = fixture();
  try {
    assert.throws(
      () => validateCredentialPayload(JSON.stringify({
        schemaVersion: "git-https-token/v1",
        username: "git",
        token: "token-value",
        extra: "blocked",
      }), "git-https-token-v1"),
      /additional fields/
    );
    const binding = await state.broker.register(state.actor, {
      id: "deploy-key",
      alias: "Production deploy key",
      purpose: "deployment",
      credentialType: "ssh-deployment-v1",
      externalSecretId: "arn:aws:secretsmanager:region:account:secret:project-secure",
      subject: { kind: "deployment-target", id: "remote-web" },
    });
    const serialized = JSON.stringify(binding);
    assert.equal(serialized.includes("externalSecretId"), false);
    assert.equal(serialized.includes("arn:aws"), false);
    assert.equal(serialized.includes("PRIVATE KEY"), false);

    state.values.tags = {
      ...state.values.tags,
      "variamos:projectId": "another-project",
    };
    await assert.rejects(
      state.broker.resolve(
        "project-secure",
        binding.ref,
        "deployment",
        ["ssh-deployment-v1"],
        { actorId: "owner-1" }
      ),
      /tags do not match/
    );
    state.values.tags = {
      ...state.values.tags,
      "variamos:projectId": "project-secure",
    };
    state.values.getError = new Error("simulated AWS outage with sensitive provider details");
    await assert.rejects(
      state.broker.resolve(
        "project-secure",
        binding.ref,
        "deployment",
        ["ssh-deployment-v1"],
        { actorId: "owner-1" }
      ),
      /could not be obtained/
    );
    state.values.getError = undefined;
    state.values.returnedVersion = "unexpected-version";
    await assert.rejects(
      state.broker.resolve(
        "project-secure",
        binding.ref,
        "deployment",
        ["ssh-deployment-v1"],
        { actorId: "owner-1" }
      ),
      /different secret version/
    );
    state.values.returnedVersion = undefined;
    state.values.stages = { "version-1": [] };
    await assert.rejects(
      state.broker.validateCurrent(state.actor, "deploy-key"),
      /AWSCURRENT/
    );
    state.values.stages = undefined;

    state.values.current = "version-2";
    state.values.payloads["version-2"] = JSON.stringify({
      schemaVersion: "ssh-deployment/v1",
      username: "variamos-deploy",
      privateKey: PRIVATE_KEY,
      unexpected: "blocked",
    });
    await assert.rejects(
      state.broker.validateCurrent(state.actor, "deploy-key"),
      /additional fields/
    );
    assert.equal(state.repository.getBinding("project-secure", "deploy-key").activeVersionId, "version-1");

    state.values.payloads["version-2"] = JSON.stringify({
      schemaVersion: "ssh-deployment/v1",
      username: "variamos-deploy",
      privateKey: PRIVATE_KEY,
    });
    await assert.rejects(
      state.broker.validateCurrent(state.actor, "deploy-key", async () => {
        throw new Error("new public key is not installed");
      }),
      /not installed/
    );
    assert.equal(state.repository.getBinding("project-secure", "deploy-key").activeVersionId, "version-1");

    const rotated = await state.broker.validateCurrent(state.actor, "deploy-key");
    assert.equal(rotated.activeVersionId, "version-2");
    const revoked = state.broker.revoke(state.actor, "deploy-key");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.externalRevocationConfirmedAt, undefined);
    await assert.rejects(
      state.broker.resolve(
        "project-secure",
        revoked.ref,
        "deployment",
        ["ssh-deployment-v1"],
        { actorId: "owner-1" }
      ),
      /inactive, or revoked/
    );
    const confirmed = state.broker.confirmExternalRevocation(state.actor, "deploy-key");
    assert.ok(confirmed.externalRevocationConfirmedAt);

    const audit = fs.readFileSync(state.auditPath, "utf8");
    assert.equal(audit.includes(PRIVATE_KEY), false);
    assert.equal(audit.includes("arn:aws"), false);
    assert.equal(fs.statSync(state.auditPath).mode & 0o777, 0o600);
    const events = audit.trim().split("\n").map(JSON.parse);
    assert.equal(events.every((event, index) =>
      index === 0
        ? event.previousHash === "0".repeat(64)
        : event.previousHash === events[index - 1].eventHash
    ), true);
  } finally {
    state.cleanup();
  }
});

test("macOS Keychain references derive project tags and stable versions without exposing the secret", async () => {
  const secret = JSON.stringify({
    schemaVersion: "ssh-deployment/v1",
    username: "local-deployer",
    privateKey: PRIVATE_KEY,
  });
  let requestedAccount = "";
  const provider = new MacOsKeychainCredentialProvider({
    platform: "darwin",
    readSecret(account, service) {
      requestedAccount = account;
      assert.equal(service, "variamos-spl-local");
      return secret;
    },
  });
  const reference =
    "keychain://variamos-spl-local/project-secure/deployment/ssh-deployment-v1/local-mac-key";
  const description = await provider.describeSecret(reference);
  assert.equal(requestedAccount, "project-secure:deployment:ssh-deployment-v1:local-mac-key");
  assert.deepEqual(description.tags, {
    "variamos:projectId": "project-secure",
    "variamos:purpose": "deployment",
    "variamos:credentialType": "ssh-deployment-v1",
  });
  const value = await provider.getSecretValue(reference, { versionStage: "AWSCURRENT" });
  assert.match(value.versionId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.secretString, secret);
  assert.equal(JSON.stringify(description).includes(PRIVATE_KEY), false);
  await assert.rejects(
    provider.getSecretValue(reference, { versionId: `sha256:${"0".repeat(64)}` }),
    /no longer current/
  );
  await assert.rejects(
    provider.describeSecret(
      "keychain://variamos-spl-local/another-project/deployment/ssh-deployment-v1/local-mac-key?unsafe=1"
    ),
    /reference is invalid/
  );
});

test("project authorization fails closed for missing sessions and enforces owner/editor/viewer policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-auth-test-"));
  const audit = new SafeAuditLogger({ sink: "file", filePath: path.join(root, "audit.jsonl") });
  let role = "owner";
  let projectResponse = () => ({ data: { project: { role } } });
  const identity = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer valid-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.startsWith("/auth/session-info")) {
      response.end(JSON.stringify({ data: { user: { id: "user-1", name: "Owner" } } }));
    } else {
      response.end(JSON.stringify(projectResponse()));
    }
  });
  await new Promise((resolve) => identity.listen(0, "127.0.0.1", resolve));
  let identityClosed = false;
  try {
    const port = identity.address().port;
    const authorizer = new VariaMosProjectAuthorizer({
      sessionInfoUrl: `http://127.0.0.1:${port}/auth/session-info`,
      projectInfoUrl: `http://127.0.0.1:${port}/getProject`,
      audit,
    });
    const request = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
    await assert.rejects(
      authorizer.authorize(request(), "project-secure", "metadata:read"),
      (error) => error.statusCode === 401
    );
    await assert.rejects(
      authorizer.authorize(request("expired"), "project-secure", "metadata:read"),
      (error) => error.statusCode === 401
    );
    for (const action of [
      "metadata:read",
      "project:import",
      "derivation:plan",
      "derivation:build",
      "target:manage",
      "credential:manage",
      "deployment:manage",
    ]) {
      assert.equal(
        (await authorizer.authorize(request("valid-token"), "project-secure", action)).role,
        "owner"
      );
    }
    projectResponse = () => ({ data: { project: { owner_id: "user-1" } } });
    assert.equal(
      (await authorizer.authorize(request("valid-token"), "project-secure", "target:manage")).role,
      "owner"
    );
    role = "editor";
    projectResponse = () => ({ data: { project: { role } } });
    for (const action of ["metadata:read", "project:import", "derivation:plan", "derivation:build"]) {
      assert.equal(
        (await authorizer.authorize(request("valid-token"), "project-secure", action)).role,
        "editor"
      );
    }
    for (const action of ["target:manage", "credential:manage", "deployment:manage"]) {
      await assert.rejects(
        authorizer.authorize(request("valid-token"), "project-secure", action),
        (error) => error.statusCode === 403
      );
    }
    role = "viewer";
    await authorizer.authorize(request("valid-token"), "project-secure", "metadata:read");
    for (const action of [
      "project:import",
      "derivation:plan",
      "derivation:build",
      "target:manage",
      "credential:manage",
      "deployment:manage",
    ]) {
      await assert.rejects(
        authorizer.authorize(request("valid-token"), "project-secure", action),
        (error) => error.statusCode === 403
      );
    }
    await new Promise((resolve) => identity.close(resolve));
    identityClosed = true;
    await assert.rejects(
      authorizer.authorize(request("valid-token"), "project-secure", "metadata:read"),
      (error) => error.statusCode === 503
    );
  } finally {
    if (!identityClosed) await new Promise((resolve) => identity.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("host policy rejects private DNS results unless the resolved address is explicitly allowlisted", async () => {
  await assert.rejects(
    new HostPolicy(["localhost"], "test").authorize("localhost"),
    /internal address/
  );
  const authorized = await new HostPolicy(["localhost", "127.0.0.1", "::1"], "test").authorize("localhost");
  assert.equal(authorized.addresses.includes("127.0.0.1"), true);
});

test("secure features require authentication, allowlists and audit while password-only SSH can omit a Secret Manager", () => {
  const base = {
    outputRoot: "/tmp/variamos-startup-test/products",
    releaseStateDirectory: "/tmp/variamos-startup-test/releases",
    allowedOrigins: ["http://127.0.0.1:3000"],
  };
  const testAuthorizer = {
    async authorize(_request, projectId) {
      return { userId: "test-owner", role: "owner", projectId, token: "test-token" };
    },
    async reauthorize(actor, projectId) {
      return { ...actor, projectId };
    },
  };
  assert.throws(
    () => createSplHttpHandler(base),
    (error) =>
      /identity session URL/.test(error.message) &&
      /project permission URL/.test(error.message)
  );
  assert.throws(
    () => createSplHttpHandler({
      ...base,
      authorizer: testAuthorizer,
      remoteDeploymentEnabled: true,
      secretBackend: "macos-keychain",
      runtimePlatform: "darwin",
      nodeEnvironment: "test",
      gitHostAllowlist: ["127.0.0.1"],
      sshHostAllowlist: ["localhost", "127.0.0.1", "::1"],
      healthHostAllowlist: ["localhost", "127.0.0.1", "::1"],
    }),
    /SPL_LOCAL_MAC_SSH_TEST_MODE=true/
  );
  assert.throws(
    () => createSplHttpHandler({
      ...base,
      authorizer: testAuthorizer,
      remoteDeploymentEnabled: true,
      secretBackend: "macos-keychain",
      localMacSshTestMode: true,
      runtimePlatform: "darwin",
      nodeEnvironment: "production",
      gitHostAllowlist: ["127.0.0.1"],
      sshHostAllowlist: ["localhost", "127.0.0.1", "::1"],
      healthHostAllowlist: ["localhost", "127.0.0.1", "::1"],
    }),
    /non-production NODE_ENV/
  );
  assert.throws(
    () => createSplHttpHandler({
      ...base,
      authorizer: testAuthorizer,
      remoteDeploymentEnabled: true,
      secretBackend: "macos-keychain",
      localMacSshTestMode: true,
      runtimePlatform: "darwin",
      nodeEnvironment: "test",
      gitHostAllowlist: ["127.0.0.1"],
      sshHostAllowlist: ["127.0.0.1", "server.example.org"],
      healthHostAllowlist: ["127.0.0.1"],
    }),
    /loopback-only SPL_SSH_HOST_ALLOWLIST/
  );
  assert.throws(
    () => createSplHttpHandler({
      ...base,
      authorizer: testAuthorizer,
      remoteDeploymentEnabled: true,
    }),
    (error) =>
      /SPL_GIT_HOST_ALLOWLIST/.test(error.message) &&
      /SPL_SSH_HOST_ALLOWLIST/.test(error.message) &&
      /SPL_HEALTH_HOST_ALLOWLIST/.test(error.message)
  );
  assert.doesNotThrow(() => createSplHttpHandler({
    ...base,
    authorizer: testAuthorizer,
    remoteDeploymentEnabled: true,
    secretBackend: "none",
    gitHostAllowlist: ["127.0.0.1"],
    sshHostAllowlist: ["127.0.0.1"],
    healthHostAllowlist: ["127.0.0.1"],
  }));
  assert.throws(
    () => createSplHttpHandler({
      ...base,
      authorizer: testAuthorizer,
      secretBackend: "aws",
    }),
    (error) =>
      /SPL_AWS_REGION/.test(error.message) &&
      /SPL_GIT_HOST_ALLOWLIST/.test(error.message)
  );
  assert.throws(
    () => loadUnifiedServerConfig({
      workspaceRoot: "/tmp/variamos-startup-test",
      environment: { SPL_AUTH_MODE: "disabled" },
    }),
    /SPL_AUTH_MODE=disabled is not supported/
  );
});

test("private Git authentication keeps tokens out of URLs/arguments and verifies SSH fingerprints", async () => {
  const hostPolicy = new HostPolicy(["127.0.0.1"], "Git");
  let disposed = 0;
  const lease = (payload, type) => ({
    binding: {
      schemaVersion: "credential-binding/v1",
      id: "source-key",
      ref: "secret://projects/project-secure/source-key",
      projectId: "project-secure",
      alias: "Source key",
      provider: "aws-secrets-manager",
      purpose: "source-read",
      credentialType: type,
      subject: { kind: "source-connection", id: "source-repository" },
      activeVersionId: "version-1",
      status: "active",
      createdAt: new Date().toISOString(),
      createdBy: "owner-1",
    },
    versionId: "version-1",
    payload,
    dispose() { disposed += 1; },
  });
  const httpsLease = lease({
    schemaVersion: "git-https-token/v1",
    username: "git-user",
    token: "super-secret-token",
  }, "git-https-token-v1");
  const httpsBroker = {
    async resolve() { return httpsLease; },
  };
  const httpsAdapter = new GitHttpsAuthenticationAdapter(httpsBroker, hostPolicy);
  const httpsContext = await httpsAdapter.prepare({
    projectId: "project-secure",
    actorId: "owner-1",
    connectionId: "source-repository",
    repositoryUrl: "https://127.0.0.1/team/repository.git",
    credentialRef: httpsLease.binding.ref,
  });
  const httpsArguments = JSON.stringify(httpsContext.gitPrefixArguments);
  assert.equal(httpsArguments.includes("super-secret-token"), false);
  assert.equal(httpsArguments.includes("git-user"), false);
  assert.equal(fs.readFileSync(httpsContext.environment.GIT_ASKPASS, "utf8").includes("super-secret-token"), false);
  const httpsDirectory = path.dirname(httpsContext.environment.GIT_ASKPASS);
  httpsContext.dispose();
  assert.equal(httpsContext.environment.SPL_GIT_TOKEN, "");
  assert.equal(fs.existsSync(httpsDirectory), false);

  const hostKey = Buffer.from("fixture-ssh-host-key");
  const hostKeyBase64 = hostKey.toString("base64");
  const fingerprint = `SHA256:${require("node:crypto").createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
  const sshLease = lease({
    schemaVersion: "git-ssh-key/v1",
    username: "git",
    privateKey: PRIVATE_KEY,
    passphrase: "key-passphrase",
  }, "git-ssh-key-v1");
  const sshBroker = {
    async resolve() { return sshLease; },
  };
  const scanner = () => `127.0.0.1 ssh-ed25519 ${hostKeyBase64}\n`;
  const sshAdapter = new GitSshAuthenticationAdapter(sshBroker, hostPolicy, scanner);
  const sshContext = await sshAdapter.prepare({
    projectId: "project-secure",
    actorId: "owner-1",
    connectionId: "source-repository",
    repositoryUrl: "ssh://git@127.0.0.1/team/repository.git",
    credentialRef: sshLease.binding.ref,
    sshHostKeyFingerprint: fingerprint,
  });
  assert.equal(sshContext.environment.GIT_SSH_COMMAND.includes(PRIVATE_KEY), false);
  assert.equal(JSON.stringify(sshContext.gitPrefixArguments).includes("key-passphrase"), false);
  const sshDirectory = path.dirname(sshContext.environment.SSH_ASKPASS);
  sshContext.dispose();
  assert.equal(sshContext.environment.SPL_SSH_PASSPHRASE, "");
  assert.equal(fs.existsSync(sshDirectory), false);
  await assert.rejects(
    sshAdapter.prepare({
      projectId: "project-secure",
      actorId: "owner-1",
      connectionId: "source-repository",
      repositoryUrl: "ssh://git@127.0.0.1/team/repository.git",
      credentialRef: sshLease.binding.ref,
      sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    }),
    /does not match/
  );
  assert.equal(disposed >= 3, true);
});

test("ssh-compose uses fixed commands, verifies upload content, rolls back, and cleans up on cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-ssh-compose-test-"));
  try {
    const outputDirectory = path.join(root, "build");
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(outputDirectory + "/index.html", "<main data-manifest-id=\"manifest-new\">ok</main>\n");
    const fileDigest = crypto.createHash("sha256")
      .update(fs.readFileSync(outputDirectory + "/index.html"))
      .digest("hex");
    const outputDigest = calculateDirectoryDigest(outputDirectory);
    const commands = [];
    const writes = [];
    let ended = 0;
    const session = {
      async exec(command) {
        commands.push(command);
        if (command.includes("sha256sum")) return `${fileDigest}  ./index.html\n`;
        return "";
      },
      async uploadDirectory() {},
      async writeFile(remotePath, content, mode) {
        writes.push({ remotePath, content, mode });
      },
      end() { ended += 1; },
    };
    const target = {
      schemaVersion: "deployment-target-connection/v1",
      id: "remote-web",
      projectId: "project-secure",
      name: "Remote web",
      environment: "production",
      adapter: "ssh-compose-v1",
      endpoint: {
        host: "127.0.0.1",
        port: 22,
        sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
      remoteBasePath: "/srv/variamos/project-secure",
      publishedPort: 18080,
      publicBaseUrl: "http://127.0.0.1:18080/",
      images: {
        nginx: `nginx@sha256:${"a".repeat(64)}`,
      },
      capabilities: ["docker", "docker-compose", "static-http", "single-container"],
      authentication: { mode: "prompt-password", username: "variamos-deploy" },
      status: "active",
      revision: 1,
      createdAt: new Date().toISOString(),
      createdBy: "owner-1",
      updatedAt: new Date().toISOString(),
      updatedBy: "owner-1",
    };
    const build = {
      schemaVersion: "spl-build-record/v1",
      buildId: "build-new",
      projectId: "project-secure",
      manifest: {
        schemaVersion: "spl-deployment-manifest/v1",
        manifestId: "manifest-new",
        product: { id: "product-new", configurationId: "configuration-new" },
        sourceModel: { projectId: "project-secure", modelId: "model-new", version: "model-version-new" },
        features: [],
        artifacts: [],
        operations: [{ type: "deploy", adapter: "ssh-compose-v1" }],
        target: { id: "remote-web" },
        verification: [{ type: "http-health-check", path: "/" }],
        rollback: { strategy: "previous-successful-release" },
      },
      manifestDigest: `sha256:${"c".repeat(64)}`,
      planDigest: `sha256:${"d".repeat(64)}`,
      targetRef: "remote-web",
      targetRevision: 1,
      outputDirectory,
      outputDigest,
      tests: { status: "passed" },
      builderAdapter: "static-site-v1",
      createdAt: new Date().toISOString(),
      createdBy: "owner-1",
    };
    const credential = {
      payload: {
        schemaVersion: "ssh-password/v1",
        username: "variamos-deploy",
        password: "one-time-password",
      },
      dispose() {},
    };
    const previousRelease = {
      schemaVersion: "ssh-compose-release/v1",
      projectId: "project-secure",
      targetRef: "remote-web",
      releaseId: "release-old",
      manifestId: "manifest-old",
      builderAdapter: "static-site-v1",
      remoteDirectory: "/srv/variamos/project-secure/releases/release-old",
      composeProject: "variamos-project-secure-remote-web-old",
      publicUrl: "http://127.0.0.1:18080/",
      deployedAt: new Date().toISOString(),
    };
    const deployer = new SshComposeDeployer({
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      connector: async () => session,
      healthVerifier: async (_target, _url, manifestId) => {
        if (manifestId === "manifest-new") throw new Error("candidate health failed");
      },
    });
    let passwordConnectRequest;
    const passwordDeployer = new SshComposeDeployer({
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      connector: async (request) => {
        passwordConnectRequest = request;
        return {
          async exec() { return ""; },
          async uploadDirectory() {},
          async writeFile() {},
          end() {},
        };
      },
      healthVerifier: async () => {},
    });
    await passwordDeployer.validate({
      target: {
        ...target,
        authentication: { mode: "prompt-password", username: "legacy-deployer" },
        deploymentCredentialRef: undefined,
      },
      credential: {
        payload: {
          schemaVersion: "ssh-password/v1",
          username: "legacy-deployer",
          password: "one-time-password",
        },
        dispose() {},
      },
    });
    assert.equal(passwordConnectRequest.username, "legacy-deployer");
    assert.equal(passwordConnectRequest.password, "one-time-password");
    assert.equal(passwordConnectRequest.privateKey, undefined);
    let missingDirectorySessionEnded = false;
    const missingDirectoryDeployer = new SshComposeDeployer({
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      connector: async () => ({
        async exec(command) {
          if (command.startsWith("test -d ")) throw new Error("exit 1");
          return "";
        },
        async uploadDirectory() {},
        async writeFile() {},
        end() { missingDirectorySessionEnded = true; },
      }),
      healthVerifier: async () => {},
    });
    await assert.rejects(
      missingDirectoryDeployer.validate({
        target: {
          ...target,
          authentication: { mode: "prompt-password", username: "legacy-deployer" },
        },
        credential: {
          payload: {
            schemaVersion: "ssh-password/v1",
            username: "legacy-deployer",
            password: "one-time-password",
          },
          dispose() {},
        },
      }),
      (error) =>
        error.code === "REMOTE_DIRECTORY_MISSING" &&
        /directory does not exist on the SSH server/i.test(error.message)
    );
    assert.equal(missingDirectorySessionEnded, true);
    await assert.rejects(
      deployer.deploy({
        build,
        target,
        credential,
        executionId: "deploy-fixture",
        previousRelease,
        updateStage() {},
        isCancellationRequested: () => false,
      }),
      (error) =>
        error.code === "REMOTE_DEPLOYMENT_FAILED" &&
        error.rollback.attempted === true &&
        error.rollback.succeeded === true
    );
    assert.equal(ended, 1);
    assert.equal(commands.some((command) => command.includes(" compose ") && command.includes(" stop")), true);
    assert.equal(commands.some((command) => command.includes(" down --remove-orphans")), true);
    assert.equal(commands.some((command) => command.includes(previousRelease.composeProject) && command.includes(" up -d ")), true);
    assert.equal(JSON.stringify(commands).includes(PRIVATE_KEY), false);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].mode, 0o600);
    assert.equal(writes[0].content.includes(target.images.nginx), true);
    assert.equal(writes[0].content.includes("cap_drop:"), true);
    assert.equal(writes[0].content.includes("      - CHOWN"), true);
    assert.equal(writes[0].content.includes("      - DAC_OVERRIDE"), true);
    assert.equal(writes[0].content.includes("      - SETGID"), true);
    assert.equal(writes[0].content.includes("      - SETUID"), true);
    assert.equal(writes[0].content.includes("      - NET_BIND_SERVICE"), true);
    assert.equal(writes[0].content.includes("no-new-privileges:true"), true);
    assert.equal(
      writes[0].content.includes(
        `      - "${target.remoteBasePath}/releases/`
      ),
      true
    );
    assert.equal(
      writes[0].content.includes('/dist:/usr/share/nginx/html:ro"'),
      true
    );
    assert.equal(
      writes[0].content.includes('"/dist":/usr/share/nginx/html:ro'),
      false
    );

    const failedRollbackDeployer = new SshComposeDeployer({
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      connector: async () => ({
        async exec(command) {
          return command.includes("sha256sum") ? `${fileDigest}  ./index.html\n` : "";
        },
        async uploadDirectory() {},
        async writeFile() {},
        end() {},
      }),
      healthVerifier: async () => { throw new Error("health remains unavailable"); },
    });
    await assert.rejects(
      failedRollbackDeployer.deploy({
        build,
        target,
        credential,
        executionId: "deploy-rollback-failed",
        previousRelease,
        updateStage() {},
        isCancellationRequested: () => false,
      }),
      (error) =>
        error.rollback.attempted === true &&
        error.rollback.succeeded === false &&
        /health remains unavailable/.test(error.rollback.error)
    );

    const cancelledCommands = [];
    let cancelledEnded = false;
    const cancelledDeployer = new SshComposeDeployer({
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      connector: async () => ({
        async exec(command) { cancelledCommands.push(command); return ""; },
        async uploadDirectory() {},
        async writeFile() {},
        end() { cancelledEnded = true; },
      }),
      healthVerifier: async () => {},
    });
    await assert.rejects(
      cancelledDeployer.deploy({
        build,
        target,
        credential,
        executionId: "deploy-cancelled",
        updateStage() {},
        isCancellationRequested: () => true,
      }),
      (error) => error.code === "DEPLOYMENT_CANCELLED"
    );
    assert.equal(cancelledEnded, true);
    assert.equal(cancelledCommands.some((command) => command.startsWith("rm -rf -- ")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persisted in-flight jobs become interrupted after an orchestrator restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-job-restart-test-"));
  try {
    const repository = new SecureStateRepository(root);
    repository.putDeployment({
      schemaVersion: "spl-deployment-execution/v1",
      executionId: "deploy-restart-fixture",
      idempotencyKey: "restart-fixture-001",
      projectId: "project-secure",
      buildId: "build-fixture",
      targetRef: "remote-web",
      targetRevision: 1,
      expectedPlanDigest: `sha256:${"d".repeat(64)}`,
      status: "uploading",
      createdAt: new Date().toISOString(),
      createdBy: "owner-1",
      updatedAt: new Date().toISOString(),
    });
    const restarted = new SecureStateRepository(root);
    const execution = restarted.getDeployment("project-secure", "deploy-restart-fixture");
    assert.equal(execution.status, "interrupted");
    assert.equal(execution.errorCode, "ORCHESTRATOR_RESTARTED");
    assert.ok(execution.finishedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SSH passwords validate and deploy without entering persisted state or logs", async () => {
  const state = fixture();
  const password = "legacy-password-only-for-this-attempt";
  try {
    let validatedPassword = "";
    let deployedPassword = "";
    let deployedPayload;
    const adapter = {
      definition: {
        id: "ssh-compose-v1",
        name: "Fake SSH Compose",
        availability: "available",
        credentialTypes: [],
        capabilities: ["docker", "docker-compose", "static-http", "single-container"],
        authenticationModes: [],
        presets: [],
        configurationSchema: {},
      },
      async validate(context) {
        assert.equal(context.credential.payload.schemaVersion, "ssh-password/v1");
        validatedPassword = context.credential.payload.password;
      },
      async deploy(context) {
        deployedPayload = context.credential.payload;
        deployedPassword = context.credential.payload.password;
        return {
          status: "deployed",
          publicUrl: "http://127.0.0.1:18082/",
          release: {
            schemaVersion: "ssh-compose-release/v1",
            projectId: context.build.projectId,
            targetRef: context.target.id,
            releaseId: "release-password-fixture",
            manifestId: context.build.manifest.manifestId,
            builderAdapter: context.build.builderAdapter,
            remoteDirectory: "/srv/variamos/legacy/releases/release-password-fixture",
            composeProject: "variamos-password-fixture",
            publicUrl: "http://127.0.0.1:18082/",
            deployedAt: new Date().toISOString(),
          },
        };
      },
    };
    const adapters = new DeploymentTargetAdapterRegistry([adapter]);
    const targets = new DeploymentTargetService({
      repository: state.repository,
      adapters,
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      audit: state.audit,
      remoteEnabled: true,
    });
    const targetInput = {
      id: "legacy-ubuntu",
      name: "Legacy Ubuntu",
      adapter: "ssh-compose-v1",
      endpoint: {
        host: "127.0.0.1",
        port: 22,
        sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
      remoteBasePath: "/srv/variamos/legacy",
      publishedPort: 18082,
      publicBaseUrl: "http://127.0.0.1:18082/",
      images: { nginx: `nginx@sha256:${"a".repeat(64)}` },
      capabilities: ["docker", "docker-compose", "static-http", "single-container"],
      authentication: { mode: "prompt-password", username: "legacy-deployer" },
    };
    await assert.rejects(
      targets.validate(state.actor, targetInput),
      /Enter the SSH username and password/
    );
    await assert.rejects(
      targets.validate(state.actor, targetInput, undefined, {
        schemaVersion: "ssh-password/v1",
        username: "another-user",
        password,
      }),
      /username does not match/
    );
    const validationCredential = {
      schemaVersion: "ssh-password/v1",
      username: "legacy-deployer",
      password,
    };
    const target = await targets.create(state.actor, targetInput, validationCredential);
    assert.equal(validatedPassword, password);
    assert.equal(validationCredential.password, "");
    assert.deepEqual(target.authentication, { mode: "prompt-password", username: "legacy-deployer" });
    assert.equal("hasDeploymentCredential" in target, false);
    const storedTarget = state.repository.getTarget(state.actor.userId, "legacy-ubuntu");
    assert.equal(storedTarget.deploymentCredentialRef, undefined);
    assert.equal(JSON.stringify(storedTarget).includes(password), false);

    const build = {
      schemaVersion: "spl-build-record/v1",
      buildId: "build-password-fixture",
      projectId: "project-secure",
      manifest: {
        schemaVersion: "spl-deployment-manifest/v1",
        manifestId: "manifest-password-fixture",
        product: { id: "product-password", configurationId: "configuration-password" },
        sourceModel: { projectId: "project-secure", modelId: "model-password", version: "model-version-password" },
        features: [],
        artifacts: [],
        operations: [{ type: "deploy", adapter: "ssh-compose-v1" }],
        target: { id: "legacy-ubuntu" },
        verification: [{ type: "http-health-check", path: "/" }],
        rollback: { strategy: "previous-successful-release" },
      },
      manifestDigest: `sha256:${"c".repeat(64)}`,
      planDigest: `sha256:${"d".repeat(64)}`,
      targetRef: target.id,
      targetRevision: target.revision,
      outputDirectory: "/not-used-by-fake-adapter",
      outputDigest: `sha256:${"e".repeat(64)}`,
      tests: { status: "passed" },
      builderAdapter: "static-site-v1",
      createdAt: new Date().toISOString(),
      createdBy: "owner-1",
    };
    state.repository.putBuild(build);
    const jobs = new DeploymentJobService({
      repository: state.repository,
      targets,
      adapters,
      authorizer: {
        async authorize() { return state.actor; },
        async reauthorize() { return state.actor; },
      },
      audit: state.audit,
    });
    const deploymentInput = {
      projectId: "project-secure",
      buildId: build.buildId,
      targetRef: target.id,
      targetRevision: target.revision,
      expectedPlanDigest: build.planDigest,
      idempotencyKey: "deployment-password-fixture-001",
    };
    assert.throws(() => jobs.create(state.actor, deploymentInput), /Enter the SSH username and password/);
    const jobCredential = {
      schemaVersion: "ssh-password/v1",
      username: "legacy-deployer",
      password,
    };
    const queued = jobs.create(state.actor, { ...deploymentInput, ephemeralCredential: jobCredential });
    assert.equal(jobCredential.password, "");
    assert.equal(JSON.stringify(queued.execution).includes(password), false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(jobs.get("project-secure", queued.execution.executionId).status, "succeeded");
    assert.equal(deployedPassword, password);
    assert.equal(deployedPayload.password, "");
    assert.equal(fs.readFileSync(state.auditPath, "utf8").includes(password), false);
  } finally {
    state.cleanup();
  }
});

test("PEM credentials are validated ephemerally and are never persisted", async () => {
  const state = fixture();
  const privateKey = ["-----BEGIN PRIVATE KEY-----", "dGVzdC1wZW0ta2V5", "-----END PRIVATE KEY-----"].join("\n");
  try {
    let validated;
    const adapter = {
      definition: { id: "ssh-compose-v1", name: "Fake", availability: "available", credentialTypes: [], capabilities: ["docker", "docker-compose", "static-http", "single-container"], authenticationModes: [], presets: [], configurationSchema: {} },
      async validate(context) { validated = context.credential.payload; },
      async deploy() { throw new Error("not used"); },
    };
    const targets = new DeploymentTargetService({ repository: state.repository, adapters: new DeploymentTargetAdapterRegistry([adapter]), sshHosts: new HostPolicy(["127.0.0.1"], "SSH"), healthHosts: new HostPolicy(["127.0.0.1"], "health"), audit: state.audit, remoteEnabled: true });
    const input = { id: "pem-target", name: "PEM target", adapter: "ssh-compose-v1", endpoint: { host: "127.0.0.1", port: 22, sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}` }, remoteBasePath: "/srv/variamos/pem", publishedPort: 18082, publicBaseUrl: "http://127.0.0.1:18082/", images: { nginx: `nginx@sha256:${"a".repeat(64)}` }, capabilities: ["docker", "docker-compose", "static-http", "single-container"], authentication: { mode: "prompt-pem", username: "deployer" } };
    const credential = { schemaVersion: "ssh-pem/v1", username: "deployer", privateKey, passphrase: "temporary-passphrase" };
    const target = await targets.create(state.actor, input, credential);
    assert.equal(validated.schemaVersion, "ssh-pem/v1");
    assert.deepEqual(target.authentication, { mode: "prompt-pem", username: "deployer" });
    assert.equal(credential.privateKey, "");
    assert.equal(credential.passphrase, "");
    const persisted = JSON.stringify(state.repository.getTarget(state.actor.userId, "pem-target"));
    assert.equal(persisted.includes(privateKey), false);
    assert.equal(persisted.includes("temporary-passphrase"), false);
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});

test("targets are project-scoped and jobs are idempotent with one active execution per target", async () => {
  const state = fixture();
  try {
    let deploymentCalls = 0;
    const adapter = {
      definition: {
        id: "ssh-compose-v1",
        name: "Fake SSH Compose",
        availability: "available",
        credentialTypes: [],
        capabilities: ["docker", "docker-compose", "static-http", "single-container"],
        configurationSchema: {},
      },
      async validate() {},
      async deploy(context) {
        deploymentCalls += 1;
        context.updateStage("deploying", "Deploying fixture.");
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          status: "deployed",
          publicUrl: "http://127.0.0.1:18080/",
          release: {
            schemaVersion: "ssh-compose-release/v1",
            projectId: context.build.projectId,
            targetRef: context.target.id,
            releaseId: "release-fixture",
            manifestId: context.build.manifest.manifestId,
            builderAdapter: context.build.builderAdapter,
            remoteDirectory: "/srv/variamos/project-secure/releases/release-fixture",
            composeProject: "variamos-fixture",
            publicUrl: "http://127.0.0.1:18080/",
            deployedAt: new Date().toISOString(),
          },
        };
      },
    };
    const adapters = new DeploymentTargetAdapterRegistry([adapter]);
    const targets = new DeploymentTargetService({
      repository: state.repository,
      adapters,
      sshHosts: new HostPolicy(["127.0.0.1"], "SSH"),
      healthHosts: new HostPolicy(["127.0.0.1"], "health"),
      audit: state.audit,
      remoteEnabled: true,
    });
    const targetInput = {
      id: "remote-web",
      name: "Remote web",
      adapter: "ssh-compose-v1",
      endpoint: {
        host: "127.0.0.1",
        port: 22,
        sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
      remoteBasePath: "/srv/variamos/project-secure",
      publishedPort: 18080,
      publicBaseUrl: "http://127.0.0.1:18080/",
      images: {
        nginx: `nginx@sha256:${"a".repeat(64)}`,
      },
      capabilities: ["docker", "docker-compose", "static-http", "single-container"],
      authentication: { mode: "prompt-password", username: "variamos-deploy" },
    };
    await assert.rejects(
      targets.create(state.actor, {
        ...targetInput,
        id: "remote-path",
        remoteBasePath: "/srv/variamos/../root",
      }),
      /remote base path/
    );
    await assert.rejects(
      targets.create(state.actor, {
        ...targetInput,
        id: "remote-command",
        images: {
          ...targetInput.images,
          nginx: `${targetInput.images.nginx};id`,
        },
      }),
      /pinned by sha256/
    );
    const target = await targets.create(state.actor, targetInput, {
      schemaVersion: "ssh-password/v1",
      username: "variamos-deploy",
      password: "target-validation-password",
    });
    assert.equal(target.environment, undefined);
    assert.equal(state.repository.listTargets("another-project").length, 0);
    const build = {
      schemaVersion: "spl-build-record/v1",
      buildId: "build-fixture",
      projectId: "project-secure",
      manifest: {
        schemaVersion: "spl-deployment-manifest/v1",
        manifestId: "manifest-fixture",
        product: { id: "product-fixture", configurationId: "configuration-fixture" },
        sourceModel: { projectId: "project-secure", modelId: "model-fixture", version: "model-version-fixture" },
        features: [],
        artifacts: [],
        operations: [{ type: "deploy", adapter: "ssh-compose-v1" }],
        target: { id: "remote-web" },
        verification: [{ type: "http-health-check", path: "/" }],
        rollback: { strategy: "previous-successful-release" },
      },
      manifestDigest: `sha256:${"c".repeat(64)}`,
      planDigest: `sha256:${"d".repeat(64)}`,
      targetRef: "remote-web",
      targetRevision: target.revision,
      outputDirectory: "/not-used-by-fake-adapter",
      outputDigest: `sha256:${"e".repeat(64)}`,
      tests: { status: "passed" },
      builderAdapter: "static-site-v1",
      createdAt: new Date().toISOString(),
      createdBy: "owner-1",
    };
    state.repository.putBuild(build);
    const authorizer = {
      async authorize() { return state.actor; },
      async reauthorize() { return state.actor; },
    };
    const jobs = new DeploymentJobService({
      repository: state.repository,
      targets,
      adapters,
      authorizer,
      audit: state.audit,
    });
    const input = {
      projectId: "project-secure",
      buildId: build.buildId,
      targetRef: target.id,
      targetRevision: target.revision,
      expectedPlanDigest: build.planDigest,
      idempotencyKey: "deployment-fixture-001",
      ephemeralCredential: {
        schemaVersion: "ssh-password/v1",
        username: "variamos-deploy",
        password: "first-deployment-password",
      },
    };
    const first = jobs.create(state.actor, input);
    assert.throws(
      () => targets.remove(state.actor, target.id),
      /cannot be deleted while a deployment is active/
    );
    const repeated = jobs.create(state.actor, input);
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.execution.executionId, first.execution.executionId);
    assert.throws(
      () => jobs.create(state.actor, { ...input, idempotencyKey: "deployment-fixture-002" }),
      /already active/
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(jobs.get("project-secure", first.execution.executionId).status, "succeeded");
    assert.equal(deploymentCalls, 1);
    const cancellable = jobs.create(state.actor, {
      ...input,
      idempotencyKey: "deployment-fixture-003",
      ephemeralCredential: {
        schemaVersion: "ssh-password/v1",
        username: "variamos-deploy",
        password: "cancelled-deployment-password",
      },
    });
    jobs.cancel(state.actor, cancellable.execution.executionId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      jobs.get("project-secure", cancellable.execution.executionId).status,
      "cancelled"
    );
    assert.equal(deploymentCalls, 1);
    const removed = targets.remove(state.actor, target.id);
    assert.deepEqual(removed, { deleted: true, targetRef: target.id });
    assert.equal(state.repository.getTarget(state.actor.userId, target.id), undefined);
    assert.ok(state.repository.getRelease("project-secure", target.id));
    assert.equal(state.repository.getBuild("project-secure", build.buildId).buildId, build.buildId);
    assert.ok(state.repository.listDeployments("project-secure").length >= 2);
    assert.match(fs.readFileSync(state.auditPath, "utf8"), /"event":"target.deleted"/);
  } finally {
    state.cleanup();
  }
});

test("secure HTTP APIs preserve role boundaries and deploy only an immutable remote build", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-secure-http-test-"));
  const workspaceRoot = path.resolve(__dirname, "../../..");
  const eventPortalRoot = path.join(workspaceRoot, "contracts/examples/event-portal");
  const roles = { owner: "owner", editor: "editor", viewer: "viewer" };
  const policy = {
    "metadata:read": ["owner", "editor", "viewer"],
    "project:import": ["owner", "editor"],
    "derivation:plan": ["owner", "editor"],
    "derivation:build": ["owner", "editor"],
    "target:manage": ["owner"],
    "credential:manage": ["owner"],
    "deployment:manage": ["owner"],
  };
  const authorizer = {
    async authorize(request, projectId, action) {
      const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
      const role = roles[token];
      if (!role) throw new AuthorizationError(401, "Missing or expired session.");
      if (!policy[action].includes(role)) throw new AuthorizationError(403, "Role is not allowed.");
      return { userId: `${role}-user`, role, projectId, token };
    },
    async reauthorize(actor, projectId, action) {
      if (!policy[action].includes(actor.role)) throw new AuthorizationError(403, "Role is not allowed.");
      return { ...actor, projectId };
    },
  };
  const provider = {
    id: "aws-secrets-manager",
    async describeSecret() {
      return {
        tags: {
          "variamos:projectId": "event-portal-project",
          "variamos:purpose": "deployment",
          "variamos:credentialType": "ssh-deployment-v1",
        },
        versionIdsToStages: { "version-1": ["AWSCURRENT"] },
      };
    },
    async getSecretValue() {
      return {
        versionId: "version-1",
        secretString: JSON.stringify({
          schemaVersion: "ssh-deployment/v1",
          username: "variamos-deploy",
          privateKey: PRIVATE_KEY,
        }),
      };
    },
  };
  const adapter = {
    definition: {
      id: "ssh-compose-v1",
      name: "Fake remote adapter",
      availability: "available",
      credentialTypes: [],
      capabilities: [
        "docker",
        "docker-compose",
        "static-http",
        "single-container",
        "node-runtime",
        "http-api",
        "persistent-data",
      ],
      configurationSchema: {},
    },
    async validate(context) {
      if (context.target.id === "missing-directory") {
        throw new RemoteDeploymentError(
          "The authorized deployment directory does not exist on the SSH server.",
          "REMOTE_DIRECTORY_MISSING"
        );
      }
    },
    async deploy(context) {
      context.updateStage("verifying", "Verifying fixture.");
      return {
        status: "deployed",
        publicUrl: "http://127.0.0.1:18081/",
        release: {
          schemaVersion: "ssh-compose-release/v1",
          projectId: context.build.projectId,
          targetRef: context.target.id,
          releaseId: "release-http-fixture",
          manifestId: context.build.manifest.manifestId,
          builderAdapter: context.build.builderAdapter,
          remoteDirectory: "/srv/variamos/event-portal/releases/release-http-fixture",
          composeProject: "variamos-http-fixture",
          publicUrl: "http://127.0.0.1:18081/",
          deployedAt: new Date().toISOString(),
        },
      };
    },
  };
  const server = http.createServer(createSplHttpHandler({
    outputRoot: path.join(root, "products"),
    releaseStateDirectory: path.join(root, "releases"),
    externalProjectStateDirectory: path.join(root, "external"),
    secureStateDirectory: path.join(root, "secure"),
    auditSink: "file",
    auditFilePath: path.join(root, "audit", "events.jsonl"),
    projectDescriptorSchemaPath: path.join(workspaceRoot, "contracts/schemas/variamos-project.schema.json"),
    resourceRegistryPath: path.join(eventPortalRoot, "registry.local.json"),
    allowedOrigins: ["http://127.0.0.1:3000"],
    remoteDeploymentEnabled: true,
    sessionInfoUrl: "http://identity.invalid/auth/session-info",
    projectInfoUrl: "http://projects.invalid/getProject",
    secretBackend: "aws",
    credentialProvider: provider,
    gitHostAllowlist: ["127.0.0.1"],
    sshHostAllowlist: ["127.0.0.1"],
    healthHostAllowlist: ["127.0.0.1"],
    authorizer,
    deploymentTargetAdapters: [adapter],
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const projectId = "event-portal-project";
    const ownerAccess = await apiRequest(server, {
      method: "GET",
      path: `/api/spl/v1/projects/${projectId}/access`,
      token: "owner",
    });
    assert.equal(ownerAccess.statusCode, 200);
    assert.equal(ownerAccess.body.role, "owner");
    assert.equal(ownerAccess.body.permissions.manageTargets, true);
    assert.equal(ownerAccess.body.permissions.manageCredentials, true);
    const editorAccess = await apiRequest(server, {
      method: "GET",
      path: `/api/spl/v1/projects/${projectId}/access`,
      token: "editor",
    });
    assert.equal(editorAccess.statusCode, 200);
    assert.equal(editorAccess.body.role, "editor");
    assert.equal(editorAccess.body.permissions.manageTargets, false);
    assert.equal(editorAccess.body.permissions.plan, true);
    const missingAccess = await apiRequest(server, {
      method: "GET",
      path: `/api/spl/v1/projects/${projectId}/access`,
    });
    assert.equal(missingAccess.statusCode, 401);

    const credentialInput = {
      id: "remote-web-key",
      alias: "Remote web key",
      purpose: "deployment",
      credentialType: "ssh-deployment-v1",
      externalSecretId: "arn:aws:secretsmanager:region:account:secret:event-portal",
      subject: { kind: "deployment-target", id: "remote-web" },
    };
    assert.equal((await apiRequest(server, {
      path: `/api/spl/v1/projects/${projectId}/credential-bindings`,
      token: "editor",
      body: credentialInput,
    })).statusCode, 403);
    const credential = await apiRequest(server, {
      path: `/api/spl/v1/projects/${projectId}/credential-bindings`,
      token: "owner",
      body: credentialInput,
    });
    assert.equal(credential.statusCode, 422);
    assert.match(credential.body.error, /not supported|username and password/i);

    const httpPassword = "http-only-deployment-password";
    const targetInput = {
      id: "remote-web",
      name: "Remote web",
      environment: "staging",
      adapter: "ssh-compose-v1",
      endpoint: {
        host: "127.0.0.1",
        port: 22,
        sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
      remoteBasePath: "/srv/variamos/event-portal",
      publishedPort: 18081,
      publicBaseUrl: "http://127.0.0.1:18081/",
      images: {
        nginx: `nginx@sha256:${"a".repeat(64)}`,
        node: `node@sha256:${"b".repeat(64)}`,
      },
      capabilities: ["docker", "docker-compose", "static-http", "single-container"],
      authentication: { mode: "prompt-password", username: "deployer" },
    };
    const missingDirectory = await apiRequest(server, {
      path: `/api/spl/v1/projects/${projectId}/targets`,
      token: "owner",
      body: {
        ...targetInput,
        id: "missing-directory",
        name: "Missing directory",
        remoteBasePath: "/srv/variamos/missing-directory",
        ephemeralCredential: {
          schemaVersion: "ssh-password/v1",
          username: "deployer",
          password: "missing-directory-attempt",
        },
      },
    });
    assert.equal(missingDirectory.statusCode, 422);
    assert.equal(
      missingDirectory.body.error,
      "The authorized deployment directory does not exist on the SSH server."
    );
    const target = await apiRequest(server, {
      path: `/api/spl/v1/projects/${projectId}/targets`,
      token: "owner",
      body: {
        ...targetInput,
        ephemeralCredential: {
          schemaVersion: "ssh-password/v1",
          username: "deployer",
          password: httpPassword,
        },
      },
    });
    assert.equal(target.statusCode, 201);
    const targetJson = JSON.stringify(target.body);
    assert.equal(targetJson.includes("deploymentCredentialRef"), false);
    assert.equal(targetJson.includes("remoteBasePath"), false);
    assert.equal(targetJson.includes("ownerUserId"), false);
    assert.equal(targetJson.includes("/srv/variamos"), false);
    assert.deepEqual(target.body.authentication, {
      mode: "prompt-password",
      username: "deployer",
    });
    assert.equal(target.body.scope, "personal");
    assert.equal("hasDeploymentCredential" in target.body, false);
    assert.equal(JSON.stringify(target.body).includes(httpPassword), false);
    const listedTargets = await apiRequest(server, {
      method: "GET",
      path: `/api/spl/v1/projects/${projectId}/targets`,
      token: "owner",
    });
    assert.equal(JSON.stringify(listedTargets.body).includes(httpPassword), false);

    const featureModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/feature-model.json"), "utf8"));
    const mappingModel = JSON.parse(fs.readFileSync(path.join(eventPortalRoot, "models/mapping.static.json"), "utf8"));
    const plan = await apiRequest(server, {
      path: "/api/spl/v1/derivations",
      token: "owner",
      body: {
        action: "plan",
        projectId,
        productLineId: "event-portal",
        featureModel,
        mappingModel,
        targetRef: "remote-web",
        targetRevision: 1,
      },
    });
    assert.equal(plan.statusCode, 200);
    assert.equal(plan.body.targetRevision, 1);
    assert.equal(plan.body.profile.deployerAdapter, "ssh-compose-v1");
    const stale = await apiRequest(server, {
      path: "/api/spl/v1/derivations",
      token: "owner",
      body: {
        action: "build",
        projectId,
        productLineId: "event-portal",
        featureModel,
        mappingModel,
        targetRef: "remote-web",
        targetRevision: 2,
        expectedPlanDigest: plan.body.planDigest,
      },
    });
    assert.equal(stale.statusCode, 409);
    const build = await apiRequest(server, {
      path: "/api/spl/v1/derivations",
      token: "owner",
      body: {
        action: "build",
        projectId,
        productLineId: "event-portal",
        featureModel,
        mappingModel,
        targetRef: "remote-web",
        targetRevision: 1,
        expectedPlanDigest: plan.body.planDigest,
      },
    });
    assert.equal(build.statusCode, 200);
    assert.match(build.body.buildId, /^build-/);
    assert.equal(build.body.tests.status, "passed");

    const deployBody = {
      projectId,
      buildId: build.body.buildId,
      targetRef: "remote-web",
      targetRevision: 1,
      expectedPlanDigest: plan.body.planDigest,
      idempotencyKey: "http-deployment-fixture-001",
      ephemeralCredential: {
        schemaVersion: "ssh-password/v1",
        username: "deployer",
        password: httpPassword,
      },
    };
    assert.equal((await apiRequest(server, {
      path: "/api/spl/v1/deployments",
      token: "editor",
      body: deployBody,
    })).statusCode, 403);
    const queued = await apiRequest(server, {
      path: "/api/spl/v1/deployments",
      token: "owner",
      body: deployBody,
    });
    assert.equal(queued.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const finished = await apiRequest(server, {
      path: `/api/spl/v1/deployments/${queued.body.executionId}`,
      token: "viewer",
    });
    assert.equal(finished.statusCode, 200);
    assert.equal(finished.body.status, "succeeded");
    const responseJson = JSON.stringify(finished.body);
    assert.equal(responseJson.includes("/srv/variamos"), false);
    assert.equal(responseJson.includes("arn:aws"), false);
    assert.equal(
      fs.readFileSync(path.join(root, "audit", "events.jsonl"), "utf8").includes(httpPassword),
      false
    );
    const targetPath = `/api/spl/v1/projects/${projectId}/targets/remote-web`;
    assert.equal((await apiRequest(server, {
      method: "DELETE",
      path: targetPath,
      token: "editor",
    })).statusCode, 403);
    const deletedTarget = await apiRequest(server, {
      method: "DELETE",
      path: targetPath,
      token: "owner",
    });
    assert.equal(deletedTarget.statusCode, 200);
    assert.deepEqual(deletedTarget.body, { deleted: true, targetRef: "remote-web" });
    const targetsAfterDelete = await apiRequest(server, {
      method: "GET",
      path: `/api/spl/v1/projects/${projectId}/targets`,
      token: "owner",
    });
    assert.deepEqual(targetsAfterDelete.body.targets, []);
    assert.match(
      fs.readFileSync(path.join(root, "audit", "events.jsonl"), "utf8"),
      /"event":"target.deleted"/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
