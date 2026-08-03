import React, { useEffect, useState } from "react";
import * as alertify from "alertifyjs";
import Button from "react-bootstrap/Button";
import Offcanvas from "react-bootstrap/Offcanvas";
import Spinner from "react-bootstrap/Spinner";
import ProjectService from "../../Application/Project/ProjectService";
import { isSplMappingLanguage } from "../../Application/SPL/SplMappingFactory";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import {
  SplDerivationAction,
  SplDerivationResponse,
  getSplOrchestratorErrorMessage,
  requestSplMappingDerivation,
} from "../../DataProvider/Services/splOrchestratorService";
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
  const [configurationName, setConfigurationName] = useState("");
  const [workingAction, setWorkingAction] = useState<SplDerivationAction | null>(null);
  const [result, setResult] = useState<SplDerivationResponse | null>(null);
  const [lastDeploymentUrl, setLastDeploymentUrl] = useState("");
  // The panel opens on demand, keeping the editor palette available while the
  // deployment entry point remains next to the project tree.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMappingId(candidateKey.split("|")[0] || "");
    setResult(null);
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
    model.elements.some((element) => element.properties?.some((property) => property.name === "Selected"));
  if ((!mappingModel || !featureModel) && !selectedModelIsFeatureModel) return null;

  const project = projectService.getProject();
  const productLine = projectService.getProductLineSelected();
  const canBuildOrDeploy = Boolean(result?.planDigest);
  const deployedUrl = result?.deployment?.url || lastDeploymentUrl;

  const requestAction = async (action: SplDerivationAction, digest?: string): Promise<SplDerivationResponse> => {
    if (!project?.id || !productLine?.id || !mappingModel || !featureModel) throw new Error("Select a feature model and an SPL mapping before continuing.");
    return requestSplMappingDerivation({
      action, projectId: project.id, productLineId: productLine.id, featureModel, mappingModel,
      configurationRef: configurationName.trim() ? { name: configurationName.trim() } : undefined,
      expectedPlanDigest: digest,
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
      rememberDeployment(response);
      alertify.success(action === "plan" ? "SPL plan generated; no code was executed." : action === "build" ? "Product derived and validated successfully." : "Product deployed successfully.");
    } catch (error) {
      setResult(null);
      alertify.error(getSplOrchestratorErrorMessage(error));
    } finally { setWorkingAction(null); }
  };

  const busy = Boolean(workingAction);
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
          <p style={{ fontSize: 12 }}><strong>Decisions:</strong> {featureModel.name || featureModel.id}<br /><strong>Bindings:</strong> {mappingModel.name || mappingModel.id}</p>
          <SplProjectOnboarding projectService={projectService} featureModel={featureModel} onImported={() => setRevision((value) => value + 1)} />
          <div className="mt-2" />
          <SplMappingAssistant projectService={projectService} featureModel={featureModel} mappingModel={mappingModel} />
          {candidates.length > 1 && <label className="d-block mb-2">Deployment profile
            <select aria-label="Deployment profile" value={mappingId} disabled={busy} onChange={(event) => setMappingId(event.target.value)} style={{ display: "block", width: "100%", marginTop: 3 }}>
              {candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name || candidate.id}</option>)}
            </select>
          </label>}
          <label className="d-block mb-3">Saved configuration (optional)
            <input value={configurationName} disabled={busy} onChange={(event) => setConfigurationName(event.target.value)} placeholder="e.g. in-person-conference" style={{ display: "block", width: "100%", marginTop: 3 }} />
          </label>
          <div className="d-flex flex-wrap gap-2">
            <Button size="sm" variant="outline-primary" disabled={busy} onClick={() => run("plan")}>{workingAction === "plan" ? <Spinner as="span" animation="border" size="sm" /> : "1. Plan"}</Button>
            <Button size="sm" variant="primary" disabled={busy || !canBuildOrDeploy} onClick={() => run("build")}>{workingAction === "build" ? <Spinner as="span" animation="border" size="sm" /> : "2. Derive and test"}</Button>
            <Button size="sm" variant="success" disabled={busy || !canBuildOrDeploy} onClick={() => run("deploy")}>{workingAction === "deploy" ? <Spinner as="span" animation="border" size="sm" /> : "3. Deploy"}</Button>
          </div>
          <p className="text-muted mt-2 mb-0" style={{ fontSize: 11 }}>Planning does not execute code. Derivation assembles and tests a release; deployment publishes that tested release using the same approved plan.</p>
          {(result || deployedUrl) && <div className="mt-3 pt-3 border-top">
            {result && <>
              <div><strong>Manifest:</strong> {result.manifest.manifestId}</div>
              <div><strong>Profile:</strong> {profileLabel(result)}</div>
              <div><strong>Artifacts:</strong> {result.manifest.artifacts.length}</div>
              {result.tests && <div><strong>Tests:</strong> {result.tests.status}</div>}
              <div><strong>Selected:</strong> {featureModel.elements.filter((element) => element.properties?.some((property) => property.name === "Selected" && property.value === "Selected")).map((element) => element.name).join(", ") || "none"}</div>
              {result.planDigest && <div title={result.planDigest} style={{ overflowWrap: "anywhere" }}><strong>Plan:</strong> {result.planDigest.slice(0, 22)}…</div>}
              {result.trace && result.trace.length > 0 && <details className="mt-2"><summary>Feature → artifacts</summary><ul className="mb-0 ps-3">{result.trace.map((item) => <li key={`${item.bindingElementId}-${item.artifactId}`}>{item.featureId} → {item.artifactId}</li>)}</ul></details>}
            </>}
            {deployedUrl && <a href={deployedUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 12, padding: "8px 12px", backgroundColor: "#198754", border: "1px solid #146c43", borderRadius: 4, color: "#ffffff", fontWeight: 600, textDecoration: "none", boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)" }}>↗ Open deployed product</a>}
          </div>}
          <div className="text-muted mt-3" style={{ fontSize: 11 }}>If a feature, binding, or profile changes, the plan becomes invalid (revision {revision}) and must be generated again.</div>
        </>}
      </Offcanvas.Body>
    </Offcanvas>
  </>;
}
