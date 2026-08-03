import { PortalModule } from "../../runtime/types";

export const portalModule: PortalModule = {
  id: "feature.event.registration.api",
  render: () => "",
  handle: async (request, body) => {
    if (request.url?.split("?")[0] !== "/api/registrations") return undefined;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { status: 422, body: { error: "Name is required." } };
    return { status: 201, body: { registrationId: `registration-${Date.now()}`, name } };
  },
};
