import fs from "fs";
import path from "path";
import { DeploymentManifest } from "../../contracts";

export class DsplTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DsplTestError";
    Object.setPrototypeOf(this, DsplTestError.prototype);
  }
}

export class HtmlValidationAdapter {
  public run(manifest: DeploymentManifest, outputDirectory: string): { adapter: string; status: "passed" } {
    if (!manifest.operations.some((operation) => operation.type === "test" && operation.adapter === "html-validation-v1")) {
      throw new DsplTestError("El manifest no declara html-validation-v1.");
    }
    const index = fs.readFileSync(path.join(outputDirectory, "index.html"), "utf8");
    if (!index.includes(`data-manifest-id="${manifest.manifestId}"`)) {
      throw new DsplTestError("El sitio estático no contiene el manifest esperado.");
    }
    return { adapter: "html-validation-v1", status: "passed" };
  }
}
