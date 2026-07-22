const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const assets = path.resolve(__dirname, "../artifacts");

test("el fixture Portal de Eventos contiene activos estáticos y modulares propios", () => {
  assert.ok(fs.existsSync(path.join(assets, "static/agenda.html")));
  assert.ok(fs.existsSync(path.join(assets, "modular-monolith/runtime/server.ts")));
  assert.ok(fs.existsSync(path.join(assets, "modular-monolith/features/registration/api.ts")));
  assert.ok(fs.existsSync(path.join(assets, "modular-monolith/features/registration/schema.json")));
});
