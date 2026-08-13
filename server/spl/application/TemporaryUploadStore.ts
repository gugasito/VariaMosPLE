import crypto from "crypto";
import fs from "fs";
import path from "path";

export const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface UploadFileInput {
  relativePath: string;
  content: Buffer;
}

export interface TemporaryUploadMetadata {
  schemaVersion: "spl-source-upload/v1";
  uploadId: string;
  projectId: string;
  actorId: string;
  descriptorPath: string;
  descriptorDigest: string;
  snapshotDigest: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  expiresAt: string;
}

export interface TemporaryUpload extends TemporaryUploadMetadata {
  root: string;
}

export class TemporaryUploadError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 422,
    public readonly code?: string,
    public readonly requiresReupload = false,
  ) {
    super(message);
    this.name = "TemporaryUploadError";
    Object.setPrototypeOf(this, TemporaryUploadError.prototype);
  }
}

function digest(value: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

/** A browser supplied path is never used as a filesystem path without this check. */
export function safeUploadPath(value: string, label = "File path"): string {
  if (!value || value.length > 1024 || path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TemporaryUploadError(`${label} must be a safe relative path.`);
  }
  const lower = value.toLowerCase();
  if (
    lower.split("/").some((part) => part === ".git" || /^\.env(?:\.|$)/.test(part)) ||
    /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials?|secrets?)(?:$|[._-])/.test(lower) ||
    /\.(?:pem|key|p12|pfx)$/i.test(value)
  ) {
    throw new TemporaryUploadError(`${label} contains a sensitive file name that cannot be uploaded.`);
  }
  return value;
}

export class TemporaryUploadStore {
  private readonly leases = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly options: {
      rootDirectory: string;
      ttlMs: number;
      maxBytes: number;
      maxFiles: number;
      now?: () => Date;
      sweepIntervalMs?: number;
    },
  ) {
    this.makePrivateDirectory(options.rootDirectory);
    this.sweep();
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs || 15 * 60 * 1000);
    this.timer.unref();
  }

  public close(): void { clearInterval(this.timer); }

  public create(projectId: string, actorId: string, files: UploadFileInput[]): TemporaryUpload {
    if (!files.length) throw new TemporaryUploadError("The upload does not contain files.");
    if (files.length > this.options.maxFiles) throw new TemporaryUploadError(`The upload exceeds the ${this.options.maxFiles}-file limit.`, 413);
    const paths = new Set<string>();
    let totalBytes = 0;
    let descriptor: UploadFileInput | undefined;
    const checked = files.map((file) => {
      const relativePath = safeUploadPath(file.relativePath);
      if (paths.has(relativePath)) throw new TemporaryUploadError(`The upload contains duplicate path '${relativePath}'.`);
      paths.add(relativePath);
      if (file.content.length > MAX_ARTIFACT_BYTES && relativePath !== ".variamos/spl.json") {
        throw new TemporaryUploadError(`'${relativePath}' exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit.`, 413);
      }
      if (relativePath === ".variamos/spl.json") {
        if (file.content.length > MAX_DESCRIPTOR_BYTES) throw new TemporaryUploadError("The descriptor exceeds the 1 MiB limit.", 413);
        descriptor = { relativePath, content: file.content };
      }
      totalBytes += file.content.length;
      if (totalBytes > this.options.maxBytes) throw new TemporaryUploadError(`The upload exceeds the ${this.options.maxBytes}-byte limit.`, 413);
      return { relativePath, content: file.content };
    });
    if (!descriptor) throw new TemporaryUploadError("The folder must include '.variamos/spl.json'.");

    const uploadId = crypto.randomUUID();
    const projectDirectory = path.join(this.options.rootDirectory, projectId);
    const temporary = path.join(projectDirectory, `.${uploadId}.partial`);
    const finalDirectory = path.join(projectDirectory, uploadId);
    try {
      this.makePrivateDirectory(temporary);
      const root = path.join(temporary, "files");
      this.makePrivateDirectory(root);
      checked.forEach((file) => {
        const destination = path.join(root, file.relativePath);
        this.makePrivateDirectory(path.dirname(destination));
        fs.writeFileSync(destination, file.content, { mode: 0o600 });
        this.makePrivateFile(destination);
      });
      const now = (this.options.now || (() => new Date()))();
      const metadata: TemporaryUploadMetadata = {
        schemaVersion: "spl-source-upload/v1",
        uploadId,
        projectId,
        actorId,
        descriptorPath: ".variamos/spl.json",
        descriptorDigest: digest(descriptor.content),
        snapshotDigest: this.snapshotDigest(checked),
        fileCount: checked.length,
        totalBytes,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.options.ttlMs).toISOString(),
      };
      this.writeJson(path.join(temporary, "metadata.json"), metadata);
      this.makePrivateDirectory(projectDirectory);
      fs.renameSync(temporary, finalDirectory);
      return { ...metadata, root: path.join(finalDirectory, "files") };
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  public get(uploadId: string, projectId: string, actorId?: string): TemporaryUpload {
    const upload = this.read(uploadId, projectId);
    if (actorId && upload.actorId !== actorId) throw new TemporaryUploadError("The upload does not exist.", 404);
    return upload;
  }

  public acquire(uploadId: string, projectId: string, actorId?: string): { upload: TemporaryUpload; release: () => void } {
    const upload = this.get(uploadId, projectId, actorId);
    if (new Date(upload.expiresAt).getTime() <= (this.options.now || (() => new Date()))().getTime()) {
      throw new TemporaryUploadError("The uploaded source has expired. Upload the same folder again to continue.", 410, "SPL_SOURCE_EXPIRED", true);
    }
    this.leases.set(this.key(projectId, uploadId), (this.leases.get(this.key(projectId, uploadId)) || 0) + 1);
    let released = false;
    return {
      upload,
      release: () => {
        if (released) return;
        released = true;
        const key = this.key(projectId, uploadId);
        const next = (this.leases.get(key) || 1) - 1;
        if (next <= 0) this.leases.delete(key); else this.leases.set(key, next);
      },
    };
  }

  public status(uploadId: string | undefined, projectId: string): "available" | "expired" | "missing" {
    if (!uploadId) return "missing";
    try {
      const upload = this.read(uploadId, projectId);
      return new Date(upload.expiresAt).getTime() > (this.options.now || (() => new Date()))().getTime() ? "available" : "expired";
    } catch (_error) { return "missing"; }
  }

  public sweep(): void {
    if (!fs.existsSync(this.options.rootDirectory)) return;
    const now = (this.options.now || (() => new Date()))().getTime();
    for (const projectId of fs.readdirSync(this.options.rootDirectory)) {
      const projectDirectory = path.join(this.options.rootDirectory, projectId);
      if (!fs.statSync(projectDirectory).isDirectory()) continue;
      for (const entry of fs.readdirSync(projectDirectory)) {
        const candidate = path.join(projectDirectory, entry);
        if (entry.startsWith(".")) { fs.rmSync(candidate, { recursive: true, force: true }); continue; }
        try {
          const upload = this.read(entry, projectId);
          if (new Date(upload.expiresAt).getTime() <= now && !this.leases.has(this.key(projectId, entry))) {
            fs.rmSync(candidate, { recursive: true, force: true });
          }
        } catch (_error) { fs.rmSync(candidate, { recursive: true, force: true }); }
      }
    }
  }

  private read(uploadId: string, projectId: string): TemporaryUpload {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new TemporaryUploadError("The upload does not exist.", 404);
    const directory = path.join(this.options.rootDirectory, projectId, uploadId);
    let metadata: TemporaryUploadMetadata;
    try { metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8")) as TemporaryUploadMetadata; }
    catch (_error) { throw new TemporaryUploadError("The upload does not exist.", 404); }
    if (metadata.uploadId !== uploadId || metadata.projectId !== projectId || metadata.schemaVersion !== "spl-source-upload/v1") {
      throw new TemporaryUploadError("The upload does not exist.", 404);
    }
    return { ...metadata, root: path.join(directory, "files") };
  }

  private snapshotDigest(files: UploadFileInput[]): string {
    const hash = crypto.createHash("sha256");
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)).forEach((file) => {
      hash.update(file.relativePath); hash.update("\0"); hash.update(file.content); hash.update("\0");
    });
    return `sha256:${hash.digest("hex")}`;
  }
  private key(projectId: string, uploadId: string): string { return `${projectId}:${uploadId}`; }
  private makePrivateDirectory(directory: string): void { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); try { fs.chmodSync(directory, 0o700); } catch (_error) { /* best effort */ } }
  private makePrivateFile(fileName: string): void { try { fs.chmodSync(fileName, 0o600); } catch (_error) { /* best effort */ } }
  private writeJson(fileName: string, value: unknown): void { fs.writeFileSync(fileName, `${JSON.stringify(value)}\n`, { mode: 0o600 }); this.makePrivateFile(fileName); }
}
