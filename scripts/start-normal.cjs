const net = require("node:net");
const { spawn } = require("node:child_process");

const port = Number(process.env.PORT || "3000");
const host = process.env.HOST || "localhost";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT debe ser un número válido; se recibió: ${process.env.PORT}`);
  process.exit(1);
}

const probe = net.createServer();

probe.once("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(
      `El puerto ${port} ya está ocupado. Detén el proceso anterior o ejecuta ` +
      `PORT=3001 npm start de forma explícita.`
    );
  } else {
    console.error(`No se pudo comprobar el puerto ${port}:`, error);
  }
  process.exit(1);
});

probe.once("listening", () => {
  probe.close(() => {
    const reactScripts = require.resolve("react-scripts/bin/react-scripts.js");
    const child = spawn(process.execPath, [reactScripts, "start"], {
      stdio: "inherit",
      env: {
        ...process.env,
        HOST: host,
        PORT: String(port),
      },
    });

    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  });
});

probe.listen(port, host);
