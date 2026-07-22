const isLocalBrowser =
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1"].includes(window.location.hostname);

const publicGateway =
  process.env.REACT_APP_VARIAMOS_PUBLIC_GATEWAY ||
  (isLocalBrowser
    ? "https://app.variamos.com"
    : typeof window !== "undefined"
      ? window.location.origin
      : "https://app.variamos.com");

const gatewayUrl = (path: string): string =>
  `${publicGateway.replace(/\/$/, "")}${path}`;

export const Config = {
  VERSION: "4.25.05.09.07",
  NODE_ENV: process.env.REACT_APP_NODE_ENV || "development",
  HOST: process.env.REACT_APP_HOST || "localhost",
  PORT: process.env.REACT_APP_PORT || 3000,
  SERVICES: {
    urlBackEndAdmin:
      process.env.REACT_APP_VARIAMOS_ADMIN_API_URL ||
      gatewayUrl("/variamos_ms_admin"),
    urlBackEndLanguage:
      process.env.REACT_APP_URLBACKENDLANGUAGE ||
      gatewayUrl("/variamos_ms_languages"),
    urlBackEndProjectPersistence:
      process.env.REACT_APP_URLVMSPROJECTS || gatewayUrl("/vms_projects"),
    urlDsplOrchestrator:
      process.env.REACT_APP_DSPL_ORCHESTRATOR_URL || "http://127.0.0.1:8090",
    urlBackEndRestriction: process.env.REACT_APP_URLBACKENDRESTRICTION,
    urlVariamosDocumentation: process.env.REACT_APP_URLVARIAMOSDOCUMENTATION,
    urlVariamosLanguages: process.env.REACT_APP_URLVARIAMOSLANGUAGES,
    urlVariamosLangDocumentation:
      process.env.REACT_APP_URLVARIAMOSLANGDOCUMENTATION,
  },
  LOGIN_URL:
    process.env.REACT_APP_VARIAMOS_LOGIN_URL ||
    gatewayUrl("/variamos_admin/#/login"),
};
