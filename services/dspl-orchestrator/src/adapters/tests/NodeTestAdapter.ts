import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { DeploymentManifest } from "../../contracts";
import { DsplTestError } from "./HtmlValidationAdapter";

export class NodeTestAdapter {
  public run(manifest: DeploymentManifest, outputDirectory: string): { adapter: string; status: "passed"; files: string[] } {
    if (!manifest.operations.some((operation) => operation.type === "test" && operation.adapter === "node-test-v1")) {
      throw new DsplTestError("El manifest no declara node-test-v1.");
    }
    const testFiles = this.findTests(path.join(outputDirectory, "dist"));
    if (testFiles.length > 0) {
      try {
        execFileSync(process.execPath, ["--test", ...testFiles], { stdio: "pipe" });
      } catch (error) {
        const details = (error as { stderr?: Buffer }).stderr?.toString("utf8") || "";
        throw new DsplTestError(`Las pruebas del monolito fallaron. ${details}`.trim());
      }
    }
    return { adapter: "node-test-v1", status: "passed", files: testFiles.map((file) => path.relative(outputDirectory, file)) };
  }

  private findTests(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return this.findTests(entryPath);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [entryPath] : [];
    });
  }
}
