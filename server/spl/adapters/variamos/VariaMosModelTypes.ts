import { ArtifactCatalog } from "../../contracts";

export interface VariaMosProperty {
  name: string;
  value?: unknown;
}

export interface VariaMosElement {
  id: string;
  type: string;
  name?: string;
  properties?: VariaMosProperty[];
}

export interface VariaMosRelationship {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  properties?: VariaMosProperty[];
}

export interface VariaMosSerializedModel {
  id: string;
  name?: string;
  type: string;
  languageId?: string | number;
  sourceModelIds?: string[];
  elements: VariaMosElement[];
  relationships: VariaMosRelationship[];
}

export interface VariaMosModelAdapterOptions {
  catalog: ArtifactCatalog;
  configurationId: string;
  productLineId: string;
  modelVersion: string;
  inputs?: Record<string, string | number | boolean | null>;
}
