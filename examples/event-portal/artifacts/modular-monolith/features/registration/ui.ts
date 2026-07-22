import { PortalModule } from "../../runtime/types";

export const portalModule: PortalModule = {
  id: "feature.event.registration.ui",
  render: () => "<section id=\"registration\"><h2>Inscripción</h2><p>Envía una solicitud a POST /api/registrations.</p></section>",
};
