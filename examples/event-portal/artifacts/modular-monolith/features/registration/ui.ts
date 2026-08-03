import { PortalModule } from "../../runtime/types";

export const portalModule: PortalModule = {
  id: "feature.event.registration.ui",
  render: () => "<section id=\"registration\"><h2>Registration</h2><p>Send a request to POST /api/registrations.</p></section>",
};
