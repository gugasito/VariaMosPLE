import React, { useEffect, useState } from "react";
import * as alertify from "alertifyjs";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import Spinner from "react-bootstrap/Spinner";
import ProjectService from "../../Application/Project/ProjectService";
import {
  SplProjectAccess,
  SplRemoteTarget,
  SplRemoteTargetInput,
  SplTargetAdapterDefinition,
  createSplTarget,
  deleteSplTarget,
  getSplOrchestratorErrorMessage,
  getSplProjectAccess,
  getSplTargetAdapters,
  getSplTargets,
} from "../../DataProvider/Services/splOrchestratorService";
import { forgetEphemeralSshPem, rememberEphemeralSshPem } from "../../DataProvider/Services/ephemeralSshPemVault";

interface Props {
  projectService: ProjectService;
  onChanged?: () => void;
}

type WizardStep = 1 | 2 | 3 | 4;

const newTarget = (): SplRemoteTargetInput => ({
  id: "",
  name: "",
  adapter: "ssh-compose-v1",
  endpoint: { host: "", port: 22, sshHostKeyFingerprint: "" },
  remoteBasePath: "",
  publishedPort: 8080,
  publicBaseUrl: "",
  images: {},
  capabilities: [],
  authentication: { mode: "prompt-password", username: "" },
});

const STEP_LABELS: Array<{ step: WizardStep; title: string; caption: string }> = [
  { step: 1, title: "Type", caption: "What will be deployed" },
  { step: 2, title: "SSH login", caption: "Username and password" },
  { step: 3, title: "SSH server", caption: "Where VariaMos connects" },
  { step: 4, title: "Publish", caption: "How the product is exposed" },
];

function stableId(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function suggestedPublicUrl(host: string, port: number): string {
  if (!host || !Number.isInteger(port)) return "";
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}/`;
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <small className="d-block text-muted mt-1">{children}</small>;
}

/**
 * Owner-only setup for ephemeral password or PEM-authenticated SSH targets.
 */
export default function SplTargetManager({ projectService, onChanged }: Props) {
  const projectId = (projectService as Partial<ProjectService>).getProject?.()?.id || "";
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>(1);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [adapters, setAdapters] = useState<SplTargetAdapterDefinition[]>([]);
  const [access, setAccess] = useState<SplProjectAccess | null>(null);
  const [targets, setTargets] = useState<SplRemoteTarget[]>([]);
  const [target, setTarget] = useState<SplRemoteTargetInput>(newTarget);
  const [presetId, setPresetId] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [targetIdEdited, setTargetIdEdited] = useState(false);
  const [remotePathEdited, setRemotePathEdited] = useState(false);
  const [publicUrlEdited, setPublicUrlEdited] = useState(false);
  const [completedTarget, setCompletedTarget] = useState<SplRemoteTarget | null>(null);

  const adapter = adapters.find((item) => item.id === target.adapter) || adapters[0];
  const canManage = Boolean(access?.permissions.manageTargets);
  const busy = Boolean(working);

  const load = async () => {
    if (!projectId) return;
    setWorking("load");
    setError("");
    try {
      const [availableAdapters, projectAccess, projectTargets] = await Promise.all([
        getSplTargetAdapters(),
        getSplProjectAccess(projectId),
        getSplTargets(projectId),
      ]);
      setAdapters(availableAdapters);
      setAccess(projectAccess);
      setTargets(projectTargets);
    } catch (cause) {
      setAccess(null);
      setError(getSplOrchestratorErrorMessage(cause));
    } finally {
      setWorking("");
    }
  };

  useEffect(() => {
    if (open) void load();
    // Loading is tied to opening the owner tool, not editor rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  useEffect(() => {
    if (!adapter || presetId || !adapter.presets.length) return;
    const first = adapter.presets[0];
    setPresetId(first.id);
    setTarget((previous) => ({
      ...previous,
      adapter: adapter.id,
      publishedPort: first.defaultPublishedPort,
      images: { ...first.images },
      capabilities: [...first.capabilities],
    }));
  }, [adapter, presetId]);

  const resetWizard = () => {
    setStep(1);
    setTarget(newTarget());
    setPresetId("");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setTargetIdEdited(false);
    setRemotePathEdited(false);
    setPublicUrlEdited(false);
    setCompletedTarget(null);
    setError("");
  };

  const closeWizard = () => {
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setOpen(false);
  };

  const chooseAdapter = (definition: SplTargetAdapterDefinition) => {
    const first = definition.presets[0];
    setPresetId(first?.id || "");
    setTarget((previous) => ({
      ...previous,
      adapter: definition.id,
      ...(first ? {
        publishedPort: first.defaultPublishedPort,
        publicBaseUrl: publicUrlEdited
          ? previous.publicBaseUrl
          : suggestedPublicUrl(previous.endpoint.host, first.defaultPublishedPort),
        images: { ...first.images },
        capabilities: [...first.capabilities],
      } : {}),
    }));
  };

  const choosePreset = (id: string) => {
    const selected = adapter?.presets.find((item) => item.id === id);
    if (!selected) return;
    setPresetId(id);
    setTarget((previous) => ({
      ...previous,
      publishedPort: selected.defaultPublishedPort,
      publicBaseUrl: publicUrlEdited
        ? previous.publicBaseUrl
        : suggestedPublicUrl(previous.endpoint.host, selected.defaultPublishedPort),
      images: { ...selected.images },
      capabilities: [...selected.capabilities],
    }));
  };

  const changeName = (name: string) => {
    const generatedId = stableId(name);
    const nextId = targetIdEdited ? target.id : generatedId;
    setTarget((previous) => ({
      ...previous,
      name,
      id: nextId,
      remoteBasePath: remotePathEdited || !nextId
        ? previous.remoteBasePath
        : `/srv/variamos/${nextId}`,
    }));
  };

  const changeTargetId = (value: string) => {
    const id = stableId(value);
    setTargetIdEdited(true);
    setTarget((previous) => ({
      ...previous,
      id,
      remoteBasePath: remotePathEdited || !id
        ? previous.remoteBasePath
        : `/srv/variamos/${id}`,
    }));
  };

  const changeHost = (host: string) => {
    setTarget((previous) => ({
      ...previous,
      endpoint: { ...previous.endpoint, host },
      publicBaseUrl: publicUrlEdited
        ? previous.publicBaseUrl
        : suggestedPublicUrl(host, previous.publishedPort),
    }));
  };

  const changePublishedPort = (publishedPort: number) => {
    setTarget((previous) => ({
      ...previous,
      publishedPort,
      publicBaseUrl: publicUrlEdited
        ? previous.publicBaseUrl
        : suggestedPublicUrl(previous.endpoint.host, publishedPort),
    }));
  };

  const validateAndSaveTarget = async () => {
    setWorking("save-target");
    setError("");
    try {
      const credential = target.authentication.mode === "prompt-pem"
        ? { schemaVersion: "ssh-pem/v1" as const, username: target.authentication.username, privateKey, ...(passphrase ? { passphrase } : {}) }
        : { schemaVersion: "ssh-password/v1" as const, username: target.authentication.username, password };
      const created = await createSplTarget(projectId, target, credential);
      setPassword("");
      if (credential.schemaVersion === "ssh-pem/v1") {
        rememberEphemeralSshPem(created.id, created.revision, created.authentication.username, privateKey, passphrase || undefined);
      }
      setPrivateKey("");
      setPassphrase("");
      setCompletedTarget(created);
      await load();
      onChanged?.();
      alertify.success("SSH target validated and saved.");
    } catch (cause) {
      setError(getSplOrchestratorErrorMessage(cause));
    } finally {
      setWorking("");
    }
  };

  const deleteTarget = async (targetRef: string) => {
    if (!window.confirm(
      `Delete target "${targetRef}"?\n\nIts saved SSH connection configuration will be removed. Historical deployment and audit records will remain. This does not connect to the server or stop an already deployed product.`
    )) return;
    setWorking(`delete-${targetRef}`);
    setError("");
    try {
      const existing = targets.find((item) => item.id === targetRef);
      if (existing?.authentication.mode === "prompt-pem") {
        forgetEphemeralSshPem(existing.id, existing.revision, existing.authentication.username);
      }
      await deleteSplTarget(projectId, targetRef);
      await load();
      onChanged?.();
      alertify.success("Deployment target deleted.");
    } catch (cause) {
      setError(getSplOrchestratorErrorMessage(cause));
    } finally {
      setWorking("");
    }
  };

  const stepOneComplete = Boolean(target.name && target.id && target.adapter && presetId);
  const stepTwoComplete = Boolean(target.authentication.username && (target.authentication.mode === "prompt-pem" ? privateKey : password));

  const selectPem = async (file?: File): Promise<void> => {
    setError("");
    setPrivateKey("");
    if (!file) return;
    if (file.size > 64 * 1024) {
      setError("The PEM private key must be 64 KiB or smaller.");
      return;
    }
    try {
      setPrivateKey(await file.text());
    } catch (_error) {
      setError("The selected PEM private key could not be read.");
    }
  };
  const stepThreeComplete = Boolean(
    target.endpoint.host &&
    target.endpoint.port &&
    target.endpoint.sshHostKeyFingerprint &&
    target.remoteBasePath
  );
  const stepFourComplete = Boolean(
    target.publishedPort &&
    target.publicBaseUrl &&
    target.capabilities.length &&
    (target.capabilities.includes("static-http") ? target.images.nginx : true) &&
    (target.capabilities.includes("node-runtime") ? target.images.node : true)
  );

  return <>
    <Button size="sm" variant="outline-dark" onClick={() => setOpen(true)}>
      Manage deployment targets
    </Button>
    <Modal show={open} onHide={() => !busy && closeWizard()} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title>Deployment target assistant</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {working === "load" && <div className="d-flex align-items-center gap-2 mb-3">
          <Spinner animation="border" size="sm" /> Loading project deployment settings…
        </div>}
        {working !== "load" && !canManage && <div className="alert alert-info py-2">
          {access
            ? <>Your effective role is <strong>{access.role}</strong>. Only the project owner can create or delete deployment targets.</>
            : <>The server could not verify your project permissions. Management remains disabled.</>}
        </div>}

        <div className="row g-2 mb-4" aria-label="Target setup progress">
          {STEP_LABELS.map((item) => {
            const enabled = item.step === 1 ||
              (item.step === 2 && stepOneComplete) ||
              (item.step === 3 && stepOneComplete && stepTwoComplete) ||
              (item.step === 4 && stepOneComplete && stepTwoComplete && stepThreeComplete);
            return <div className="col-6 col-lg-3" key={item.step}>
              <button
                type="button"
                className={`btn w-100 text-start ${step === item.step ? "btn-primary" : "btn-outline-secondary"}`}
                disabled={!enabled || busy}
                aria-current={step === item.step ? "step" : undefined}
                onClick={() => setStep(item.step)}
              >
                <span className="badge bg-light text-dark me-2">{item.step}</span>
                <strong>{item.title}</strong>
                <small className="d-block mt-1 opacity-75">{item.caption}</small>
              </button>
            </div>;
          })}
        </div>

        {step === 1 && <section aria-labelledby="target-type-heading">
          <h5 id="target-type-heading">1. Choose the destination technology and application type</h5>
          <p className="text-muted">A target is the server where the tested product will run.</p>

          <label className="form-label fw-bold">Available target type *</label>
          <div className="row g-2 mb-3">
            {adapters.map((item) => <div className="col-md-6" key={item.id}>
              <button
                type="button"
                className={`btn border w-100 h-100 text-start p-3 ${target.adapter === item.id ? "border-primary bg-light" : "btn-light"}`}
                disabled={!canManage || busy || item.availability !== "available"}
                onClick={() => chooseAdapter(item)}
              >
                <strong>{item.name}</strong>
                <span className={`badge ms-2 ${item.availability === "available" ? "bg-success" : "bg-secondary"}`}>
                  {item.availability === "available" ? "Available" : "Disabled"}
                </span>
                <span className="d-block small text-muted mt-2">For Linux, macOS, VPS or cloud virtual machines with SSH, Docker and Docker Compose already installed.</span>
              </button>
            </div>)}
          </div>

          <label className="form-label fw-bold">What kind of application will this server run? *</label>
          <div className="row g-2 mb-3">
            {(adapter?.presets || []).map((item) => <div className="col-md-6" key={item.id}>
              <button
                type="button"
                className={`btn border w-100 h-100 text-start p-3 ${presetId === item.id ? "border-primary bg-light" : "btn-light"}`}
                disabled={!canManage || busy}
                onClick={() => choosePreset(item.id)}
              >
                <strong>{item.name}</strong>
                <span className="d-block small text-muted mt-2">{item.description}</span>
                <span className="d-block small mt-2">Runtime, capabilities and approved image are filled automatically.</span>
              </button>
            </div>)}
          </div>

          <div className="row g-3">
            <label className="col-md-8">Target name *
              <input className="form-control" disabled={!canManage || busy} value={target.name} onChange={(event) => changeName(event.target.value)} placeholder="Example: Main web server" />
              <FieldHelp>Choose a recognizable name. VariaMos generates the technical ID and suggested folder.</FieldHelp>
            </label>
            <label className="col-md-4">Usage (optional)
              <select
                className="form-select"
                disabled={!canManage || busy}
                value={target.environment || ""}
                onChange={(event) => setTarget((previous) => ({
                  ...previous,
                  environment: event.target.value
                    ? event.target.value as SplRemoteTargetInput["environment"]
                    : undefined,
                }))}
              >
                <option value="">Not specified</option>
                <option value="development">Development</option>
                <option value="staging">Staging</option>
                <option value="production">Production</option>
              </select>
              <FieldHelp>Only adds an operational label and an extra confirmation for production.</FieldHelp>
            </label>
          </div>

          <details className="mt-3">
            <summary>Advanced identity</summary>
            <label className="form-label mt-2">Target ID
              <input className="form-control" disabled={!canManage || busy} value={target.id} onChange={(event) => changeTargetId(event.target.value)} />
              <FieldHelp>Generated from the name. It cannot contain spaces.</FieldHelp>
            </label>
          </details>

          <div className="d-flex justify-content-end mt-4">
            <Button disabled={!canManage || busy || !stepOneComplete} onClick={() => setStep(2)}>Continue to SSH login</Button>
          </div>
        </section>}

        {step === 2 && <section aria-labelledby="ssh-login-heading">
          <h5 id="ssh-login-heading">2. Enter the SSH login method</h5>
          <div className="alert alert-info">
            VariaMos stores only the <strong>username</strong> and authentication method. Passwords and PEM keys are used temporarily, never saved in the target or browser storage.
          </div>
          <div className="row g-3">
            <label className="col-md-6">Authentication method *
              <select className="form-select" disabled={!canManage || busy} value={target.authentication.mode} onChange={(event) => {
                const mode = event.target.value as "prompt-password" | "prompt-pem";
                setPassword(""); setPrivateKey(""); setPassphrase("");
                setTarget((previous) => ({ ...previous, authentication: { mode, username: previous.authentication.username } }));
              }}>
                <option value="prompt-password">SSH password</option>
                <option value="prompt-pem">PEM private key</option>
              </select>
            </label>
            <label className="col-md-6">SSH username *
              <input
                className="form-control"
                autoComplete="username"
                disabled={!canManage || busy}
                value={target.authentication.username}
                onChange={(event) => setTarget((previous) => ({
                  ...previous,
                  authentication: { mode: previous.authentication.mode, username: event.target.value },
                }))}
                placeholder="Example: deployer or ubuntu"
              />
              <FieldHelp>The account used in <code>ssh usuario@servidor</code>.</FieldHelp>
            </label>
            {target.authentication.mode === "prompt-password" ? <label className="col-md-6">SSH password (used once) *
              <input
                type="password"
                className="form-control"
                autoComplete="new-password"
                disabled={!canManage || busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldHelp>Never saved in the project, target, browser storage, API response or logs.</FieldHelp>
            </label> : <>
              <label className="col-md-6">PEM private key (used temporarily) *
                <input type="file" className="form-control" accept=".pem,application/x-pem-file,text/plain" disabled={!canManage || busy} onChange={(event) => void selectPem(event.target.files?.[0])} />
                <FieldHelp>{privateKey ? "PEM key selected. It is kept only in this tab for up to 15 minutes." : "PEM PKCS#1 or PKCS#8, up to 64 KiB. It is sent only for validation or deployment and is never stored permanently."}</FieldHelp>
              </label>
              <label className="col-md-6">PEM passphrase (optional)
                <input type="password" className="form-control" autoComplete="new-password" disabled={!canManage || busy} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
                <FieldHelp>Required only when the selected PEM key is encrypted.</FieldHelp>
              </label>
            </>}
          </div>
          <div className="alert alert-warning small mt-3 mb-0">
            {target.authentication.mode === "prompt-password" ? "The SSH server must allow password authentication for this user." : "The SSH server must authorize the matching public key for this user."} Serve VariaMos over HTTPS in production so credentials are encrypted in transit.
          </div>
          <div className="d-flex justify-content-between mt-4">
            <Button variant="outline-secondary" disabled={busy} onClick={() => setStep(1)}>Back</Button>
            <Button disabled={!canManage || busy || !stepTwoComplete} onClick={() => setStep(3)}>Continue to SSH server</Button>
          </div>
        </section>}

        {step === 3 && <section aria-labelledby="ssh-heading">
          <h5 id="ssh-heading">3. Enter the SSH server information</h5>
          <p className="text-muted">Obtain these values from the server administrator or cloud/VPS provider.</p>
          <div className="row g-3">
            <label className="col-md-8">SSH host *
              <input className="form-control" disabled={!canManage || busy} value={target.endpoint.host} onChange={(event) => changeHost(event.target.value.trim())} placeholder="server.example.org or 203.0.113.20" />
              <FieldHelp>The server public IP or DNS name. Use 127.0.0.1 only when VariaMos and SSH run on the same machine.</FieldHelp>
            </label>
            <label className="col-md-4">SSH port *
              <input type="number" className="form-control" disabled={!canManage || busy} value={target.endpoint.port} onChange={(event) => setTarget((previous) => ({ ...previous, endpoint: { ...previous.endpoint, port: Number(event.target.value) } }))} />
              <FieldHelp>Usually 22.</FieldHelp>
            </label>
            <label className="col-12">SSH host-key fingerprint *
              <input className="form-control" disabled={!canManage || busy} value={target.endpoint.sshHostKeyFingerprint} onChange={(event) => setTarget((previous) => ({ ...previous, endpoint: { ...previous.endpoint, sshHostKeyFingerprint: event.target.value.trim() } }))} placeholder="SHA256:…" />
              <FieldHelp>This identifies the server, not the user. Ask the administrator for its Ed25519 SHA-256 fingerprint and verify it through a trusted channel.</FieldHelp>
            </label>
            <label className="col-12">Authorized deployment directory *
              <input
                className="form-control"
                disabled={!canManage || busy}
                value={target.remoteBasePath}
                onChange={(event) => {
                  setRemotePathEdited(true);
                  setTarget((previous) => ({ ...previous, remoteBasePath: event.target.value }));
                }}
              />
              <FieldHelp>Suggested automatically. The administrator must create it and make it writable by the SSH user. Do not use <code>/</code> or an entire home directory.</FieldHelp>
            </label>
          </div>
          <div className="alert alert-light border mt-3 small">
            Prerequisites: a dedicated non-root user, password login enabled, Docker and Docker Compose installed, access to Docker without passwordless sudo, and this authorized directory already created.
          </div>
          <div className="d-flex justify-content-between mt-4">
            <Button variant="outline-secondary" disabled={busy} onClick={() => setStep(2)}>Back</Button>
            <Button disabled={!canManage || busy || !stepThreeComplete} onClick={() => setStep(4)}>Continue to publication</Button>
          </div>
        </section>}

        {step === 4 && <section aria-labelledby="publish-heading">
          <h5 id="publish-heading">4. Review publication and validate the target</h5>
          <p className="text-muted">The application preset filled the runtime image and capabilities. Confirm the port and URL.</p>

          {completedTarget ? <div className="alert alert-success">
            <h5 className="alert-heading">Target ready</h5>
            <p className="mb-2"><strong>{completedTarget.name}</strong> was validated over SSH and saved as revision {completedTarget.revision}.</p>
            <Button size="sm" variant="success" onClick={resetWizard}>Add another target</Button>
          </div> : <>
            <div className="row g-3">
              <label className="col-md-4">Published port *
                <input type="number" className="form-control" disabled={!canManage || busy} value={target.publishedPort} onChange={(event) => changePublishedPort(Number(event.target.value))} />
                <FieldHelp>The external port users will reach. It must be free and allowed by the server firewall.</FieldHelp>
              </label>
              <label className="col-md-8">Public verification URL *
                <input
                  className="form-control"
                  disabled={!canManage || busy}
                  value={target.publicBaseUrl}
                  onChange={(event) => {
                    setPublicUrlEdited(true);
                    setTarget((previous) => ({ ...previous, publicBaseUrl: event.target.value }));
                  }}
                />
                <FieldHelp>Generated from host and port. Replace it with the final HTTPS domain when applicable.</FieldHelp>
              </label>
            </div>
            <div className="card mt-3">
              <div className="card-body py-3">
                <h6>Automatically selected configuration</h6>
                <div className="small"><strong>Capabilities:</strong> {target.capabilities.map((item) => <span className="badge bg-secondary ms-1" key={item}>{item}</span>)}</div>
                {target.images.nginx && <div className="small mt-2 text-break"><strong>Nginx image:</strong> <code>{target.images.nginx}</code></div>}
                {target.images.node && <div className="small mt-2 text-break"><strong>Node image:</strong> <code>{target.images.node}</code></div>}
              </div>
            </div>
            <div className="alert alert-secondary mt-3 mb-0 small">
              Validation checks the host allowlist, fingerprint, username/password, Docker, Compose, authorized directory and public destination policy. The target is stored only if every check passes. After an error, this form keeps the password only in component memory so you can correct the configuration and retry; the server discards its copy after every request.
            </div>
            <div className="d-flex justify-content-between mt-4">
              <Button variant="outline-secondary" disabled={busy} onClick={() => setStep(3)}>Back</Button>
              <Button
                variant="success"
                disabled={!canManage || busy || !stepTwoComplete || !stepFourComplete}
                onClick={validateAndSaveTarget}
              >
                {working === "save-target" ? <Spinner animation="border" size="sm" /> : "Validate and save target"}
              </Button>
            </div>
          </>}
        </section>}

        {error && <div className="alert alert-danger mt-3 mb-0" role="alert">{error}</div>}

        <hr className="my-4" />
        <details>
          <summary className="fw-bold">Existing SSH targets</summary>
          {targets.length === 0 ? <p className="text-muted mt-3">No password-authenticated remote target is registered for this project.</p> :
            <div className="table-responsive mt-3"><table className="table table-sm align-middle">
              <thead><tr><th>Name</th><th>Address</th><th>SSH user</th><th>Authentication</th><th>Usage</th><th>Revision</th><th>Status</th><th /></tr></thead>
              <tbody>{targets.map((item) => <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.endpoint.host}:{item.endpoint.port}</td>
                <td>{item.authentication.username}</td>
                <td>Password each deployment</td>
                <td>{item.environment || "Not specified"}</td>
                <td>{item.revision}</td>
                <td>{item.status}</td>
                <td><Button size="sm" variant="outline-danger" disabled={!canManage || busy} onClick={() => deleteTarget(item.id)}>Delete</Button></td>
              </tr>)}</tbody>
            </table></div>}
        </details>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" disabled={busy} onClick={closeWizard}>Close</Button>
      </Modal.Footer>
    </Modal>
  </>;
}
