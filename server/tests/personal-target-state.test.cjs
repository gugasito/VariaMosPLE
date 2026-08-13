const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SecureStateRepository } = require("../dist/spl/security/AtomicStateStore.js");

function target(ownerUserId, id) {
  return {
    schemaVersion: "deployment-target-connection/v1", id, ownerUserId, name: id,
    adapter: "ssh-compose-v1", endpoint: { host: "127.0.0.1", port: 22, sshHostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    remoteBasePath: "/srv/variamos", publishedPort: 18080, publicBaseUrl: "http://127.0.0.1:18080/",
    images: { nginx: "nginx@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    capabilities: ["docker", "docker-compose", "static-http", "single-container"],
    authentication: { mode: "prompt-password", username: "deployer" }, status: "active", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", createdBy: ownerUserId, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: ownerUserId,
  };
}

test("personal targets persist by owner and allow duplicate IDs across accounts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-personal-targets-"));
  try {
    const first = new SecureStateRepository(root);
    first.putTarget(target("user-a", "staging"));
    first.putTarget(target("user-b", "staging"));
    assert.equal(first.getTarget("user-a", "staging").ownerUserId, "user-a");
    assert.equal(first.getTarget("user-b", "staging").ownerUserId, "user-b");
    assert.equal(first.listTargets("user-a").length, 1);
    assert.equal(first.listTargets("user-b").length, 1);
    assert.equal(first.getTarget("user-c", "staging"), undefined);
    const persisted = fs.readFileSync(path.join(root, "users", "user-a", "targets", "staging.json"), "utf8");
    assert.equal(persisted.includes("\"password\":"), false);
    const restarted = new SecureStateRepository(root);
    assert.equal(restarted.getTarget("user-a", "staging").id, "staging");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
