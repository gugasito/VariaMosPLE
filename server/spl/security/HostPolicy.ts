import dns from "dns";
import net from "net";

export class HostPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostPolicyError";
    Object.setPrototypeOf(this, HostPolicyError.prototype);
  }
}

function ipv4Number(value: string): number | undefined {
  if (net.isIP(value) !== 4) return undefined;
  return value.split(".").reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
}

function matchesIpv4Cidr(address: string, cidr: string): boolean {
  const [networkValue, bitsValue] = cidr.split("/");
  const addressNumber = ipv4Number(address);
  const networkNumber = ipv4Number(networkValue);
  const bits = Number(bitsValue);
  if (addressNumber === undefined || networkNumber === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addressNumber & mask) === (networkNumber & mask);
}

function matchesHost(host: string, rule: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const normalizedRule = rule.toLowerCase().replace(/\.$/, "");
  if (normalizedRule.startsWith("*.")) {
    const suffix = normalizedRule.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedRule;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    return [
      "10.0.0.0/8",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "224.0.0.0/4",
    ].some((cidr) => matchesIpv4Cidr(address, cidr));
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

export interface AuthorizedHost {
  host: string;
  addresses: string[];
  connectAddress: string;
}

export class HostPolicy {
  private readonly rules: string[];

  constructor(rules: string[], private readonly label: string) {
    this.rules = rules.map((item) => item.trim()).filter(Boolean);
  }

  public configured(): boolean {
    return this.rules.length > 0;
  }

  public async authorize(host: string): Promise<AuthorizedHost> {
    if (!host || host.length > 253 || /[\s/@\\]/.test(host)) {
      throw new HostPolicyError(`The ${this.label} host is invalid.`);
    }
    if (!this.configured()) throw new HostPolicyError(`The ${this.label} allowlist is not configured.`);
    const hostAllowed = this.rules.some((rule) =>
      !rule.includes("/") && matchesHost(host, rule)
    );
    let addresses: string[];
    try {
      addresses = (await dns.promises.lookup(host, { all: true, verbatim: true }))
        .map((item) => item.address);
    } catch (_error) {
      throw new HostPolicyError(`The ${this.label} host could not be resolved.`);
    }
    const uniqueAddresses = [...new Set(addresses)];
    if (!uniqueAddresses.length) throw new HostPolicyError(`The ${this.label} host has no addresses.`);
    uniqueAddresses.forEach((address) => {
      const addressAllowed = this.rules.some((rule) =>
        rule.includes("/") ? matchesIpv4Cidr(address, rule) : matchesHost(address, rule)
      );
      if (!hostAllowed && !addressAllowed) {
        throw new HostPolicyError(`The ${this.label} host is not allowed.`);
      }
      if (isPrivateAddress(address) && !addressAllowed) {
        throw new HostPolicyError(`The ${this.label} host resolves to an internal address that is not explicitly allowed.`);
      }
    });
    return { host, addresses: uniqueAddresses, connectAddress: uniqueAddresses[0] };
  }
}
