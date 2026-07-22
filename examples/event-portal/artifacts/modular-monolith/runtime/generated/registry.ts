// Este archivo permite validar los activos fuente. El builder DSPL lo reemplaza
// determinísticamente con los módulos seleccionados antes de transpilar el producto.
import { PortalModule } from "../types";

export const enabledFeatures: readonly string[] = [];
export const portalModules: PortalModule[] = [];
