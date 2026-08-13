import React, { ChangeEvent, useRef, useState } from "react";
import * as alertify from "alertifyjs";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import Spinner from "react-bootstrap/Spinner";
import ProjectService from "../../Application/Project/ProjectService";
import { createSplMapping, SplProfileSummary } from "../../Application/SPL/SplMappingFactory";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import {
  SplProjectConnectionInput,
  SplProjectConnectionResult,
  SplProjectSourceId,
  SplProjectSourceOption,
  SplCredentialBinding,
  SplRemoteTarget,
  getSplCredentialBindings,
  getSplProjectSources,
  getSplRuntimeCapabilities,
  getSplTargets,
  getSplOrchestratorErrorMessage,
  importSplProject,
  saveSplProjectConnection,
  uploadSplProjectFolder,
  validateSplDescriptor,
  validateSplProjectConnection,
} from "../../DataProvider/Services/splOrchestratorService";
import SplTargetManager from "./SplTargetManager";

interface Props {
  projectService: ProjectService;
  featureModel: Model;
  onImported?: (mapping: Model) => void;
  onTargetsChanged?: () => void;
}

type Mode = "connect" | "descriptor" | null;
type DescriptorCheck = Awaited<ReturnType<typeof validateSplDescriptor>>;
interface ConnectionDraft {
  id: string;
  repositoryUrl: string;
  requestedRef: string;
  descriptorPath: string;
  credentialRef: string;
  sshHostKeyFingerprint: string;
}

const DESCRIPTOR_TEMPLATE_URL = `${process.env.PUBLIC_URL || ""}/templates/spl.json`;
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const DEFAULT_PROJECT_SOURCES: SplProjectSourceOption[] = [
  {
    id: "git-remote",
    provider: "git",
    name: "Remote Git repository",
    availability: "available",
    descriptorPath: ".variamos/spl.json",
    supportsCredentialRef: true,
    help: "HTTPS or SSH URL from GitHub, GitLab, Bitbucket, or another Git server.",
    plannedFields: ["repositoryUrl", "requestedRef", "descriptorPath", "credentialRef"],
  },
  {
    id: "folder-upload",
    provider: "upload",
    name: "Upload project folder",
    availability: "available",
    descriptorPath: ".variamos/spl.json",
    supportsCredentialRef: false,
    help: "Transfers only .variamos/spl.json and its declared artifacts to VariaMos temporarily.",
    plannedFields: ["uploadId", "snapshotDigest", "descriptorDigest"],
  },
];

function availabilityPresentation(availability: SplProjectSourceOption["availability"]) {
  if (availability === "available") return { label: "Available", className: "bg-success" };
  if (availability === "configuration-required") return { label: "Configuration required", className: "bg-warning text-dark" };
  return { label: "In development", className: "bg-secondary" };
}

function suggestedId(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);
}

/** Real project onboarding: creates connections in the orchestrator and stores
 * only public catalog and target IDs in the model. */
export default function SplProjectOnboarding({ projectService, featureModel, onImported, onTargetsChanged }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<ConnectionDraft>({
    id: suggestedId(featureModel.name || featureModel.id) || "project-connection",
    repositoryUrl: "",
    requestedRef: "main",
    descriptorPath: ".variamos/spl.json",
    credentialRef: "",
    sshHostKeyFingerprint: "",
  });
  const [validated, setValidated] = useState<SplProjectConnectionResult | null>(null);
  const [profileId, setProfileId] = useState("");
  const [descriptorText, setDescriptorText] = useState("");
  const [descriptorFileName, setDescriptorFileName] = useState("bundled template");
  const [descriptorCheck, setDescriptorCheck] = useState<DescriptorCheck | null>(null);
  const [selectedSource, setSelectedSource] = useState<SplProjectSourceId>("git-remote");
  const [projectSources, setProjectSources] = useState<SplProjectSourceOption[]>(DEFAULT_PROJECT_SOURCES);
  const [sourceCatalogWarning, setSourceCatalogWarning] = useState("");
  const [credentialBindings, setCredentialBindings] = useState<SplCredentialBinding[]>([]);
  const [remoteTargets, setRemoteTargets] = useState<SplRemoteTarget[]>([]);
  const [localTargetsEnabled, setLocalTargetsEnabled] = useState(false);
  const [targetRef, setTargetRef] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [uploadSummary, setUploadSummary] = useState<{ files: number; bytes: number; expiresAt: string; snapshotDigest: string } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Array<{ relativePath: string; file: File }>>([]);
  const uploadAbort = useRef<AbortController | null>(null);
  const projectId = (projectService as Partial<ProjectService>).getProject?.()?.id || "";

  const sourceOption = projectSources.find((item) => item.id === selectedSource)
    || DEFAULT_PROJECT_SOURCES[0];
  const isGitSource = selectedSource === "git-remote";
  const selectedProfile = validated?.descriptor.profiles.find((profile) => profile.id === profileId);
  const requiredTargetCapabilities = selectedProfile
    ? new Set([
      ...selectedProfile.requiredTargetCapabilities,
      ...validated!.descriptor.artifacts
        .filter((artifact) => !selectedProfile.artifactIds || selectedProfile.artifactIds.includes(artifact.id))
        .flatMap((artifact) => artifact.requiresCapabilities || []),
    ])
    : new Set<string>();
  const compatibleRemoteTargets = remoteTargets.filter((target) =>
    [...requiredTargetCapabilities].every((capability) => target.capabilities.includes(capability))
  );

  const close = () => { if (!working) { setMode(null); setError(""); } };
  const updateConnection = (name: keyof ConnectionDraft, value: string) => {
    setValidated(null);
    setConnection((previous) => ({ ...previous, [name]: value }));
  };

  const loadProjectSources = async () => {
    setSourceCatalogWarning("");
    try {
      const [sources, bindings, targets, runtime] = await Promise.all([
        getSplProjectSources(),
        projectId ? getSplCredentialBindings(projectId).catch(() => []) : Promise.resolve([]),
        projectId ? getSplTargets(projectId).catch(() => []) : Promise.resolve([]),
        getSplRuntimeCapabilities(),
      ]);
      setProjectSources(DEFAULT_PROJECT_SOURCES.map(
        (fallback) => sources.find((source) => source.id === fallback.id) || fallback
      ));
      setCredentialBindings(bindings);
      setRemoteTargets(targets.filter((item) => item.status === "active"));
      setLocalTargetsEnabled(runtime.localTargetsEnabled);
    } catch (_cause) {
      setLocalTargetsEnabled(false);
      setSourceCatalogWarning("Provider status could not be retrieved. The built-in source catalog is shown instead.");
    }
  };

  const openConnectionTool = () => {
    setMode("connect");
    setError("");
    setValidated(null);
    void loadProjectSources();
  };

  const selectSource = (sourceId: SplProjectSourceId) => {
    setSelectedSource(sourceId);
    setValidated(null);
    setProfileId("");
    setError("");
    setConnection((previous) => ({
      ...previous,
      repositoryUrl: "",
      credentialRef: "",
      sshHostKeyFingerprint: "",
    }));
  };

  const connectionInput = (
    expected?: SplProjectConnectionResult
  ): SplProjectConnectionInput => {
    if (selectedSource === "folder-upload") {
      return {
        id: connection.id,
        projectId,
        provider: "upload",
        uploadId,
        descriptorPath: connection.descriptorPath,
        ...(expected?.connection.provider === "upload"
          ? {
            expectedSnapshotDigest: expected.connection.snapshotDigest,
            expectedDescriptorDigest: expected.connection.descriptorDigest,
          }
          : {}),
      };
    }
    return {
      id: connection.id,
      projectId,
      provider: "git",
      repositoryUrl: connection.repositoryUrl,
      requestedRef: connection.requestedRef,
      descriptorPath: connection.descriptorPath,
      credentialRef: connection.credentialRef.trim() || undefined,
      sshHostKeyFingerprint:
        (/^git@/.test(connection.repositoryUrl) || /^ssh:\/\//.test(connection.repositoryUrl))
        ? connection.sshHostKeyFingerprint.trim() || undefined
        : undefined,
      ...(expected?.connection.provider === "git"
        ? {
          expectedResolvedCommit: expected.connection.resolvedCommit,
          expectedDescriptorDigest: expected.connection.descriptorDigest,
        }
        : {}),
    };
  };

  const validateConnection = async () => {
    setWorking(true); setError("");
    try {
      const result = await validateSplProjectConnection(connectionInput());
      setValidated(result);
      setProfileId(result.descriptor.profiles[0]?.id || "");
      setTargetRef("");
      alertify.success(result.connection.provider === "git"
        ? "Connection and descriptor validated against an immutable commit."
        : "Folder upload and descriptor validated against an immutable snapshot.");
    } catch (cause) { setError(getSplOrchestratorErrorMessage(cause)); }
    finally { setWorking(false); }
  };

  const selectFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    setValidated(null); setUploadId(""); setUploadSummary(null); setSelectedFiles([]); setError("");
    const normalized = files.map((file) => {
      const original = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const components = original.split("/");
      return { relativePath: components.length > 1 ? components.slice(1).join("/") : original, file };
    });
    const descriptor = normalized.find((entry) => entry.relativePath === ".variamos/spl.json");
    if (!descriptor) { setError("The selected folder must contain .variamos/spl.json."); return; }
    try {
      const parsed = JSON.parse(await descriptor.file.text()) as { artifacts?: Array<{ source?: { path?: string } }> };
      const paths = new Set([".variamos/spl.json", ...(parsed.artifacts || []).map((artifact) => artifact.source?.path || "")]);
      const chosen = normalized.filter((entry) => paths.has(entry.relativePath));
      const missing = [...paths].filter((entry) => !normalized.some((file) => file.relativePath === entry));
      if (missing.length) { setError(`Declared files are missing: ${missing.join(", ")}`); return; }
      if (chosen.length !== paths.size) { setError("The descriptor contains duplicate or invalid artifact paths."); return; }
      setSelectedFiles(chosen);
    } catch (_error) { setError(".variamos/spl.json must contain valid JSON."); }
  };

  const uploadFolder = async () => {
    if (!projectId || !selectedFiles.length) return;
    setWorking(true); setError(""); setUploadProgress(0);
    uploadAbort.current = new AbortController();
    try {
      const result = await uploadSplProjectFolder(projectId, selectedFiles, setUploadProgress, uploadAbort.current.signal);
      setUploadId(result.upload.uploadId);
      setUploadSummary({ files: result.upload.fileCount, bytes: result.upload.totalBytes, expiresAt: result.upload.expiresAt, snapshotDigest: result.upload.snapshotDigest });
      alertify.success("Project folder uploaded to the VariaMos backend temporarily.");
    } catch (cause) { setError(getSplOrchestratorErrorMessage(cause)); }
    finally { uploadAbort.current = null; setUploadProgress(null); setWorking(false); }
  };

  const importProject = async () => {
    if (!validated || !profileId) return;
    setWorking(true); setError("");
    try {
      await saveSplProjectConnection(connectionInput(validated));
      const profile: SplProfileSummary = await importSplProject(
        connection.id,
        profileId,
        projectId,
        targetRef || undefined
      );
      const mapping = createSplMapping(featureModel, profile);
      const productLine = projectService.getProductLineSelected();
      productLine.applicationEngineering.models.push(mapping);
      if (!productLine.applicationEngineering.languagesAllowed.includes(mapping.languageId)) {
        productLine.applicationEngineering.languagesAllowed.push(mapping.languageId);
      }
      projectService.saveProject();
      projectService.raiseEventApplicationEngineeringModel(mapping);
      projectService.modelApplicationEngSelected(projectService.getIdCurrentProductLine(), productLine.applicationEngineering.models.indexOf(mapping));
      onImported?.(mapping);
      alertify.success("Project imported. Confirm the feature-to-artifact bindings next.");
      setMode(null);
    } catch (cause) { setError(getSplOrchestratorErrorMessage(cause)); }
    finally { setWorking(false); }
  };

  const loadBundledTemplate = async () => {
    setWorking(true); setError(""); setDescriptorCheck(null);
    try {
      const response = await fetch(DESCRIPTOR_TEMPLATE_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`The template returned HTTP ${response.status}.`);
      const text = await response.text();
      JSON.parse(text);
      setDescriptorText(text.endsWith("\n") ? text : `${text}\n`);
      setDescriptorFileName("bundled template");
    } catch (cause) {
      setError(`The bundled template could not be loaded. ${cause instanceof Error ? cause.message : ""}`.trim());
    } finally { setWorking(false); }
  };

  const openDescriptorTool = () => {
    setMode("descriptor");
    setError("");
    if (!descriptorText) void loadBundledTemplate();
  };

  const loadDescriptorFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(""); setDescriptorCheck(null);
    if (file.size > MAX_DESCRIPTOR_BYTES) {
      setError("The descriptor exceeds the 1 MiB limit.");
      return;
    }
    try {
      const text = await file.text();
      setDescriptorText(text);
      setDescriptorFileName(file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The selected file could not be read.");
    }
  };

  const validateDescriptor = async () => {
    setWorking(true); setError(""); setDescriptorCheck(null);
    try {
      const candidate: unknown = JSON.parse(descriptorText);
      const validation = await validateSplDescriptor(candidate, true, projectId || undefined);
      setDescriptorCheck(validation);
      if (validation.valid) alertify.success("The descriptor is valid and ready to connect.");
    } catch (cause) {
      if (cause instanceof SyntaxError) {
        setDescriptorCheck({ valid: false, errors: [`Invalid JSON: ${cause.message}`] });
      } else {
        setError(getSplOrchestratorErrorMessage(cause));
      }
    } finally { setWorking(false); }
  };

  const copyDescriptor = async () => {
    await navigator.clipboard.writeText(descriptorText);
    alertify.success("Descriptor copied.");
  };

  const downloadTemplate = () => {
    const anchor = document.createElement("a");
    anchor.href = DESCRIPTOR_TEMPLATE_URL;
    anchor.download = "spl.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return <>
    <div className="d-flex flex-wrap gap-2 mt-2">
      <Button size="sm" variant="outline-primary" onClick={openConnectionTool}>Connect project</Button>
      <Button size="sm" variant="outline-secondary" onClick={openDescriptorTool}>Template and validator</Button>
      {(projectService as Partial<ProjectService>).getProject &&
        <SplTargetManager projectService={projectService} onChanged={onTargetsChanged} />}
    </div>
    <Modal show={mode !== null} onHide={close} size="lg" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title>{mode === "connect" ? "Connect an external project" : "spl.json template and validator"}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {mode === "connect" ? <>
          <p>
            Choose a remote Git repository or upload a project folder from this browser.
            VariaMos never reads a path from the backend host for uploaded projects.
          </p>
          {!projectId && <div className="alert alert-warning py-2" role="status">
            Save or open a VariaMos project first. Authentication and project permissions
            must be verified before a source can be connected.
          </div>}
          <fieldset className="mb-3">
            <legend className="h6">Source type</legend>
            <div className="row g-2" role="radiogroup" aria-label="Project source type">
              {projectSources.map((source) => {
                const presentation = availabilityPresentation(source.availability);
                const selected = selectedSource === source.id;
                return <div className="col-md-6" key={source.id}>
                  <label className={`d-block border rounded p-2 h-100 ${selected ? "border-primary bg-light" : ""}`}>
                    <div className="d-flex align-items-start gap-2">
                      <input
                        className="form-check-input mt-1"
                        type="radio"
                        name="project-source"
                        value={source.id}
                        checked={selected}
                        onChange={() => selectSource(source.id)}
                      />
                      <span className="flex-grow-1">
                        <span className="d-flex flex-wrap justify-content-between gap-1">
                          <strong>{source.name}</strong>
                          <span className={`badge ${presentation.className}`}>{presentation.label}</span>
                        </span>
                        <span className="d-block small text-muted mt-1">{source.help}</span>
                      </span>
                    </div>
                  </label>
                </div>;
              })}
            </div>
          </fieldset>

          {sourceCatalogWarning && <div className="alert alert-warning py-2">{sourceCatalogWarning}</div>}

          {isGitSource ? <>
            <div className="alert alert-info py-2">
              The VariaMos backend creates a temporary workspace, pins the branch or tag to an immutable commit, and removes that workspace when the operation finishes.
            </div>
            <label className="d-block mb-2">
              Connection ID *
              <input className="form-control" value={connection.id} onChange={(event) => updateConnection("id", event.target.value)} />
            </label>
            <label className="d-block mb-2">
              Remote Git repository URL *
              <input
                className="form-control"
                aria-label="Remote Git repository URL"
                placeholder="https://git.example.org/team/project.git"
                value={connection.repositoryUrl}
                onChange={(event) => updateConnection("repositoryUrl", event.target.value)}
              />
              <small className="text-muted">
                HTTPS, ssh://, and git@host:organization/repository.git are supported.
              </small>
            </label>
            <div className="row">
              <label className="col-md-6 mb-2">
                Branch, tag, or commit *
                <input className="form-control" value={connection.requestedRef} onChange={(event) => updateConnection("requestedRef", event.target.value)} />
              </label>
              <label className="col-md-6 mb-2">
                Descriptor path *
                <input className="form-control" value={connection.descriptorPath} onChange={(event) => updateConnection("descriptorPath", event.target.value)} />
              </label>
            </div>
            <>
              <label className="d-block mb-2">
                Credential reference (optional for public HTTPS)
                <input
                  className="form-control"
                  aria-label="Credential reference"
                  list="spl-source-credential-bindings"
                  placeholder="Public repository — no credential"
                  value={connection.credentialRef || ""}
                  onChange={(event) => updateConnection("credentialRef", event.target.value)}
                />
                <datalist id="spl-source-credential-bindings">
                  {credentialBindings
                    .filter((item) => item.status === "active" && item.purpose === "source-read")
                    .map((item) => <option value={item.ref} key={item.id}>{item.alias} — {item.credentialType}</option>)}
                </datalist>
                <small className="text-muted">Only references registered from AWS Secrets Manager appear here. Secret values never enter this form.</small>
              </label>
              {(/^git@/.test(connection.repositoryUrl) || /^ssh:\/\//.test(connection.repositoryUrl)) &&
                <label className="d-block mb-2">
                  SSH host-key fingerprint *
                  <input className="form-control" placeholder="SHA256:…" value={connection.sshHostKeyFingerprint} onChange={(event) => updateConnection("sshHostKeyFingerprint", event.target.value)} />
                  <small className="text-muted">The clone is rejected if the server presents a different host key.</small>
                </label>}
            </>
            <Button size="sm" disabled={working || !projectId || !connection.repositoryUrl.trim()} onClick={validateConnection}>
              {working ? <Spinner animation="border" size="sm" /> : "Validate remote repository"}
            </Button>
          </> : <>
            <div className="alert alert-info py-2">
              Select a folder from your computer. VariaMos transfers only <code>.variamos/spl.json</code> and the artifacts declared by it.
              Git history, <code>node_modules</code>, other files, and secrets are not transferred. The snapshot expires after 24 hours.
            </div>
            {sourceOption.availability === "configuration-required" &&
              <div className="alert alert-warning py-2" role="status">
                Folder upload is disabled in this VariaMos backend. The operator must enable
                {" "}<code>SPL_FOLDER_UPLOAD_ENABLED=true</code>.
              </div>}
            <label className="d-block mb-2">
              Connection ID *
              <input className="form-control" value={connection.id} onChange={(event) => updateConnection("id", event.target.value)} />
            </label>
            <label className="d-block mb-2">
              Project folder *
              <input className="form-control" aria-label="Project folder" type="file" multiple ref={(node) => { if (node) node.setAttribute("webkitdirectory", ""); }} onChange={selectFolder} />
              <small className="text-muted">Only the declared descriptor and artifacts are selected for upload.</small>
            </label>
            {selectedFiles.length > 0 && <div className="small mb-2">Descriptor found; {selectedFiles.length} files selected ({selectedFiles.reduce((total, entry) => total + entry.file.size, 0).toLocaleString()} bytes).</div>}
            {uploadProgress !== null && <div className="progress mb-2"><div className="progress-bar" style={{ width: `${uploadProgress}%` }}>{uploadProgress}%</div></div>}
            <div className="d-flex gap-2">
              <Button size="sm" disabled={working || !projectId || !selectedFiles.length || sourceOption.availability === "configuration-required"} onClick={uploadFolder}>{working ? <Spinner animation="border" size="sm" /> : "Upload project folder"}</Button>
              {uploadAbort.current && <Button size="sm" variant="outline-secondary" onClick={() => uploadAbort.current?.abort()}>Cancel upload</Button>}
              {uploadId && <Button size="sm" variant="outline-primary" disabled={working} onClick={validateConnection}>Validate uploaded folder</Button>}
            </div>
            {uploadSummary && <div className="alert alert-success py-2 mt-2 mb-0">Uploaded snapshot <code>{uploadSummary.snapshotDigest}</code>. It expires at {new Date(uploadSummary.expiresAt).toLocaleString()}.</div>}
          </>}

          {validated && <div className="border rounded p-3 mt-3">
            <div><strong>Source:</strong> {validated.connection.provider === "git"
              ? "Remote Git"
              : "Uploaded project folder"}</div>
            {validated.connection.provider === "git"
              ? <div><strong>Pinned commit:</strong> <code>{validated.connection.resolvedCommit}</code></div>
              : <div><strong>Pinned snapshot:</strong> <code>{validated.connection.snapshotDigest}</code></div>}
            <div><strong>Descriptor:</strong> {validated.connection.descriptorPath}</div>
            <div><strong>Artifacts:</strong> {validated.descriptor.artifacts.length}</div>
            <label className="d-block mt-2">Profile to import<select className="form-select" value={profileId} onChange={(event) => setProfileId(event.target.value)}>{validated.descriptor.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} — {profile.builderAdapter}</option>)}</select></label>
            <label className="d-block mt-2">Deployment target (optional when importing)
              <select className="form-select" value={targetRef} onChange={(event) => setTargetRef(event.target.value)}>
                {localTargetsEnabled && <option value="">Default compatible local target</option>}
                {!localTargetsEnabled && <option value="" disabled>{compatibleRemoteTargets.length
                  ? "Select a compatible external target"
                  : "No compatible external target available"}</option>}
                {compatibleRemoteTargets.map((item) => <option key={item.id} value={item.id}>
                    {item.name}{item.environment ? ` — ${item.environment}` : ""} (rev. {item.revision})
                  </option>)}
              </select>
              <small className="text-muted">{localTargetsEnabled
                ? "The selected target becomes the mapping default. It can be changed before planning without reimporting the catalog."
                : "You can import without a target. Before the first Plan, select an active compatible external target in SPL Deployment."}</small>
            </label>
            <details className="mt-2"><summary>Declared artifacts</summary><ul>{validated.descriptor.artifacts.map((artifact) => <li key={artifact.id}><code>{artifact.id}</code> — {artifact.label || artifact.kind} — <code>{artifact.source.path}</code></li>)}</ul></details>
          </div>}
        </> : <>
          <section aria-labelledby="descriptor-definition">
            <h5 id="descriptor-definition">What is the descriptor?</h5>
            <p>
              It is a JSON file that acts as the <strong>technical index of your external project</strong>.
              It describes real repository components—called artifacts—using stable identifiers and relative paths.
              It is normally saved as <code>.variamos/spl.json</code>.
            </p>

            <h5>What does it do?</h5>
            <ul>
              <li>identifies the project and the artifacts that VariaMos can import;</li>
              <li>states where each artifact is located, its version, and its technical dependencies;</li>
              <li>declares how the project can be built, tested, and deployed through a compatible profile;</li>
              <li>allows the feature-to-artifact mapping to be created later without inventing those associations.</li>
            </ul>
            <p className="small text-muted">
              The descriptor does not contain the code, replace the feature model, control a page's visual order, or include credentials.
            </p>
          </section>

          <section className="border rounded px-3 py-2 mb-3" aria-labelledby="descriptor-template-changes">
            <h5 id="descriptor-template-changes">What should you change in this template?</h5>
            <ol className="mb-2 mt-1 ps-3">
              <li>replace <code>project.id</code>, <code>project.name</code>, and <code>project.description</code> with your project data;</li>
              <li>add, remove, or edit <code>artifacts</code> entries so they represent only files or modules that actually exist in your project;</li>
              <li>review each artifact's <code>id</code>, <code>kind</code>, <code>version</code>, and <code>source.path</code>;</li>
              <li>declare only real technical dependencies between artifacts in <code>dependsOn</code>;</li>
              <li>adapt the <code>profiles</code> entry and its <code>artifactIds</code> list to the builder, tests, and target you will use;</li>
              <li>keep <code>schemaVersion</code> as <code>variamos-project/v1</code> and <code>status</code> as <code>ready</code> so the descriptor can be imported.</li>
            </ol>
            <p className="mb-0">
              Do not copy paths that do not exist, use absolute paths, or add tokens, passwords, keys, or commands. Then validate the file and save it as <code>.variamos/spl.json</code>.
            </p>
          </section>
          <div className="d-flex flex-wrap gap-2 mb-3">
            <Button size="sm" variant="primary" onClick={downloadTemplate}>Download spl.json template</Button>
            <Button size="sm" variant="outline-primary" disabled={working} onClick={loadBundledTemplate}>Restore template</Button>
            <label className="btn btn-sm btn-outline-secondary mb-0">
              Load my spl.json
              <input type="file" accept=".json,application/json" className="d-none" onChange={loadDescriptorFile} />
            </label>
          </div>

          <label className="d-block mb-1"><strong>Descriptor to validate</strong> <span className="text-muted small">({descriptorFileName})</span></label>
          <textarea
            className="form-control font-monospace"
            rows={16}
            value={descriptorText}
            onChange={(event) => { setDescriptorText(event.target.value); setDescriptorFileName("edited text"); setDescriptorCheck(null); }}
            aria-label="spl.json descriptor content"
            spellCheck={false}
          />
          <div className="d-flex flex-wrap gap-2 mt-2">
            <Button size="sm" variant="primary" disabled={working || !descriptorText.trim()} onClick={validateDescriptor}>{working ? <Spinner animation="border" size="sm" /> : "Validate spl.json"}</Button>
            <Button size="sm" variant="outline-secondary" disabled={!descriptorText} onClick={copyDescriptor}>Copy</Button>
          </div>

          {descriptorCheck && <div className={`alert mt-3 mb-0 py-2 ${descriptorCheck.valid ? "alert-success" : "alert-danger"}`} role="status">
            {descriptorCheck.valid
              ? <><strong>Valid descriptor.</strong> It complies with <code>variamos-project/v1</code> and is ready to connect.</>
              : <><strong>The descriptor is not importable yet.</strong><ul className="mb-0 mt-1">{descriptorCheck.errors.map((item, index) => <li key={`${index}-${item}`}><code>{item}</code></li>)}</ul></>}
          </div>}

          <details className="mt-3" open>
            <summary><strong>Supported options by field</strong></summary>
            <div className="table-responsive mt-2">
              <table className="table table-sm table-bordered align-middle mb-2">
                <thead><tr><th>Field</th><th>Requirement</th><th>Current values or rules</th></tr></thead>
                <tbody>
                  <tr><td><code>schemaVersion</code></td><td>Required</td><td>Only <code>variamos-project/v1</code>.</td></tr>
                  <tr><td><code>status</code></td><td>Required</td><td><code>ready</code> for validation and connection. <code>draft</code> remains in the contract for incomplete documents but cannot be imported.</td></tr>
                  <tr><td><code>project.id</code>, <code>artifacts[].id</code>, <code>profiles[].id</code></td><td>Required</td><td>Stable lowercase IDs using letters, numbers, and <code>.</code>, <code>_</code>, or <code>-</code> separators; 3 to 120 characters.</td></tr>
                  <tr><td><code>project.name</code>, <code>profiles[].name</code></td><td>Required</td><td>Text from 1 to 160 characters. <code>project.description</code> is optional, up to 1000.</td></tr>
                  <tr><td><code>artifacts[].label</code>, <code>artifacts[].description</code></td><td>Optional</td><td>A readable name from 1 to 160 characters and a description up to 1000. They do not replace the stable ID.</td></tr>
                  <tr><td><code>artifacts[].kind</code></td><td>Required</td><td><code>html-fragment</code>, <code>source-bundle</code>, <code>module</code>, <code>configuration</code>, <code>template</code>, <code>test-suite</code>, or <code>container-image</code>. Runtime compatibility is detailed below.</td></tr>
                  <tr><td><code>artifacts[].version</code></td><td>Required</td><td>A semantic version such as <code>1.0.0</code> or <code>2.1.0-beta.1</code>.</td></tr>
                  <tr><td><code>artifacts[].source.path</code></td><td>Required</td><td>A path relative to the connected repository or folder. Absolute paths, <code>..</code>, and backslashes are rejected.</td></tr>
                  <tr><td><code>integrity</code></td><td>Optional</td><td><code>algorithm</code>: only <code>sha256</code>; <code>digest</code>: the <code>sha256:</code> prefix followed by 64 hexadecimal digits. When omitted, the orchestrator calculates it from the pinned commit or snapshot.</td></tr>
                  <tr><td><code>build.entrypoint</code></td><td>Optional</td><td>A safe relative path to the entry file for builders that need one.</td></tr>
                  <tr><td><code>artifacts[].dependsOn</code></td><td>Optional</td><td>Unique technical dependencies. They must exist, cannot reference the same artifact, and do not represent a page's visual order.</td></tr>
                  <tr><td><code>profiles[].artifactIds</code></td><td>Optional</td><td>The artifact subset supported by the profile; all artifacts are used when omitted. Dependencies must be included, and order does not control visual composition.</td></tr>
                  <tr><td><code>profiles[].builderAdapter</code></td><td>Required</td><td><code>static-site-v1</code> or <code>node-modular-monolith-v1</code>.</td></tr>
                  <tr><td><code>profiles[].testAdapter</code></td><td>Required for validation</td><td><code>html-validation-v1</code> for a static site; <code>node-test-v1</code> for a Node monolith.</td></tr>
                  <tr><td><code>profiles[].requiredTargetCapabilities</code></td><td>Required</td><td>Validated static profile: <code>docker</code>, <code>static-http</code>, <code>single-container</code>. Validated Node profile: <code>docker</code>, <code>node-runtime</code>, <code>http-api</code>, <code>single-container</code>, <code>persistent-data</code>.</td></tr>
                  <tr><td><code>requiresCapabilities</code></td><td>Optional</td><td>Capabilities required by the artifact; when omitted, the profile capabilities are inherited.</td></tr>
                  <tr><td><code>artifactProposals</code>, <code>pending</code></td><td>Draft only</td><td>They must be omitted or empty when <code>status</code> is <code>ready</code>.</td></tr>
                </tbody>
              </table>
            </div>
            <div className="small text-muted">
              Current runtime support: <code>static-site-v1</code> processes <code>html-fragment</code>; <code>node-modular-monolith-v1</code> processes <code>source-bundle</code>, <code>module</code>, <code>configuration</code>, and <code>test-suite</code>. <code>template</code> and <code>container-image</code> are reserved by the schema but do not yet have a validated builder in this fork.
            </div>
          </details>
        </>}
        {error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" disabled={working} onClick={close}>Close</Button>
        {mode === "connect" &&
          <Button variant="primary" disabled={working || !projectId || !validated || !profileId} onClick={importProject}>Import and create Feature–Artifact Mapping</Button>}
      </Modal.Footer>
    </Modal>
  </>;
}
