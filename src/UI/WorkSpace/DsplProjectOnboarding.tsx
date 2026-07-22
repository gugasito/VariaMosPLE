import React, { useState } from "react";
import * as alertify from "alertifyjs";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import Spinner from "react-bootstrap/Spinner";
import ProjectService from "../../Application/Project/ProjectService";
import { createDsplMapping, DsplProfileSummary } from "../../Application/DSPL/DsplMappingFactory";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import {
  createDsplDescriptorDraft,
  DsplGitConnectionInput,
  DsplProjectDescriptor,
  getDsplOrchestratorErrorMessage,
  importDsplProject,
  saveDsplGitConnection,
  validateDsplDescriptor,
  validateDsplGitConnection,
} from "../../DataProvider/Services/dsplOrchestratorService";

interface Props {
  projectService: ProjectService;
  featureModel: Model;
  onImported?: (mapping: Model) => void;
}

type Mode = "connect" | "generate" | null;

function suggestedId(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);
}

/** Incorporación real de proyectos: crea conexiones en el orquestador y sólo
 * guarda en el modelo IDs públicos de catálogo/target. */
export default function DsplProjectOnboarding({ projectService, featureModel, onImported }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<DsplGitConnectionInput>({
    id: suggestedId(featureModel.name || featureModel.id) || "project-connection",
    provider: "git",
    repositoryUrl: "",
    requestedRef: "main",
    descriptorPath: ".variamos/dspl.json",
  });
  const [validated, setValidated] = useState<Awaited<ReturnType<typeof validateDsplGitConnection>> | null>(null);
  const [profileId, setProfileId] = useState("");
  const [draftProjectId, setDraftProjectId] = useState(suggestedId(featureModel.name || featureModel.id));
  const [draftProjectName, setDraftProjectName] = useState(featureModel.name || "Proyecto DSPL");
  const [draft, setDraft] = useState<DsplProjectDescriptor | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftValid, setDraftValid] = useState(false);

  const configurableFeatures = featureModel.elements
    .filter((element) => element.properties?.some((property) => property.name === "Selected"))
    .map((element) => ({ id: element.id, name: element.name }));

  const close = () => { if (!working) { setMode(null); setError(""); } };
  const updateConnection = (name: keyof DsplGitConnectionInput, value: string) => {
    setValidated(null);
    setConnection((previous) => ({ ...previous, [name]: value }));
  };

  const validateConnection = async () => {
    setWorking(true); setError("");
    try {
      const result = await validateDsplGitConnection({ ...connection, credentialRef: connection.credentialRef?.trim() || undefined });
      setValidated(result);
      setProfileId(result.descriptor.profiles[0]?.id || "");
      alertify.success("Conexión y descriptor validados contra un commit inmutable.");
    } catch (cause) { setError(getDsplOrchestratorErrorMessage(cause)); }
    finally { setWorking(false); }
  };

  const importProject = async () => {
    if (!validated || !profileId) return;
    setWorking(true); setError("");
    try {
      await saveDsplGitConnection({
        ...connection,
        credentialRef: connection.credentialRef?.trim() || undefined,
        expectedResolvedCommit: validated.connection.resolvedCommit,
        expectedDescriptorDigest: validated.connection.descriptorDigest,
      });
      const profile: DsplProfileSummary = await importDsplProject(connection.id, profileId);
      const mapping = createDsplMapping(featureModel, profile);
      const productLine = projectService.getProductLineSelected();
      productLine.applicationEngineering.models.push(mapping);
      if (!productLine.applicationEngineering.languagesAllowed.includes(mapping.languageId)) {
        productLine.applicationEngineering.languagesAllowed.push(mapping.languageId);
      }
      projectService.saveProject();
      projectService.raiseEventApplicationEngineeringModel(mapping);
      projectService.modelApplicationEngSelected(projectService.getIdCurrentProductLine(), productLine.applicationEngineering.models.indexOf(mapping));
      onImported?.(mapping);
      alertify.success("Proyecto importado. Confirma ahora los bindings feature–artefacto.");
      setMode(null);
    } catch (cause) { setError(getDsplOrchestratorErrorMessage(cause)); }
    finally { setWorking(false); }
  };

  const generate = async () => {
    setWorking(true); setError("");
    try {
      const result = await createDsplDescriptorDraft({ projectId: draftProjectId, projectName: draftProjectName, features: configurableFeatures });
      setDraft(result.descriptor);
      setDraftText(`${JSON.stringify(result.descriptor, null, 2)}\n`);
      setDraftValid(result.validation.valid);
    } catch (cause) { setError(getDsplOrchestratorErrorMessage(cause)); }
    finally { setWorking(false); }
  };

  const validateDraft = async () => {
    setWorking(true); setError("");
    try {
      const candidate = JSON.parse(draftText) as DsplProjectDescriptor;
      const validation = await validateDsplDescriptor(candidate, false);
      setDraft(candidate);
      setDraftValid(validation.valid);
      if (!validation.valid) setError(validation.errors.join("\n"));
      else alertify.success("El descriptor cumple variamos-project/v1 para su estado actual.");
    } catch (cause) {
      setDraftValid(false);
      setError(cause instanceof SyntaxError ? `JSON inválido: ${cause.message}` : getDsplOrchestratorErrorMessage(cause));
    } finally { setWorking(false); }
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draftText);
    alertify.success("Descriptor copiado.");
  };
  const downloadDraft = () => {
    const url = URL.createObjectURL(new Blob([draftText], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "dspl.json"; anchor.click();
    URL.revokeObjectURL(url);
  };

  return <>
    <div className="d-flex flex-wrap gap-2 mt-2">
      <Button size="sm" variant="outline-primary" onClick={() => setMode("connect")}>Conectar proyecto</Button>
      <Button size="sm" variant="outline-secondary" onClick={() => setMode("generate")}>Generar descriptor</Button>
    </div>
    <Modal show={mode !== null} onHide={close} size="lg" centered scrollable>
      <Modal.Header closeButton><Modal.Title>{mode === "connect" ? "Conectar un proyecto externo" : "Generador de descriptor DSPL"}</Modal.Title></Modal.Header>
      <Modal.Body>
        {mode === "connect" ? <>
          <p>Un <strong>artefacto</strong> es una pieza técnica identificable —archivo, módulo, configuración o prueba— que implementa una capacidad. El repositorio debe describirlos en <code>.variamos/dspl.json</code>.</p>
          <div className="alert alert-info py-2">Git localiza el código; no define su arquitectura. El orquestador fija la rama o tag a un commit y VariaMos sólo recibe IDs y metadatos seguros.</div>
          <label className="d-block mb-2">ID de conexión *<input className="form-control" value={connection.id} onChange={(event) => updateConnection("id", event.target.value)} /></label>
          <label className="d-block mb-2">URL del repositorio Git *<input className="form-control" placeholder="https://git.example.org/equipo/proyecto.git" value={connection.repositoryUrl} onChange={(event) => updateConnection("repositoryUrl", event.target.value)} /></label>
          <div className="row"><label className="col-md-6 mb-2">Rama, tag o commit *<input className="form-control" value={connection.requestedRef} onChange={(event) => updateConnection("requestedRef", event.target.value)} /></label>
          <label className="col-md-6 mb-2">Ruta del descriptor *<input className="form-control" value={connection.descriptorPath} onChange={(event) => updateConnection("descriptorPath", event.target.value)} /></label></div>
          <label className="d-block mb-2">Referencia de credencial (opcional)<input className="form-control" placeholder="secret://git/equipo-proyecto" value={connection.credentialRef || ""} onChange={(event) => updateConnection("credentialRef", event.target.value)} /><small className="text-muted">No pegues tokens, contraseñas ni claves. Este campo acepta sólo una referencia opaca ya administrada por el orquestador.</small></label>
          <Button size="sm" disabled={working || !connection.repositoryUrl.trim()} onClick={validateConnection}>{working ? <Spinner animation="border" size="sm" /> : "Validar conexión"}</Button>
          {validated && <div className="border rounded p-3 mt-3">
            <div><strong>Commit fijado:</strong> <code>{validated.connection.resolvedCommit}</code></div>
            <div><strong>Descriptor:</strong> {validated.connection.descriptorPath}</div>
            <div><strong>Artefactos:</strong> {validated.descriptor.artifacts.length}</div>
            <label className="d-block mt-2">Perfil que se importará<select className="form-select" value={profileId} onChange={(event) => setProfileId(event.target.value)}>{validated.descriptor.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} — {profile.builderAdapter}</option>)}</select></label>
            <details className="mt-2"><summary>Artefactos declarados</summary><ul>{validated.descriptor.artifacts.map((artifact) => <li key={artifact.id}><code>{artifact.id}</code> — {artifact.label || artifact.kind} — <code>{artifact.source.path}</code></li>)}</ul></details>
          </div>}
        </> : <>
          <p>El generador usa las features del modelo para formular preguntas pendientes. No inventa rutas, comandos, credenciales ni asociaciones técnicas.</p>
          <label className="d-block mb-2">ID estable del proyecto *<input className="form-control" value={draftProjectId} onChange={(event) => { setDraftProjectId(event.target.value); setDraft(null); setDraftText(""); }} /></label>
          <label className="d-block mb-2">Nombre del proyecto *<input className="form-control" value={draftProjectName} onChange={(event) => { setDraftProjectName(event.target.value); setDraft(null); setDraftText(""); }} /></label>
          <Button size="sm" disabled={working} onClick={generate}>{working ? <Spinner animation="border" size="sm" /> : "Generar plantilla"}</Button>
          {draft && <><div className={draftValid ? "alert alert-warning mt-3 py-2" : "alert alert-danger mt-3 py-2"}>{draftValid ? <>La estructura cumple JSON Schema como borrador, pero no puede importarse hasta completar artefactos y perfiles y cambiar <code>status</code> a <code>ready</code>.</> : <>El borrador no cumple el JSON Schema.</>}</div>
            <p className="text-muted small">Las propuestas indican qué decisiones faltan; edita el JSON para sustituirlas por artefactos y perfiles reales. Los placeholders nunca se ejecutan.</p>
            <textarea className="form-control font-monospace" rows={18} value={draftText} onChange={(event) => { setDraftText(event.target.value); setDraftValid(false); }} aria-label="Descriptor DSPL generado" />
            <div className="d-flex flex-wrap gap-2 mt-2"><Button size="sm" variant="primary" disabled={working || !draftText.trim()} onClick={validateDraft}>Validar JSON Schema</Button><Button size="sm" variant="outline-primary" disabled={!draftText} onClick={copyDraft}>Copiar</Button><Button size="sm" variant="outline-secondary" disabled={!draftText} onClick={downloadDraft}>Descargar dspl.json</Button></div></>}
        </>}
        {error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}
      </Modal.Body>
      <Modal.Footer><Button variant="outline-secondary" disabled={working} onClick={close}>Cerrar</Button>{mode === "connect" && <Button variant="primary" disabled={working || !validated || !profileId} onClick={importProject}>Importar y crear mapping</Button>}</Modal.Footer>
    </Modal>
  </>;
}
