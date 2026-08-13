import React, { useEffect, useRef, useState } from "react";
import * as alertify from "alertifyjs";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import Offcanvas from "react-bootstrap/Offcanvas";
import Spinner from "react-bootstrap/Spinner";
import ProjectService from "../../Application/Project/ProjectService";
import { isSplMappingLanguage } from "../../Application/SPL/SplMappingFactory";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import {
  SplDerivationAction,
  SplDerivationResponse,
  SplDeploymentExecution,
  SplRemoteTarget,
  cancelSplDeployment,
  createSplDeployment,
  getSplDeployment,
  getSplTargets,
  getSplOrchestratorErrorMessage,
  requestSplMappingDerivation,
} from "../../DataProvider/Services/splOrchestratorService";
import { forgetEphemeralSshPem, getEphemeralSshPem, rememberEphemeralSshPem } from "../../DataProvider/Services/ephemeralSshPemVault";
import { RoleEnum } from "../../Domain/ProductLineEngineering/Enums/roleEnum";
import SplMappingAssistant from "./SplMappingAssistant";
import SplProjectOnboarding from "./SplProjectOnboarding";

interface SplDerivationPanelProps { projectService: ProjectService; model: Model; }

function collectModels(projectService: ProjectService, selectedModelId: string): Model[] {
  if (!selectedModelId) return [];
  const productLine = projectService.getProductLineSelected();
  if (!productLine) return [];
  const models = [
    ...(productLine.scope?.models || []),
    ...(productLine.domainEngineering?.models || []),
    ...(productLine.applicationEngineering?.models || []),
    ...(productLine.applicationEngineering?.applications || []).flatMap((application) => [
      ...(application.models || []),
      ...(application.adaptations || []).flatMap((adaptation) => adaptation.models || []),
    ]),
  ];
  return [...new Map(models.map((candidate) => [candidate.id, candidate])).values()];
}

function mappingModelsFor(model: Model, models: Model[]): Model[] {
  if (isSplMappingLanguage(model.type)) return [model];
  return models.filter((candidate) => isSplMappingLanguage(candidate.type) && (candidate.sourceModelIds || []).includes(model.id));
}

function sourceFeatureModel(mappingModel: Model, models: Model[]): Model | undefined {
  return models.find((candidate) => candidate.id === (mappingModel.sourceModelIds || [])[0]);
}

function profileLabel(result: SplDerivationResponse): string {
  return result.profile ? `${result.profile.builderAdapter} → ${result.profile.deployerAdapter}` : "SPL profile";
}

function deploymentKey(mappingId: string): string { return `variamos.spl.last-deployment.${mappingId}`; }

function mappingTargetRef(mapping: Model | undefined): string {
  const root = mapping?.elements.find((element) => element.type === "DeploymentMapping");
  const value = root?.properties?.find((property) => property.name === "target_ref")?.value;
  return typeof value === "string" ? value : "";
}

const ACTIVE_DEPLOYMENT_STATES = new Set([
  "queued",
  "authorizing",
  "resolving-credential",
  "connecting",
  "uploading",
  "deploying",
  "verifying",
]);

/** SPL execution sidebar. The mapping is the boundary between the domain model
 * and technical assembly; the UI does not manipulate Docker or source code. */
export default function SplDerivationPanel({ projectService, model }: SplDerivationPanelProps) {
  const [revision, setRevision] = useState(0);
  // revision forces the tree to refresh when onboarding adds a mapping without
  // reloading the page.
  void revision;
  const models = collectModels(projectService, model.id);
  const candidates = mappingModelsFor(model, models);
  const candidateKey = candidates.map((candidate) => candidate.id).join("|");
  const [mappingId, setMappingId] = useState("");
  const [workingAction, setWorkingAction] = useState<SplDerivationAction | null>(null);
  const [result, setResult] = useState<SplDerivationResponse | null>(null);
  const [lastDeploymentUrl, setLastDeploymentUrl] = useState("");
  const [targets, setTargets] = useState<SplRemoteTarget[]>([]);
  const [targetRef, setTargetRef] = useState("");
  const [deployment, setDeployment] = useState<SplDeploymentExecution | null>(null);
  const [deploymentWorking, setDeploymentWorking] = useState(false);
  const [credentialPromptOpen, setCredentialPromptOpen] = useState(false);
  const [deploymentPassword, setDeploymentPassword] = useState("");
  const [deploymentPem, setDeploymentPem] = useState("");
  const [deploymentPassphrase, setDeploymentPassphrase] = useState("");
  const pollCount = useRef(0);
  // The panel opens on demand, keeping the editor palette available while the
  // deployment entry point remains next to the project tree.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMappingId(candidateKey.split("|")[0] || "");
    setResult(null);
    setDeployment(null);
  }, [model.id, candidateKey]);

  useEffect(() => {
    if (!mappingId) { setLastDeploymentUrl(""); return; }
    setLastDeploymentUrl(window.sessionStorage.getItem(deploymentKey(mappingId)) || "");
  }, [mappingId]);

  useEffect(() => {
    const candidateIds = candidateKey ? candidateKey.split("|") : [];
    const onUpdate = (event: any) => {
      if (event?.model?.id === model.id || candidateIds.includes(event?.model?.id)) {
        setResult(null);
        setRevision((value) => value + 1);
      }
    };
    projectService.addUpdatedElementListener(onUpdate);
    return () => projectService.removeUpdatedElementListener(onUpdate);
  }, [projectService, model.id, candidateKey]);

  const mappingModel = candidates.find((candidate) => candidate.id === mappingId);
  const featureModel = mappingModel ? sourceFeatureModel(mappingModel, models) : undefined;
  const selectedModelIsFeatureModel =
    model.type === "Feature model with attributes" ||
    model.type === "Feature model without attributes" ||
    model.type === "Feature model UVL" ||
    model.elements.some((element) => element.properties?.some((property) => property.name === "Selected"));
  const project = projectService.getProject();
  const productLine = projectService.getProductLineSelected();
  const projectInformation = projectService.getProjectInformation();
  const projectRole = projectInformation?.currentUserRole || projectInformation?.role;
  const canEdit = !projectRole || projectRole === RoleEnum.OWNER || projectRole === RoleEnum.EDITOR;
  const defaultTargetRef = mappingTargetRef(mappingModel);
  const selectedRemoteTarget = targets.find((item) => item.id === targetRef && item.status === "active");
  const canDeploy = selectedRemoteTarget
    ? projectRole === RoleEnum.OWNER
    : !projectRole || projectRole === RoleEnum.OWNER;
  const canBuildOrDeploy = Boolean(result?.planDigest);
  const deployedUrl = deployment?.publicUrl || result?.deployment?.url || lastDeploymentUrl;

  const refreshTargets = () => {
    if (!project?.id) return;
    void getSplTargets(project.id)
      .then((nextTargets) => {
        setTargets(nextTargets);
        const activeRemote = nextTargets.find((item) => item.status === "active");
        setTargetRef((current) =>
          current && nextTargets.some((item) => item.id === current && item.status === "active")
            ? current
            : activeRemote?.id || current
        );
      })
      .catch(() => setTargets([]));
  };

  useEffect(() => {
    setTargetRef(defaultTargetRef);
    setResult(null);
    setDeployment(null);
  }, [mappingId, defaultTargetRef]);

  useEffect(() => {
    if (!open || !project?.id) return;
    refreshTargets();
  }, [open, project?.id]);

  useEffect(() => {
    if (!deployment || !ACTIVE_DEPLOYMENT_STATES.has(deployment.status)) return;
    let cancelled = false;
    const delay = pollCount.current < 5 ? 2000 : Math.min(5000, 2000 + pollCount.current * 250);
    const timer = window.setTimeout(async () => {
      try {
        const latest = await getSplDeployment(deployment.executionId);
        if (cancelled) return;
        pollCount.current += 1;
        setDeployment(latest);
        if (latest.publicUrl && mappingModel) {
          window.sessionStorage.setItem(deploymentKey(mappingModel.id), latest.publicUrl);
          setLastDeploymentUrl(latest.publicUrl);
        }
      } catch (error) {
        if (!cancelled) alertify.error(getSplOrchestratorErrorMessage(error));
      }
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deployment, mappingModel]);

  if ((!mappingModel || !featureModel) && !selectedModelIsFeatureModel) return null;

  const requestAction = async (action: SplDerivationAction, digest?: string): Promise<SplDerivationResponse> => {
    if (!project?.id || !productLine?.id || !mappingModel || !featureModel) throw new Error("Select a feature model and a Feature–Artifact Mapping before continuing.");
    return requestSplMappingDerivation({
      action, projectId: project.id, productLineId: productLine.id, featureModel, mappingModel,
      expectedPlanDigest: digest,
      targetRef: targetRef || undefined,
      targetRevision: selectedRemoteTarget?.revision,
    });
  };

  const rememberDeployment = (response: SplDerivationResponse): void => {
    if (!response.deployment?.url || !mappingModel) return;
    window.sessionStorage.setItem(deploymentKey(mappingModel.id), response.deployment.url);
    setLastDeploymentUrl(response.deployment.url);
  };

  const run = async (action: SplDerivationAction): Promise<void> => {
    if ((action === "build" || action === "deploy") && !result?.planDigest) {
      alertify.error("Generate and review the product plan before executing it.");
      return;
    }
    setWorkingAction(action);
    try {
      const response = await requestAction(action, action === "plan" ? undefined : result?.planDigest);
      setResult(response);
      setDeployment(null);
      rememberDeployment(response);
      alertify.success(action === "plan" ? "SPL plan generated; no code was executed." : action === "build" ? "Product derived and validated successfully." : "Product deployed successfully.");
    } catch (error) {
      setResult(null);
      alertify.error(getSplOrchestratorErrorMessage(error));
    } finally { setWorkingAction(null); }
  };

  const queueRemoteDeployment = async (credential?: { privateKey: string; passphrase?: string } | string): Promise<void> => {
    if (!selectedRemoteTarget || !result?.buildId || !result.planDigest) {
      alertify.error("Derive and test this exact remote-target plan before deploying it.");
      return;
    }
    setDeploymentWorking(true);
    try {
      pollCount.current = 0;
      const attemptId = Array.from(window.crypto.getRandomValues(new Uint32Array(4)))
        .map((value) => value.toString(16).padStart(8, "0"))
        .join("");
      const execution = await createSplDeployment({
        projectId: project.id,
        buildId: result.buildId,
        targetRef: selectedRemoteTarget.id,
        targetRevision: selectedRemoteTarget.revision,
        expectedPlanDigest: result.planDigest,
        // A key identifies one click/attempt. Reusing a deterministic key here
        // prevented an owner from retrying the same immutable build after a
        // failed remote attempt.
        idempotencyKey: `deploy:${result.buildId}:${selectedRemoteTarget.id}:${selectedRemoteTarget.revision}:${attemptId}`,
        ephemeralCredential: selectedRemoteTarget.authentication.mode === "prompt-pem"
          ? { schemaVersion: "ssh-pem/v1" as const, username: selectedRemoteTarget.authentication.username, privateKey: typeof credential === "object" ? credential.privateKey : "", ...(typeof credential === "object" && credential.passphrase ? { passphrase: credential.passphrase } : {}) }
          : { schemaVersion: "ssh-password/v1" as const, username: selectedRemoteTarget.authentication.username, password: typeof credential === "string" ? credential : "" },
      });
      setDeployment(execution);
      setDeploymentPassword("");
      setDeploymentPem("");
      setDeploymentPassphrase("");
      setCredentialPromptOpen(false);
      alertify.success("Remote deployment queued. This panel will track every stage.");
    } catch (error) {
      alertify.error(getSplOrchestratorErrorMessage(error));
    } finally {
      setDeploymentWorking(false);
    }
  };

  const deployRemote = (): void => {
    if (!selectedRemoteTarget || !result?.buildId || !result.planDigest) {
      alertify.error("Derive and test this exact remote-target plan before deploying it.");
      return;
    }
    if (
      selectedRemoteTarget.environment === "production" &&
      !window.confirm(
        `Deploy project "${project.name || project.id}" to production target "${selectedRemoteTarget.name}"?\n\nManifest: ${result.manifest.manifestId}\nEnvironment: ${selectedRemoteTarget.environment}`
      )
    ) return;
    setDeploymentPassword(""); setDeploymentPem(""); setDeploymentPassphrase("");
    if (selectedRemoteTarget.authentication.mode === "prompt-pem") {
      const cached = getEphemeralSshPem(selectedRemoteTarget.id, selectedRemoteTarget.revision, selectedRemoteTarget.authentication.username);
      if (cached) { void queueRemoteDeployment(cached); return; }
    }
    setCredentialPromptOpen(true);
  };

  const submitDeploymentPassword = (): void => {
    void queueRemoteDeployment(deploymentPassword);
  };

  const selectDeploymentPem = async (file?: File): Promise<void> => {
    setDeploymentPem("");
    if (!file) return;
    if (file.size > 64 * 1024) { alertify.error("The PEM private key must be 64 KiB or smaller."); return; }
    try { setDeploymentPem(await file.text()); } catch (_error) { alertify.error("The selected PEM private key could not be read."); }
  };

  const submitDeploymentPem = (): void => {
    if (!selectedRemoteTarget || !deploymentPem) return;
    const credential = { privateKey: deploymentPem, ...(deploymentPassphrase ? { passphrase: deploymentPassphrase } : {}) };
    rememberEphemeralSshPem(selectedRemoteTarget.id, selectedRemoteTarget.revision, selectedRemoteTarget.authentication.username, credential.privateKey, credential.passphrase);
    void queueRemoteDeployment(credential);
  };

  const cancelRemote = async (): Promise<void> => {
    if (!deployment || !window.confirm("Cancel this deployment? The deployer will clean the candidate and restore the previous release when necessary.")) return;
    setDeploymentWorking(true);
    try {
      setDeployment(await cancelSplDeployment(deployment.executionId));
    } catch (error) {
      alertify.error(getSplOrchestratorErrorMessage(error));
    } finally {
      setDeploymentWorking(false);
    }
  };

  const busy = Boolean(workingAction) || deploymentWorking ||
    Boolean(deployment && ACTIVE_DEPLOYMENT_STATES.has(deployment.status));
  return <>
    {!open && <Button aria-label="Open SPL deployment" size="sm" variant="primary" onClick={() => setOpen(true)} style={{ display: "block", width: "calc(100% - 12px)", margin: "8px 6px", whiteSpace: "normal" }}>SPL Deployment</Button>}
    <Offcanvas show={open} onHide={() => setOpen(false)} placement="end" aria-label="SPL derivation and deployment" style={{ width: "min(430px, 100vw)" }}>
      <Offcanvas.Header closeButton><Offcanvas.Title>SPL Deployment</Offcanvas.Title></Offcanvas.Header>
      <Offcanvas.Body style={{ fontSize: 13 }}>
        {!mappingModel || !featureModel ? <>
          <p>This model does not have a technical implementation yet. Configure a profile and confirm its bindings in the assistant.</p>
          <p className="text-muted" style={{ fontSize: 12 }}>You can connect your own repository with <code>.variamos/spl.json</code> or use an authorized profile.</p>
          <SplProjectOnboarding projectService={projectService} featureModel={model} onImported={() => setRevision((value) => value + 1)} />
          <hr />
          <SplMappingAssistant projectService={projectService} featureModel={model} />
        </> : <>
          <p style={{ fontSize: 12 }}><strong>Feature decisions:</strong> {featureModel.name || featureModel.id}<br /><strong>Feature–Artifact Mapping:</strong> {mappingModel.name || mappingModel.id}</p>
          <SplProjectOnboarding
            projectService={projectService}
            featureModel={featureModel}
            onImported={() => setRevision((value) => value + 1)}
            onTargetsChanged={refreshTargets}
          />
          <div className="mt-2" />
          <SplMappingAssistant projectService={projectService} featureModel={featureModel} mappingModel={mappingModel} />
          {candidates.length > 1 && <label className="d-block mb-2">Deployment profile
            <select aria-label="Deployment profile" value={mappingId} disabled={busy} onChange={(event) => setMappingId(event.target.value)} style={{ display: "block", width: "100%", marginTop: 3 }}>
              {candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name || candidate.id}</option>)}
            </select>
          </label>}
          <label className="d-block mb-2">Deployment target
            <select
              aria-label="Deployment target"
              className="form-select form-select-sm"
              value={targetRef}
              disabled={busy}
              onChange={(event) => {
                if (selectedRemoteTarget?.authentication.mode === "prompt-pem") {
                  forgetEphemeralSshPem(selectedRemoteTarget.id, selectedRemoteTarget.revision, selectedRemoteTarget.authentication.username);
                }
                setTargetRef(event.target.value);
                setResult(null);
                setDeployment(null);
              }}
            >
              {targets.length === 0 && defaultTargetRef &&
                <option value={defaultTargetRef}>{defaultTargetRef} — local/default</option>}
              {targets.filter((item) => item.status === "active").map((item) =>
                <option value={item.id} key={item.id}>
                  {item.name}{item.environment ? ` — ${item.environment}` : ""} (rev. {item.revision})
                </option>
              )}
            </select>
            <small className="text-muted">
              Changing target clears the previous Plan and Build. Remote revisions are locked into the new plan.
            </small>
          </label>
          <div className="d-flex flex-wrap gap-2">
            <Button size="sm" variant="outline-primary" disabled={busy || !canEdit} onClick={() => run("plan")}>{workingAction === "plan" ? <Spinner as="span" animation="border" size="sm" /> : "1. Plan"}</Button>
            <Button size="sm" variant="primary" disabled={busy || !canEdit || !canBuildOrDeploy} onClick={() => run("build")}>{workingAction === "build" ? <Spinner as="span" animation="border" size="sm" /> : "2. Derive and test"}</Button>
            {selectedRemoteTarget
              ? <Button size="sm" variant="success" disabled={busy || !canDeploy || !result?.buildId} onClick={deployRemote}>
                {deploymentWorking ? <Spinner as="span" animation="border" size="sm" /> : `Deploy to ${selectedRemoteTarget.name}`}
              </Button>
              : <Button size="sm" variant="success" disabled={busy || !canDeploy || !canBuildOrDeploy} onClick={() => run("deploy")}>{workingAction === "deploy" ? <Spinner as="span" animation="border" size="sm" /> : "3. Deploy"}</Button>}
          </div>
          {!canDeploy && <p className="text-muted mt-2 mb-0" style={{ fontSize: 11 }}>
            Deployment is disabled for the <strong>{projectRole}</strong> role. An owner must publish the tested build.
          </p>}
          <p className="text-muted mt-2 mb-0" style={{ fontSize: 11 }}>Planning does not execute code. Derivation assembles and tests a release; deployment publishes that tested release using the same approved plan.</p>
          {(result || deployment || deployedUrl) && <div className="mt-3 pt-3 border-top">
            {result && <>
              <div><strong>Manifest:</strong> {result.manifest.manifestId}</div>
              <div><strong>Profile:</strong> {profileLabel(result)}</div>
              <div><strong>Artifacts:</strong> {result.manifest.artifacts.length}</div>
              {result.tests && <div><strong>Tests:</strong> {result.tests.status}</div>}
              {result.buildId && <div title={result.buildId}><strong>Immutable build:</strong> {result.buildId}</div>}
              <div><strong>Target:</strong> {result.targetName || targetRef}{result.targetRevision ? ` (rev. ${result.targetRevision})` : ""}</div>
              <div><strong>Selected:</strong> {featureModel.elements.filter((element) => element.properties?.some((property) => property.name === "Selected" && property.value === "Selected")).map((element) => element.name).join(", ") || "none"}</div>
              {result.planDigest && <div title={result.planDigest} style={{ overflowWrap: "anywhere" }}><strong>Plan:</strong> {result.planDigest.slice(0, 22)}…</div>}
              {result.trace && result.trace.length > 0 && <details className="mt-2"><summary>Feature → artifacts</summary><ul className="mb-0 ps-3">{result.trace.map((item) => <li key={`${item.bindingElementId}-${item.artifactId}`}>{item.featureId} → {item.artifactId}</li>)}</ul></details>}
            </>}
            {deployment && <div className={`alert mt-2 mb-0 py-2 ${
              deployment.status === "succeeded"
                ? "alert-success"
                : deployment.status === "failed" || deployment.status === "interrupted"
                  ? "alert-danger"
                  : deployment.status === "rolled-back"
                    ? "alert-warning"
                    : "alert-info"
            }`} role="status">
              <div><strong>Remote deployment:</strong> {deployment.status}</div>
              {deployment.stageMessage && <div>{deployment.stageMessage}</div>}
              {deployment.safeError && <div className="small mt-1">{deployment.safeError}</div>}
              {deployment.rollback && <div className="small">Rollback: {deployment.rollback.succeeded ? "completed safely" : deployment.rollback.attempted ? "attempt failed" : "not required"}</div>}
              {ACTIVE_DEPLOYMENT_STATES.has(deployment.status) &&
                <Button size="sm" variant="outline-danger" className="mt-2" disabled={deploymentWorking || Boolean(deployment.cancelRequestedAt)} onClick={cancelRemote}>
                  {deployment.cancelRequestedAt ? "Cancellation requested" : "Cancel deployment"}
                </Button>}
            </div>}
            {deployedUrl && <a className="spl-deployment-link" href={deployedUrl} target="_blank" rel="noopener noreferrer" aria-label="Open deployed product">↗ Open deployed product</a>}
          </div>}
          <div className="text-muted mt-3" style={{ fontSize: 11 }}>If a feature, binding, or profile changes, the plan becomes invalid (revision {revision}) and must be generated again.</div>
        </>}
      </Offcanvas.Body>
    </Offcanvas>
    <Modal
      show={credentialPromptOpen}
      onHide={() => {
        if (deploymentWorking) return;
        setDeploymentPassword("");
        setDeploymentPem(""); setDeploymentPassphrase(""); setCredentialPromptOpen(false);
      }}
      centered
    >
      <Modal.Header closeButton><Modal.Title>{selectedRemoteTarget?.authentication.mode === "prompt-pem" ? "PEM private key required" : "SSH password required"}</Modal.Title></Modal.Header>
      <Modal.Body>
        <p>
          Target: <strong>{selectedRemoteTarget?.name}</strong><br />
          SSH user: <strong>{selectedRemoteTarget?.authentication.username}</strong>
        </p>
        {selectedRemoteTarget?.authentication.mode === "prompt-pem" ? <>
          <label className="form-label w-100">PEM private key for this deployment
            <input autoFocus type="file" className="form-control" accept=".pem,application/x-pem-file,text/plain" disabled={deploymentWorking} onChange={(event) => void selectDeploymentPem(event.target.files?.[0])} />
          </label>
          <label className="form-label w-100">PEM passphrase (optional)
            <input type="password" className="form-control" autoComplete="new-password" value={deploymentPassphrase} disabled={deploymentWorking} onChange={(event) => setDeploymentPassphrase(event.target.value)} />
          </label>
        </> : <label className="form-label w-100">Password for this deployment
          <input
            autoFocus
            type="password"
            className="form-control"
            autoComplete="new-password"
            value={deploymentPassword}
            disabled={deploymentWorking}
            onChange={(event) => setDeploymentPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && deploymentPassword) submitDeploymentPassword();
            }}
          />
        </label>}
        <div className="alert alert-info small mb-0">
          VariaMos sends this credential to the SSH library for this job only. It is not saved in the target, build, deployment record, logs or browser storage. PEM keys remain in this tab for at most 15 minutes.
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" disabled={deploymentWorking} onClick={() => {
          setDeploymentPassword("");
          setDeploymentPem(""); setDeploymentPassphrase(""); setCredentialPromptOpen(false);
        }}>Cancel</Button>
        <Button variant="success" disabled={deploymentWorking || (selectedRemoteTarget?.authentication.mode === "prompt-pem" ? !deploymentPem : !deploymentPassword)} onClick={selectedRemoteTarget?.authentication.mode === "prompt-pem" ? submitDeploymentPem : submitDeploymentPassword}>
          Deploy now
        </Button>
      </Modal.Footer>
    </Modal>
  </>;
}
