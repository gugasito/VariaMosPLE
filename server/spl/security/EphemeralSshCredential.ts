import crypto from "crypto";
import { SafeAuditLogger } from "./SafeAuditLogger";
import {
  EphemeralSshCredentialInput,
  EphemeralSshCredentialPayload,
} from "./SecureTypes";

export class EphemeralSshCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EphemeralSshCredentialError";
    Object.setPrototypeOf(this, EphemeralSshCredentialError.prototype);
  }
}

const SAFE_USERNAME = /^[^\u0000-\u001f\u007f]{1,256}$/;

export interface EphemeralSshCredentialLease {
  payload: EphemeralSshCredentialPayload;
  dispose(): void;
}

/**
 * Validates an exact, deliberately tiny request object. Registering the raw
 * secret before any later operation makes even downstream error messages
 * pass through the common redactor.
 */
export function createEphemeralSshCredential(
  raw: unknown,
  audit: SafeAuditLogger
): EphemeralSshCredentialLease {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const possible = raw as Record<string, unknown>;
    [possible.password, possible.privateKey, possible.passphrase].forEach((secret) => {
      if (typeof secret === "string") audit.redactor.registerSecret(secret);
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EphemeralSshCredentialError("Enter the SSH username and password or PEM credential for this attempt.");
  }
  const value = raw as Record<string, unknown>;
  try {
    const keys = Object.keys(value);
    const invalidPassword = (
      keys.length !== 3 ||
      !keys.includes("schemaVersion") ||
      !keys.includes("username") ||
      !keys.includes("password") ||
      value.schemaVersion !== "ssh-password/v1" ||
      typeof value.username !== "string" ||
      !SAFE_USERNAME.test(value.username) ||
      typeof value.password !== "string" ||
      value.password.length < 1 ||
      value.password.length > 4096 ||
      value.password.includes("\u0000")
    );
    const invalidPem = (
      (keys.length !== 3 && keys.length !== 4) ||
      !keys.includes("schemaVersion") || !keys.includes("username") || !keys.includes("privateKey") ||
      (keys.length === 4 && !keys.includes("passphrase")) ||
      value.schemaVersion !== "ssh-pem/v1" || typeof value.username !== "string" || !SAFE_USERNAME.test(value.username) ||
      typeof value.privateKey !== "string" || value.privateKey.length < 1 || value.privateKey.length > 64 * 1024 ||
      value.privateKey.includes("\u0000") ||
      !/^-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (?:RSA |ENCRYPTED )?PRIVATE KEY-----\s*$/u.test(value.privateKey) ||
      (value.passphrase !== undefined && (typeof value.passphrase !== "string" || value.passphrase.length > 4096 || value.passphrase.includes("\u0000")))
    );
    if (invalidPassword && invalidPem) {
      throw new EphemeralSshCredentialError("The one-time SSH credential is invalid.");
    }
    const payload: EphemeralSshCredentialPayload = !invalidPassword
      ? { schemaVersion: "ssh-password/v1", username: value.username as string, password: value.password as string }
      : { schemaVersion: "ssh-pem/v1", username: value.username as string, privateKey: value.privateKey as string, ...(typeof value.passphrase === "string" ? { passphrase: value.passphrase } : {}) };
    audit.redactor.registerPayload(payload);
    let disposed = false;
    return {
      payload,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // JavaScript strings cannot be zeroized in place. Overwriting every
        // application-owned reference is the best-effort cleanup boundary.
        if (payload.schemaVersion === "ssh-password/v1") {
          payload.password = crypto.randomBytes(32).toString("hex");
          payload.password = "";
        } else {
          payload.privateKey = crypto.randomBytes(32).toString("hex");
          payload.privateKey = "";
          if (payload.passphrase !== undefined) payload.passphrase = "";
        }
        payload.username = "";
      },
    };
  } finally {
    // Remove the password from the parsed HTTP request object immediately.
    if (typeof value.password === "string") value.password = "";
    if (typeof value.privateKey === "string") value.privateKey = "";
    if (typeof value.passphrase === "string") value.passphrase = "";
  }
}
