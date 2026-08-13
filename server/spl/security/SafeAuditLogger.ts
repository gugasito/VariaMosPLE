import crypto from "crypto";
import fs from "fs";
import path from "path";
import { AuditEvent } from "./SecureTypes";

const SENSITIVE_KEY = /(?:authorization|token|password|passphrase|private.?key|secret.?value|secret.?string)/i;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;

export class SecretRedactor {
  private readonly values = new Set<string>();

  public register(value: unknown): void {
    if (typeof value === "string" && value.length >= 4) this.values.add(value);
  }

  /** One-time passwords may be shorter than normal managed secrets. */
  public registerSecret(value: unknown): void {
    if (typeof value === "string" && value.length > 0) this.values.add(value);
  }

  public registerPayload(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    Object.entries(payload as Record<string, unknown>).forEach(([key, value]) => {
      if (SENSITIVE_KEY.test(key)) this.register(value);
    });
  }

  public text(value: string): string {
    let output = value
      .replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
      .replace(URL_CREDENTIALS, "$1[REDACTED]@")
      .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]");
    [...this.values]
      .sort((left, right) => right.length - left.length)
      .forEach((secret) => {
        output = output.split(secret).join("[REDACTED]");
      });
    return output;
  }

  public value(value: unknown, key = ""): unknown {
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([entryKey, entryValue]) => [entryKey, this.value(entryValue, entryKey)])
      );
    }
    return value;
  }
}

export interface SafeAuditLoggerOptions {
  sink: "file" | "stdout" | "both";
  filePath?: string;
  redactor?: SecretRedactor;
}

export class SafeAuditLogger {
  public readonly redactor: SecretRedactor;
  private previousHash = "0".repeat(64);

  constructor(private readonly options: SafeAuditLoggerOptions) {
    this.redactor = options.redactor || new SecretRedactor();
    if ((options.sink === "file" || options.sink === "both") && !options.filePath) {
      throw new Error("A file audit sink requires a filePath.");
    }
    if (options.filePath) {
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(options.filePath)) {
        const lines = fs.readFileSync(options.filePath, "utf8").trim().split("\n");
        if (lines.length && lines[0]) {
          try {
            const last = JSON.parse(lines[lines.length - 1]) as { eventHash?: string };
            if (last.eventHash && /^[a-f0-9]{64}$/.test(last.eventHash)) this.previousHash = last.eventHash;
          } catch (_error) {
            throw new Error("The audit log is not valid JSON Lines.");
          }
        }
      } else {
        fs.closeSync(fs.openSync(options.filePath, "wx", 0o600));
      }
      try {
        fs.chmodSync(options.filePath, 0o600);
      } catch (_error) {
        // Best effort on non-POSIX filesystems.
      }
    }
  }

  public record(event: AuditEvent): void {
    const timestamp = new Date().toISOString();
    const safeEvent = this.redactor.value(event) as AuditEvent;
    const unsigned = {
      schemaVersion: "spl-audit-event/v1",
      timestamp,
      previousHash: this.previousHash,
      ...safeEvent,
    };
    const eventHash = crypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    const line = JSON.stringify({ ...unsigned, eventHash });
    this.previousHash = eventHash;
    if (this.options.sink === "stdout" || this.options.sink === "both") {
      process.stdout.write(`${line}\n`);
    }
    if ((this.options.sink === "file" || this.options.sink === "both") && this.options.filePath) {
      fs.appendFileSync(this.options.filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  public safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return this.redactor.text(raw).slice(0, 1000);
  }
}
