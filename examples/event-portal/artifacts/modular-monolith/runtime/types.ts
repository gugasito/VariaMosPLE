import { IncomingMessage } from "http";

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface PortalModule {
  id: string;
  render: () => string;
  handle?: (request: IncomingMessage, body: Record<string, unknown>) => Promise<ApiResponse | undefined>;
}
