import React, { useEffect, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import ProjectService from "../../Application/Project/ProjectService";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import { applyBindingAssignments, DsplProfileSummary, synchronizeDsplMapping } from "../../Application/DSPL/DsplMappingFactory";
import { getDsplOrchestratorErrorMessage, getDsplProfiles } from "../../DataProvider/Services/dsplOrchestratorService";

interface Props { projectService: ProjectService; featureModel: Model; mappingModel?: Model; onCreated?: (model: Model) => void; }

const property = (element: any, name: string) => element?.properties?.find((item: any) => item.name === name)?.value;
const mappingRef = (mapping?: Model) => property(mapping?.elements.find((element) => element.type === "DeploymentMapping"), "mapping_ref");

function assignmentsFrom(mapping?: Model): Record<string, string[]> {
  if (!mapping) return {};
  const artifactRefs = new Map(mapping.elements.filter((element) => element.type === "SoftwareArtifact").map((element) => [element.id, property(element, "artifact_ref")]));
  const bindings = new Map(mapping.elements.filter((element) => element.type === "FeatureBinding").map((element) => [element.id, property(element, "source_feature_id")]));
  return mapping.relationships.filter((relationship) => relationship.type === "ImplementedBy").reduce((result, relationship) => {
    const featureId = bindings.get(relationship.sourceId);
    const artifactId = artifactRefs.get(relationship.targetId);
    if (featureId && artifactId) result[featureId] = [...(result[featureId] || []), artifactId];
    return result;
  }, {} as Record<string, string[]>);
}

/** Modal de configuración humana: automatiza la estructura, pero nunca
 * infiere qué código implementa una feature sin confirmación explícita. */
export default function DsplMappingAssistant({ projectService, featureModel, mappingModel, onCreated }: Props) {
  const [profiles, setProfiles] = useState<DsplProfileSummary[]>([]);
  const [profileId, setProfileId] = useState("");
  const [open, setOpen] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const profile = profiles.find((candidate) => candidate.id === profileId);
  const features = useMemo(() => featureModel.elements.filter((element) => element.properties?.some((property) => property.name === "Selected")), [featureModel]);

  useEffect(() => {
    if (!open) return;
    setError("");
    setAssignments(assignmentsFrom(mappingModel));
    getDsplProfiles().then((items) => {
      setProfiles(items);
      const preferred = items.find((item) => item.mappingRef === mappingRef(mappingModel));
      setProfileId(preferred?.id || items[0]?.id || "");
    }).catch((cause) => setError(getDsplOrchestratorErrorMessage(cause)));
  }, [open, mappingModel]);

  const toggle = (featureId: string, artifactId: string) => setAssignments((previous) => {
    const values = new Set(previous[featureId] || []);
    values.has(artifactId) ? values.delete(artifactId) : values.add(artifactId);
    return { ...previous, [featureId]: [...values] };
  });

  const confirm = () => {
    if (!profile) return;
    const productLine = projectService.getProductLineSelected();
    const existing = mappingModel || productLine.applicationEngineering.models.find((candidate) =>
      candidate.type === "DSPL Deployment Mapping v1" && candidate.sourceModelIds?.length === 1 && candidate.sourceModelIds[0] === featureModel.id && mappingRef(candidate) === profile.mappingRef
    );
    const mapping = applyBindingAssignments(synchronizeDsplMapping(existing, featureModel, profile), assignments);
    if (!existing) productLine.applicationEngineering.models.push(mapping);
    if (!productLine.applicationEngineering.languagesAllowed.includes(mapping.languageId)) {
      productLine.applicationEngineering.languagesAllowed.push(mapping.languageId);
    }
    projectService.saveProject();
    projectService.raiseEventApplicationEngineeringModel(mapping);
    projectService.modelApplicationEngSelected(projectService.getIdCurrentProductLine(), productLine.applicationEngineering.models.indexOf(mapping));
    onCreated?.(mapping);
    setOpen(false);
  };

  return <>
    <Button size="sm" variant="outline-secondary" onClick={() => setOpen(true)}>Configurar bindings</Button>
    <Modal show={open} onHide={() => setOpen(false)} size="xl" centered scrollable aria-label="Configurar despliegue DSPL">
      <Modal.Header closeButton><Modal.Title>Configurar despliegue DSPL</Modal.Title></Modal.Header>
      <Modal.Body>
        <p className="text-muted">Elige un perfil y confirma qué artefactos realizan cada feature. Un artefacto es una unidad técnica versionable —archivo, módulo, configuración o prueba— y puedes marcar varios por feature.</p>
        {error && <div className="alert alert-danger">{error}</div>}
        <label className="d-block mb-3">Perfil técnico
          <select aria-label="Perfil técnico" value={profileId} onChange={(event) => setProfileId(event.target.value)} style={{ display: "block", width: "100%", marginTop: 4 }}>
            {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {profile?.provenance && <div className="alert alert-light border py-2" style={{ fontSize: 12 }}>
          <strong>Fuente Git:</strong> conexión <code>{profile.provenance.connectionId}</code><br />
          <strong>Commit:</strong> <code>{profile.provenance.resolvedCommit}</code><br />
          <strong>Descriptor:</strong> <code>{profile.provenance.descriptorPath}</code>
        </div>}
        {profile && <div style={{ overflowX: "auto" }}><table className="table table-sm table-bordered align-middle" style={{ minWidth: 620, fontSize: 12 }}>
          <thead><tr><th>Feature</th>{profile.artifacts.map((artifact) => <th key={artifact.id} title={`${artifact.id} · ${artifact.kind} · ${artifact.version}`}>{artifact.label || artifact.id.split(".").slice(-1)[0]}</th>)}</tr></thead>
          <tbody>{features.map((feature) => <tr key={feature.id}><td>{feature.name}</td>{profile.artifacts.map((artifact) => <td className="text-center" key={artifact.id}><input aria-label={`${feature.name} ${artifact.id}`} type="checkbox" checked={(assignments[feature.id] || []).includes(artifact.id)} onChange={() => toggle(feature.id, artifact.id)} /></td>)}</tr>)}</tbody>
        </table></div>}
      </Modal.Body>
      <Modal.Footer><Button variant="outline-secondary" onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" disabled={!profile} onClick={confirm}>{mappingModel ? "Actualizar mapping" : "Crear mapping"}</Button></Modal.Footer>
    </Modal>
  </>;
}
