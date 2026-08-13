import http, { IncomingHttpHeaders } from "http";
import https from "https";
import { IncomingMessage } from "http";
import {
  AuthenticatedProjectActor,
  AuthorizationAction,
  ProjectRole,
} from "./SecureTypes";
import { SafeAuditLogger } from "./SafeAuditLogger";

export class AuthorizationError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "AuthorizationError";
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

export interface ProjectAuthorizer {
  authorize(
    request: IncomingMessage,
    projectId: string,
    action: AuthorizationAction
  ): Promise<AuthenticatedProjectActor>;
  reauthorize(
    actor: AuthenticatedProjectActor,
    projectId: string,
    action: AuthorizationAction
  ): Promise<AuthenticatedProjectActor>;
}

const POLICY: Record<AuthorizationAction, ProjectRole[]> = {
  "metadata:read": ["owner", "editor", "viewer"],
  "project:import": ["owner", "editor"],
  "derivation:plan": ["owner", "editor"],
  "derivation:build": ["owner", "editor"],
  "target:manage": ["owner"],
  "credential:manage": ["owner"],
  "deployment:manage": ["owner"],
};

function assertAllowed(
  actor: AuthenticatedProjectActor,
  action: AuthorizationAction,
  audit: SafeAuditLogger
): AuthenticatedProjectActor {
  const allowed = POLICY[action].includes(actor.role);
  audit.record({
    event: "authorization.decision",
    result: allowed ? "allowed" : "denied",
    actorId: actor.userId,
    projectId: actor.projectId,
    details: { action, role: actor.role },
  });
  if (!allowed) throw new AuthorizationError(403, "Your project role does not allow this operation.");
  return actor;
}

export interface VariaMosProjectAuthorizerOptions {
  sessionInfoUrl: string;
  projectInfoUrl: string;
  timeoutMs?: number;
  audit: SafeAuditLogger;
}

interface JsonResponse {
  statusCode: number;
  body: unknown;
}

function requestJson(
  urlValue: string,
  headers: IncomingHttpHeaders,
  timeoutMs: number
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      headers,
      timeout: timeoutMs,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (raw.length < 1024 * 1024) raw += chunk;
      });
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode || 500,
            body: raw ? JSON.parse(raw) : {},
          });
        } catch (_error) {
          reject(new AuthorizationError(503, "The identity service returned an invalid response."));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("identity request timed out")));
    request.on("error", reject);
    request.end();
  });
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? header.match(/^Bearer ([^\s]+)$/) : null;
  if (!match) throw new AuthorizationError(401, "A valid Bearer token is required.");
  return match[1];
}

function unwrap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const object = value as Record<string, unknown>;
  for (const key of ["data", "response", "result"]) {
    const nested = object[key];
    if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  }
  return object;
}

function findUser(value: unknown): { id: string; displayName?: string } | undefined {
  const root = unwrap(value);
  const candidate = (root.user && typeof root.user === "object"
    ? root.user
    : root.session && typeof root.session === "object"
      ? (root.session as Record<string, unknown>).user
      : root) as Record<string, unknown> | undefined;
  if (!candidate) return undefined;
  const id = candidate.id || candidate.userId || candidate.user_id || candidate.sub;
  if (typeof id !== "string" || !id) return undefined;
  const displayName = candidate.name || candidate.username || candidate.email;
  return { id, ...(typeof displayName === "string" ? { displayName } : {}) };
}

function normalizeRole(value: unknown): ProjectRole | undefined {
  return value === "owner" || value === "editor" || value === "viewer" ? value : undefined;
}

function findProjectRole(value: unknown, userId: string): ProjectRole | undefined {
  const root = unwrap(value);
  const directRoot = normalizeRole(root.currentUserRole || root.role);
  if (directRoot) return directRoot;
  const project = (root.project && typeof root.project === "object"
    ? root.project
    : root) as Record<string, unknown>;
  const direct = normalizeRole(project.currentUserRole || project.role);
  if (direct) return direct;
  const ownerId = project.owner_id || project.ownerId;
  if (ownerId !== undefined && String(ownerId) === String(userId)) return "owner";
  const collaborators = Array.isArray(project.collaborators)
    ? project.collaborators
    : Array.isArray(root.collaborators)
      ? root.collaborators
      : [];
  const collaborator = collaborators.find((item) => {
    if (!item || typeof item !== "object") return false;
    const object = item as Record<string, unknown>;
    const collaboratorId = object.id || object.userId || object.user_id;
    return collaboratorId !== undefined && String(collaboratorId) === String(userId);
  }) as Record<string, unknown> | undefined;
  return normalizeRole(collaborator?.role);
}

export class VariaMosProjectAuthorizer implements ProjectAuthorizer {
  constructor(private readonly options: VariaMosProjectAuthorizerOptions) {}

  public async authorize(
    request: IncomingMessage,
    projectId: string,
    action: AuthorizationAction
  ): Promise<AuthenticatedProjectActor> {
    try {
      const token = bearerToken(request);
      return this.authorizeToken(token, projectId, action);
    } catch (error) {
      this.options.audit.record({
        event: "authentication.session",
        result: "failed",
        projectId,
        details: { reason: "missing-or-invalid-bearer" },
      });
      throw error;
    }
  }

  public async reauthorize(
    actor: AuthenticatedProjectActor,
    projectId: string,
    action: AuthorizationAction
  ): Promise<AuthenticatedProjectActor> {
    if (!actor.token) throw new AuthorizationError(401, "The VariaMos session cannot be revalidated.");
    return this.authorizeToken(actor.token, projectId, action);
  }

  private async authorizeToken(
    token: string,
    projectId: string,
    action: AuthorizationAction
  ): Promise<AuthenticatedProjectActor> {
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    try {
      const session = await requestJson(
        this.options.sessionInfoUrl,
        headers,
        this.options.timeoutMs || 7000
      );
      if (session.statusCode === 401 || session.statusCode === 403) {
        throw new AuthorizationError(401, "The VariaMos session is missing or expired.");
      }
      if (session.statusCode < 200 || session.statusCode >= 300) {
        throw new AuthorizationError(503, "The identity service is unavailable.");
      }
      const user = findUser(session.body);
      if (!user) throw new AuthorizationError(401, "The VariaMos session is invalid.");
      this.options.audit.record({
        event: "authentication.session",
        result: "succeeded",
        actorId: user.id,
        projectId,
      });

      const projectUrl = new URL(this.options.projectInfoUrl);
      projectUrl.searchParams.set("project_id", projectId);
      const project = await requestJson(
        projectUrl.toString(),
        headers,
        this.options.timeoutMs || 7000
      );
      if (project.statusCode < 200 || project.statusCode >= 300) {
        throw new AuthorizationError(503, "The project permission service is unavailable.");
      }
      const role = findProjectRole(project.body, user.id);
      if (!role) throw new AuthorizationError(403, "No project role is assigned to this user.");
      return assertAllowed({
        userId: user.id,
        displayName: user.displayName,
        role,
        projectId,
        token,
      }, action, this.options.audit);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        this.options.audit.record({
          event: error.statusCode === 403 ? "authorization.decision" : "authentication.session",
          result: "denied",
          projectId,
          details: {
            action,
            reason: error.statusCode === 403
              ? "project-role-unavailable"
              : "session-or-identity-unavailable",
          },
        });
        throw error;
      }
      this.options.audit.record({
        event: "authentication.session",
        result: "failed",
        projectId,
        details: { reason: "identity-service-unavailable" },
      });
      throw new AuthorizationError(503, "Authentication could not be verified.");
    }
  }
}
