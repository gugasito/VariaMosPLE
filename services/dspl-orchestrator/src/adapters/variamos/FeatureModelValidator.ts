import { VariaMosElement, VariaMosSerializedModel } from "./VariaMosModelTypes";

function property(element: VariaMosElement | undefined, name: string): string | undefined {
  const value = (element?.properties || []).find((candidate) => candidate.name === name)?.value;
  return typeof value === "string" ? value.trim() : undefined;
}

/** Validación local y deliberadamente pequeña del subconjunto de Feature Models
 * que VariaMos usa en sus modelos. Evita delegar la seguridad de deploy a
 * un servicio semántico remoto. */
export function validateFeatureModel(model: VariaMosSerializedModel): string[] {
  const errors: string[] = [];
  const byId = new Map(model.elements.map((element) => [element.id, element]));
  const selected = (id: string): boolean | undefined => {
    const value = property(byId.get(id), "Selected");
    if (value === "Selected") return true;
    if (value === "Unselected") return false;
    return undefined;
  };
  const named = (id: string) => byId.get(id)?.name || id;
  const roots = model.elements.filter((element) => element.type === "RootFeature");
  if (roots.length !== 1) errors.push("El feature model debe declarar exactamente un RootFeature.");
  if (roots[0] && selected(roots[0].id) !== true) errors.push("La feature raíz debe estar seleccionada.");

  model.elements.filter((element) => "Selected" in Object.fromEntries((element.properties || []).map((item) => [item.name, item.value]))).forEach((element) => {
    if (selected(element.id) === undefined) errors.push(`La feature '${named(element.id)}' debe estar Selected o Unselected.`);
  });

  for (const relationship of model.relationships || []) {
    const source = byId.get(relationship.sourceId);
    const target = byId.get(relationship.targetId);
    if (!source || !target) { errors.push(`La relación '${relationship.id}' apunta a una feature inexistente.`); continue; }
    const type = property(relationship as unknown as VariaMosElement, "Type");
    const sourceSelected = selected(source.id);
    const targetSelected = selected(target.id);
    if (type === "Mandatory") {
      if (sourceSelected === true && target.type !== "Bundle" && targetSelected !== true) errors.push(`'${named(target.id)}' es obligatoria cuando '${named(source.id)}' está seleccionada.`);
      if (target.type !== "Bundle" && targetSelected === true && sourceSelected !== true) errors.push(`'${named(target.id)}' requiere la selección de '${named(source.id)}'.`);
    } else if (type === "Optional") {
      if (targetSelected === true && sourceSelected !== true) errors.push(`'${named(target.id)}' no puede seleccionarse sin '${named(source.id)}'.`);
    } else if (type === "Includes" && sourceSelected === true && targetSelected !== true) {
      errors.push(`'${named(source.id)}' incluye '${named(target.id)}'.`);
    } else if (type === "Excludes" && sourceSelected === true && targetSelected === true) {
      errors.push(`'${named(source.id)}' excluye '${named(target.id)}'.`);
    }
  }

  for (const bundle of model.elements.filter((element) => element.type === "Bundle")) {
    const parents = model.relationships.filter((relationship) => relationship.targetId === bundle.id);
    const active = parents.some((relationship) => selected(relationship.sourceId) === true);
    if (!active) continue;
    const children = model.relationships.filter((relationship) => relationship.sourceId === bundle.id).map((relationship) => relationship.targetId);
    const count = children.filter((id) => selected(id) === true).length;
    const type = property(bundle, "Type");
    if (type === "Xor" && count !== 1) errors.push(`El grupo XOR '${named(bundle.id)}' exige exactamente una alternativa.`);
    if (type === "Or" && count < 1) errors.push(`El grupo OR '${named(bundle.id)}' exige al menos una alternativa.`);
    if (type === "And" && count !== children.length) errors.push(`El grupo AND '${named(bundle.id)}' exige todas sus alternativas.`);
    if (type === "Range") {
      const min = Number(property(bundle, "RangeMin"));
      const max = Number(property(bundle, "RangeMax"));
      if (!Number.isInteger(min) || !Number.isInteger(max) || count < min || count > max) errors.push(`El grupo Range '${named(bundle.id)}' no cumple su cardinalidad.`);
    }
  }
  return errors;
}
