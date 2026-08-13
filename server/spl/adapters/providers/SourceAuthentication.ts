import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { CredentialBroker, CredentialLease } from "../../security/CredentialBroker";
import { HostPolicy } from "../../security/HostPolicy";

export interface SourceAuthenticationRequest {
  projectId?: string;
  actorId: string;
  connectionId: string;
  repositoryUrl: string;
  credentialRef?: string;
  sshHostKeyFingerprint?: string;
  credentialLease?: CredentialLease;
}

export interface SourceAuthenticationContext {
  environment: NodeJS.ProcessEnv;
  gitPrefixArguments: string[];
  dispose(): void;
}

export interface SourceAuthenticationAdapter {
  readonly id: string;
  supports(repositoryUrl: string): boolean;
  prepare(request: SourceAuthenticationRequest): Promise<SourceAuthenticationContext>;
}

export class SourceAuthenticationAdapterRegistry {
  constructor(private readonly adapters: SourceAuthenticationAdapter[]) {}

  public require(repositoryUrl: string): SourceAuthenticationAdapter {
    const adapter = this.adapters.find((item) => item.supports(repositoryUrl));
    if (!adapter) throw new Error("No source authentication adapter supports this repository URL.");
    return adapter;
  }
}

function remoteUrl(value: string): URL {
  if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(value)) {
    const match = value.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
    if (!match) throw new Error("The SSH repository URL is invalid.");
    return new URL(`ssh://${encodeURIComponent(match[1])}@${match[2]}/${match[3]}`);
  }
  return new URL(value);
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "variamos-spl-credential-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function cleanup(directory: string, lease?: CredentialLease): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } finally {
    lease?.dispose();
  }
}

function curlResolveAddress(address: string): string {
  return net.isIP(address) === 6 ? `[${address}]` : address;
}

function assertSourceBinding(lease: CredentialLease, connectionId: string): void {
  if (
    lease.binding.subject.kind !== "source-connection" ||
    lease.binding.subject.id !== connectionId
  ) {
    throw new Error("The source credential is bound to another connection.");
  }
}

export class GitHttpsAuthenticationAdapter implements SourceAuthenticationAdapter {
  public readonly id = "git-https-askpass-v1";

  constructor(
    private readonly broker: CredentialBroker,
    private readonly hosts: HostPolicy
  ) {}

  public supports(repositoryUrl: string): boolean {
    try {
      return new URL(repositoryUrl).protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  public async prepare(request: SourceAuthenticationRequest): Promise<SourceAuthenticationContext> {
    const url = remoteUrl(request.repositoryUrl);
    const authorized = await this.hosts.authorize(url.hostname);
    const port = Number(url.port || "443");
    const directory = makeTemporaryDirectory();
    let lease: CredentialLease | undefined;
    let ownsLease = false;
    try {
      const environment: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
      if (request.credentialRef) {
        if (!request.projectId) throw new Error("Private Git credentials require a projectId.");
        lease = request.credentialLease || await this.broker.resolve(
            request.projectId,
            request.credentialRef,
            "source-read",
            ["git-https-token-v1"],
            { actorId: request.actorId }
          );
        ownsLease = !request.credentialLease;
        assertSourceBinding(lease, request.connectionId);
        if (lease.payload.schemaVersion !== "git-https-token/v1") {
          throw new Error("The source credential is not an HTTPS token.");
        }
        const askPassPath = path.join(directory, "git-askpass.sh");
        fs.writeFileSync(
          askPassPath,
          "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$SPL_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$SPL_GIT_TOKEN\" ;;\nesac\n",
          { encoding: "utf8", mode: 0o700 }
        );
        environment.GIT_ASKPASS = askPassPath;
        environment.SPL_GIT_USERNAME = lease.payload.username;
        environment.SPL_GIT_TOKEN = lease.payload.token;
      }
      return {
        environment,
        gitPrefixArguments: [
          "-c",
          `http.curloptResolve=${url.hostname}:${port}:${curlResolveAddress(authorized.connectAddress)}`,
        ],
        dispose: () => {
          environment.SPL_GIT_USERNAME = "";
          environment.SPL_GIT_TOKEN = "";
          cleanup(directory, ownsLease ? lease : undefined);
        },
      };
    } catch (error) {
      cleanup(directory, ownsLease ? lease : undefined);
      throw error;
    }
  }
}

export class GitSshAuthenticationAdapter implements SourceAuthenticationAdapter {
  public readonly id = "git-ssh-key-v1";

  constructor(
    private readonly broker: CredentialBroker,
    private readonly hosts: HostPolicy,
    private readonly keyScanner: (host: string, port: number) => string = (host, port) =>
      execFileSync(
        "ssh-keyscan",
        ["-T", "10", "-p", String(port), host],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }
      )
  ) {}

  public supports(repositoryUrl: string): boolean {
    if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(repositoryUrl)) return true;
    try {
      return new URL(repositoryUrl).protocol === "ssh:";
    } catch (_error) {
      return false;
    }
  }

  public async prepare(request: SourceAuthenticationRequest): Promise<SourceAuthenticationContext> {
    if (!request.credentialRef || !request.projectId) {
      throw new Error("An SSH Git repository requires a project credential binding.");
    }
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(request.sshHostKeyFingerprint || "")) {
      throw new Error("An SSH Git repository requires its SHA-256 host key fingerprint.");
    }
    const url = remoteUrl(request.repositoryUrl);
    const authorized = await this.hosts.authorize(url.hostname);
    const port = Number(url.port || "22");
    const directory = makeTemporaryDirectory();
    let lease: CredentialLease | undefined;
    let ownsLease = false;
    try {
      lease = request.credentialLease || await this.broker.resolve(
          request.projectId,
          request.credentialRef,
          "source-read",
          ["git-ssh-key-v1"],
          { actorId: request.actorId }
        );
      ownsLease = !request.credentialLease;
      assertSourceBinding(lease, request.connectionId);
      if (lease.payload.schemaVersion !== "git-ssh-key/v1") {
        throw new Error("The source credential is not an SSH key.");
      }
      const keyPath = path.join(directory, "id_git");
      const knownHostsPath = path.join(directory, "known_hosts");
      const askPassPath = path.join(directory, "ssh-askpass.sh");
      fs.writeFileSync(keyPath, lease.payload.privateKey, { encoding: "utf8", mode: 0o600 });
      const scanned = this.keyScanner(authorized.connectAddress, port);
      const verifiedLines = scanned.split("\n").filter(Boolean).flatMap((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3 || parts[0].startsWith("#")) return [];
        const keyBytes = Buffer.from(parts[2], "base64");
        const fingerprint = crypto.createHash("sha256").update(keyBytes).digest("base64").replace(/=+$/, "");
        const expected = (request.sshHostKeyFingerprint || "").replace(/^SHA256:/, "").replace(/=+$/, "");
        if (fingerprint !== expected) return [];
        // HostKeyAlias makes the lookup name independent from the resolved IP and port.
        return [`${url.hostname} ${parts[1]} ${parts[2]}`];
      });
      if (!verifiedLines.length) throw new Error("The SSH host key does not match the registered fingerprint.");
      fs.writeFileSync(knownHostsPath, `${verifiedLines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      if (lease.payload.passphrase) {
        fs.writeFileSync(
          askPassPath,
          "#!/bin/sh\nprintf '%s\\n' \"$SPL_SSH_PASSPHRASE\"\n",
          { encoding: "utf8", mode: 0o700 }
        );
      }
      const sshCommand = [
        "ssh",
        "-i", keyPath,
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-o", `HostName=${authorized.connectAddress}`,
        "-o", `HostKeyAlias=${url.hostname}`,
        "-p", String(port),
      ].map((item) => `'${item.replace(/'/g, "'\"'\"'")}'`).join(" ");
      const environment: NodeJS.ProcessEnv = {
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: sshCommand,
          ...(lease.payload.passphrase
            ? {
              SSH_ASKPASS: askPassPath,
              SSH_ASKPASS_REQUIRE: "force",
              SPL_SSH_PASSPHRASE: lease.payload.passphrase,
              DISPLAY: "variamos:0",
            }
            : {}),
        };
      return {
        environment,
        gitPrefixArguments: [],
        dispose: () => {
          environment.SPL_SSH_PASSPHRASE = "";
          cleanup(directory, ownsLease ? lease : undefined);
        },
      };
    } catch (error) {
      cleanup(directory, ownsLease ? lease : undefined);
      throw error;
    }
  }
}

export class PublicOrLocalGitAuthenticationAdapter implements SourceAuthenticationAdapter {
  public readonly id = "git-public-or-local-v1";

  constructor(private readonly hosts: HostPolicy) {}

  public supports(_repositoryUrl: string): boolean {
    return true;
  }

  public async prepare(request: SourceAuthenticationRequest): Promise<SourceAuthenticationContext> {
    if (path.isAbsolute(request.repositoryUrl)) {
      return {
        environment: { GIT_TERMINAL_PROMPT: "0" },
        gitPrefixArguments: [],
        dispose: () => undefined,
      };
    }
    const url = remoteUrl(request.repositoryUrl);
    if (url.protocol !== "https:") {
      throw new Error("The remote Git protocol requires an explicit authentication adapter.");
    }
    const authorized = await this.hosts.authorize(url.hostname);
    const port = Number(url.port || "443");
    return {
      environment: { GIT_TERMINAL_PROMPT: "0" },
      gitPrefixArguments: [
        "-c",
        `http.curloptResolve=${url.hostname}:${port}:${curlResolveAddress(authorized.connectAddress)}`,
      ],
      dispose: () => undefined,
    };
  }
}
