import fs from "fs";
import path from "path";
import { DeploymentManifest } from "../../contracts";

export class SplTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplTestError";
    Object.setPrototypeOf(this, SplTestError.prototype);
  }
}

export class HtmlValidationAdapter {
  public run(manifest: DeploymentManifest, outputDirectory: string): { adapter: string; status: "passed" } {
    if (!manifest.operations.some((operation) => operation.type === "test" && operation.adapter === "html-validation-v1")) {
      throw new SplTestError("The manifest does not declare html-validation-v1.");
    }
    const index = fs.readFileSync(path.join(outputDirectory, "index.html"), "utf8");
    if (!index.includes(`data-manifest-id="${manifest.manifestId}"`)) {
      throw new SplTestError("The static site does not contain the expected manifest.");
    }
    return { adapter: "html-validation-v1", status: "passed" };
  }
}
