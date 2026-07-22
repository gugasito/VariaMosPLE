import React, { useEffect, useState } from "react";
import * as alertify from "alertifyjs";
import Button from "react-bootstrap/Button";
import Offcanvas from "react-bootstrap/Offcanvas";
import Spinner from "react-bootstrap/Spinner";
import ProjectService from "../../Application/Project/ProjectService";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import {
  DsplDerivationAction,
  DsplDerivationResponse,
  getDsplOrchestratorErrorMessage,
  requestDsplMappingDerivation,
} from "../../DataProvider/Services/dsplOrchestratorService";
import DsplMappingAssistant from "./DsplMappingAssistant";
import DsplProjectOnboarding from "./DsplProjectOnboarding";

const MAPPING_LANGUAGE = "DSPL Deployment Mapping v1";

interface DsplDerivationPanelProps { projectService: ProjectService; model: Model; }

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
  if (model.type === MAPPING_LANGUAGE) return [model];
  return models.filter((candidate) => candidate.type === MAPPING_LANGUAGE && (candidate.sourceModelIds || []).includes(model.id));
}

function sourceFeatureModel(mappingModel: Model, models: Model[]): Model | undefined {
  return models.find((candidate) => candidate.id === (mappingModel.sourceModelIds || [])[0]);
}

function profileLabel(result: DsplDerivationResponse): string {
  return result.profile ? `${result.profile.builderAdapter} → ${result.profile.deployerAdapter}` : "perfil DSPL";
}

function deploymentKey(mappingId: string): string { return `variamos.dspl.last-deployment.${mappingId}`; }

/** Sidebar de ejecución DSPL. El mapping es la frontera entre el modelo de
 * dominio y el ensamblaje técnico; la UI no manipula Docker ni código. */
export default function DsplDerivationPanel({ projectService, model }: DsplDerivationPanelProps) {
  const [revision, setRevision] = useState(0);
  // revision fuerza una nueva lectura del árbol cuando el onboarding agrega un
  // mapping a la línea de productos sin recargar la página.
  void revision;
  const models = collectModels(projectService, model.id);
  const candidates = mappingModelsFor(model, models);
  const candidateKey = candidates.map((candidate) => candidate.id).join("|");
  const [mappingId, setMappingId] = useState("");
  const [configurationName, setConfigurationName] = useState("");
  const [workingAction, setWorkingAction] = useState<DsplDerivationAction | null>(null);
  const [result, setResult] = useState<DsplDerivationResponse | null>(null);
  const [lastDeploymentUrl, setLastDeploymentUrl] = useState("");
  // El panel se abre a demanda. Así la paleta de elementos del editor queda
  // disponible al modelar y el acceso se mantiene junto al árbol del proyecto.
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
  const selectedModelIsFeatureModel = model.elements.some((element) => element.properties?.some((property) => property.name === "Selected"));
  if ((!mappingModel || !featureModel) && !selectedModelIsFeatureModel) return null;

  const project = projectService.getProject();
  const productLine = projectService.getProductLineSelected();
  const canBuildOrDeploy = Boolean(result?.planDigest);
  const deployedUrl = result?.deployment?.url || lastDeploymentUrl;

  const requestAction = async (action: DsplDerivationAction, digest?: string): Promise<DsplDerivationResponse> => {
    if (!project?.id || !productLine?.id || !mappingModel || !featureModel) throw new Error("Selecciona un feature model y un mapping DSPL antes de continuar.");
    return requestDsplMappingDerivation({
      action, projectId: project.id, productLineId: productLine.id, featureModel, mappingModel,
      configurationRef: configurationName.trim() ? { name: configurationName.trim() } : undefined,
      expectedPlanDigest: digest,
    });
  };

  const rememberDeployment = (response: DsplDerivationResponse): void => {
    if (!response.deployment?.url || !mappingModel) return;
    window.sessionStorage.setItem(deploymentKey(mappingModel.id), response.deployment.url);
    setLastDeploymentUrl(response.deployment.url);
  };

  const run = async (action: DsplDerivationAction): Promise<void> => {
    if ((action === "build" || action === "deploy") && !result?.planDigest) {
      alertify.error("Primero planifica y revisa el producto que se va a ejecutar.");
      return;
    }
    setWorkingAction(action);
    try {
      const response = await requestAction(action, action === "plan" ? undefined : result?.planDigest);
      setResult(response);
      rememberDeployment(response);
      alertify.success(action === "plan" ? "Plan DSPL generado; no se ejecutó código." : action === "build" ? "Producto derivado y validado correctamente." : "Producto desplegado correctamente.");
    } catch (error) {
      setResult(null);
      alertify.error(getDsplOrchestratorErrorMessage(error));
    } finally { setWorkingAction(null); }
  };

  const busy = Boolean(workingAction);
  return <>
    {!open && <Button aria-label="Abrir despliegue DSPL" size="sm" variant="primary" onClick={() => setOpen(true)} style={{ display: "block", width: "calc(100% - 12px)", margin: "8px 6px", whiteSpace: "normal" }}>Despliegue DSPL</Button>}
    <Offcanvas show={open} onHide={() => setOpen(false)} placement="end" aria-label="Derivación y despliegue DSPL" style={{ width: "min(430px, 100vw)" }}>
      <Offcanvas.Header closeButton><Offcanvas.Title>Despliegue DSPL</Offcanvas.Title></Offcanvas.Header>
      <Offcanvas.Body style={{ fontSize: 13 }}>
        {!mappingModel || !featureModel ? <>
          <p>Este modelo todavía no tiene una realización técnica. Configura el perfil y confirma los bindings en el asistente.</p>
          <p className="text-muted" style={{ fontSize: 12 }}>Puedes conectar un repositorio propio con <code>.variamos/dspl.json</code> o utilizar un perfil ya autorizado.</p>
          <DsplProjectOnboarding projectService={projectService} featureModel={model} onImported={() => setRevision((value) => value + 1)} />
          <hr />
          <DsplMappingAssistant projectService={projectService} featureModel={model} />
        </> : <>
          <p style={{ fontSize: 12 }}><strong>Decisiones:</strong> {featureModel.name || featureModel.id}<br /><strong>Vínculos:</strong> {mappingModel.name || mappingModel.id}</p>
          <DsplProjectOnboarding projectService={projectService} featureModel={featureModel} onImported={() => setRevision((value) => value + 1)} />
          <div className="mt-2" />
          <DsplMappingAssistant projectService={projectService} featureModel={featureModel} mappingModel={mappingModel} />
          {candidates.length > 1 && <label className="d-block mb-2">Perfil de despliegue
            <select aria-label="Perfil de despliegue" value={mappingId} disabled={busy} onChange={(event) => setMappingId(event.target.value)} style={{ display: "block", width: "100%", marginTop: 3 }}>
              {candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name || candidate.id}</option>)}
            </select>
          </label>}
          <label className="d-block mb-3">Configuración guardada (opcional)
            <input value={configurationName} disabled={busy} onChange={(event) => setConfigurationName(event.target.value)} placeholder="p. ej. conferencia-presencial" style={{ display: "block", width: "100%", marginTop: 3 }} />
          </label>
          <div className="d-flex flex-wrap gap-2">
            <Button size="sm" variant="outline-primary" disabled={busy} onClick={() => run("plan")}>{workingAction === "plan" ? <Spinner as="span" animation="border" size="sm" /> : "1. Planificar"}</Button>
            <Button size="sm" variant="primary" disabled={busy || !canBuildOrDeploy} onClick={() => run("build")}>{workingAction === "build" ? <Spinner as="span" animation="border" size="sm" /> : "2. Derivar y probar"}</Button>
            <Button size="sm" variant="success" disabled={busy || !canBuildOrDeploy} onClick={() => run("deploy")}>{workingAction === "deploy" ? <Spinner as="span" animation="border" size="sm" /> : "3. Desplegar"}</Button>
          </div>
          <p className="text-muted mt-2 mb-0" style={{ fontSize: 11 }}>Planificar no ejecuta código. Derivar ensambla y prueba una release; desplegar publica esa release ya probada con el mismo plan aprobado.</p>
          {(result || deployedUrl) && <div className="mt-3 pt-3 border-top">
            {result && <>
              <div><strong>Manifest:</strong> {result.manifest.manifestId}</div>
              <div><strong>Perfil:</strong> {profileLabel(result)}</div>
              <div><strong>Artefactos:</strong> {result.manifest.artifacts.length}</div>
              {result.tests && <div><strong>Pruebas:</strong> {result.tests.status}</div>}
              <div><strong>Seleccionadas:</strong> {featureModel.elements.filter((element) => element.properties?.some((property) => property.name === "Selected" && property.value === "Selected")).map((element) => element.name).join(", ") || "ninguna"}</div>
              {result.planDigest && <div title={result.planDigest} style={{ overflowWrap: "anywhere" }}><strong>Plan:</strong> {result.planDigest.slice(0, 22)}…</div>}
              {result.trace && result.trace.length > 0 && <details className="mt-2"><summary>Feature → artefactos</summary><ul className="mb-0 ps-3">{result.trace.map((item) => <li key={`${item.bindingElementId}-${item.artifactId}`}>{item.featureId} → {item.artifactId}</li>)}</ul></details>}
            </>}
            {deployedUrl && <a href={deployedUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", marginTop: 12, padding: "8px 12px", backgroundColor: "#198754", border: "1px solid #146c43", borderRadius: 4, color: "#ffffff", fontWeight: 600, textDecoration: "none", boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)" }}>↗ Abrir producto desplegado</a>}
          </div>}
          <div className="text-muted mt-3" style={{ fontSize: 11 }}>Si cambia una feature, binding o perfil, el plan se invalida (revisión {revision}) y debes volver a planificar.</div>
        </>}
      </Offcanvas.Body>
    </Offcanvas>
  </>;
}
