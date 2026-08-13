/**
 * Browser-tab-only PEM cache. Deliberately module scoped: it is lost on refresh
 * and is never written to browser storage. Values are best-effort overwritten
 * before removal because JavaScript strings cannot be zeroized in place.
 */
const TTL_MS = 15 * 60 * 1000;

type PemCredential = { privateKey: string; passphrase?: string; expiresAt: number };
const entries = new Map<string, PemCredential>();

function key(targetId: string, revision: number, username: string): string {
  return `${targetId}\u0000${revision}\u0000${username}`;
}

function dispose(value: PemCredential): void {
  value.privateKey = "";
  if (value.passphrase !== undefined) value.passphrase = "";
}

export function rememberEphemeralSshPem(targetId: string, revision: number, username: string, privateKey: string, passphrase?: string): void {
  const entryKey = key(targetId, revision, username);
  const previous = entries.get(entryKey);
  if (previous) dispose(previous);
  entries.set(entryKey, { privateKey, ...(passphrase ? { passphrase } : {}), expiresAt: Date.now() + TTL_MS });
}

export function getEphemeralSshPem(targetId: string, revision: number, username: string): Omit<PemCredential, "expiresAt"> | undefined {
  const entryKey = key(targetId, revision, username);
  const value = entries.get(entryKey);
  if (!value) return undefined;
  if (Date.now() >= value.expiresAt) {
    dispose(value);
    entries.delete(entryKey);
    return undefined;
  }
  return { privateKey: value.privateKey, ...(value.passphrase ? { passphrase: value.passphrase } : {}) };
}

export function forgetEphemeralSshPem(targetId: string, revision: number, username: string): void {
  const entryKey = key(targetId, revision, username);
  const value = entries.get(entryKey);
  if (value) dispose(value);
  entries.delete(entryKey);
}

export function clearEphemeralSshPemVault(): void {
  entries.forEach(dispose);
  entries.clear();
}
