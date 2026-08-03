// This file supports source-asset validation. The SPL builder deterministically
// replaces it with the selected modules before transpiling the product.
import { PortalModule } from "../types";

export const enabledFeatures: readonly string[] = [];
export const portalModules: PortalModule[] = [];
