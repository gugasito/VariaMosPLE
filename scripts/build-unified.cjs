const { spawnSync } = require("child_process");
const dotenv = require("dotenv");
dotenv.config();
const environment = {
  ...process.env,
  REACT_APP_VARIAMOS_PUBLIC_GATEWAY:
    process.env.VARIAMOS_PUBLIC_GATEWAY || "https://app.variamos.com",
};
for (const command of [
  ["node_modules/react-scripts/bin/react-scripts.js", "build"],
  ["node_modules/typescript/bin/tsc", "-p", "server/tsconfig.json"],
]) {
  const result = spawnSync(process.execPath, command, { stdio: "inherit", env: environment });
  if (result.status !== 0) process.exit(result.status || 1);
}
