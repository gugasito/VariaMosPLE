import React, { useEffect, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import ProjectService from "../../Application/Project/ProjectService";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import { applyBindingAssignments, isSplMappingLanguage, SplProfileSummary, synchronizeSplMapping } from "../../Application/SPL/SplMappingFactory";
import { getSplOrchestratorErrorMessage, getSplProfiles } from "../../DataProvider/Services/splOrchestratorService";

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

/** Human configuration dialog: automates the structure but never infers which
 * code implements a feature without explicit confirmation. */
export default function SplMappingAssistant({ projectService, featureModel, mappingModel, onCreated }: Props) {
  const [profiles, setProfiles] = useState<SplProfileSummary[]>([]);
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
    getSplProfiles().then((items) => {
      setProfiles(items);
      const preferred = items.find((item) => item.mappingRef === mappingRef(mappingModel));
      setProfileId(preferred?.id || items[0]?.id || "");
    }).catch((cause) => setError(getSplOrchestratorErrorMessage(cause)));
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
      isSplMappingLanguage(candidate.type) && candidate.sourceModelIds?.length === 1 && candidate.sourceModelIds[0] === featureModel.id && mappingRef(candidate) === profile.mappingRef
    );
    const mapping = applyBindingAssignments(synchronizeSplMapping(existing, featureModel, profile), assignments);
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
    <Button size="sm" variant="outline-secondary" onClick={() => setOpen(true)}>Configure bindings</Button>
    <Modal show={open} onHide={() => setOpen(false)} size="xl" centered scrollable aria-label="Configure SPL deployment">
      <Modal.Header closeButton><Modal.Title>Configure SPL deployment</Modal.Title></Modal.Header>
      <Modal.Body>
        <p className="text-muted">Choose a profile and confirm which artifacts implement each feature. An artifact is a versioned technical unit—a file, module, configuration, or test—and each feature can use several artifacts.</p>
        {error && <div className="alert alert-danger">{error}</div>}
        <label className="d-block mb-3">Technical profile
          <select aria-label="Technical profile" value={profileId} onChange={(event) => setProfileId(event.target.value)} style={{ display: "block", width: "100%", marginTop: 4 }}>
            {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {profile?.provenance && <div className="alert alert-light border py-2" style={{ fontSize: 12 }}>
          <strong>Source:</strong> {profile.provenance.provider === "git" ? "Git" : "Local folder"} — connection <code>{profile.provenance.connectionId}</code><br />
          {profile.provenance.provider === "git"
            ? <><strong>Commit:</strong> <code>{profile.provenance.resolvedCommit}</code><br /></>
            : <><strong>Snapshot:</strong> <code>{profile.provenance.snapshotDigest}</code><br /></>}
          <strong>Descriptor:</strong> <code>{profile.provenance.descriptorPath}</code>
        </div>}
        {profile && <div style={{ overflowX: "auto" }}><table className="table table-sm table-bordered align-middle" style={{ minWidth: 620, fontSize: 12 }}>
          <thead><tr><th>Feature</th>{profile.artifacts.map((artifact) => <th key={artifact.id} title={`${artifact.id} · ${artifact.kind} · ${artifact.version}`}>{artifact.label || artifact.id.split(".").slice(-1)[0]}</th>)}</tr></thead>
          <tbody>{features.map((feature) => <tr key={feature.id}><td>{feature.name}</td>{profile.artifacts.map((artifact) => <td className="text-center" key={artifact.id}><input aria-label={`${feature.name} ${artifact.id}`} type="checkbox" checked={(assignments[feature.id] || []).includes(artifact.id)} onChange={() => toggle(feature.id, artifact.id)} /></td>)}</tr>)}</tbody>
        </table></div>}
      </Modal.Body>
      <Modal.Footer><Button variant="outline-secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!profile} onClick={confirm}>{mappingModel ? "Update mapping" : "Create mapping"}</Button></Modal.Footer>
    </Modal>
  </>;
}
