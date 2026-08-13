import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/extend-expect";
import SplTargetManager from "./SplTargetManager";
import {
  createSplTarget,
  deleteSplTarget,
  getSplProjectAccess,
  getSplTargetAdapters,
  getSplTargets,
} from "../../DataProvider/Services/splOrchestratorService";

jest.mock("alertifyjs", () => ({ success: jest.fn() }));
jest.mock("../../DataProvider/Services/splOrchestratorService", () => ({
  getSplOrchestratorErrorMessage: (error: unknown) => error instanceof Error ? error.message : "Error",
  getSplTargetAdapters: jest.fn(),
  getSplProjectAccess: jest.fn(),
  getSplTargets: jest.fn(),
  createSplTarget: jest.fn(),
  deleteSplTarget: jest.fn(),
}));

const nginxImage = `docker.io/library/nginx@sha256:${"a".repeat(64)}`;
const passwordOnlyAdapter = {
  id: "ssh-compose-v1",
  name: "SSH server with Docker Compose",
  availability: "available",
  credentialTypes: [],
  capabilities: ["docker", "docker-compose", "static-http", "single-container"],
  authenticationModes: [{
    id: "prompt-password",
    name: "SSH username and password",
    description: "Requested for every connection.",
    storesSecret: false,
    availability: "available",
  }],
  presets: [{
    id: "static-website",
    name: "Static website (Nginx)",
    description: "HTML and CSS served by Nginx.",
    builderAdapters: ["static-site-v1"],
    capabilities: ["docker", "docker-compose", "static-http", "single-container"],
    defaultPublishedPort: 8080,
    images: { nginx: nginxImage },
  }],
  configurationSchema: {},
} as any;

const projectService = {
  getProject: () => ({ id: "project-test" }),
} as any;

async function openWizard() {
  render(<SplTargetManager projectService={projectService} />);
  fireEvent.click(screen.getByRole("button", { name: /manage deployment targets/i }));
  await screen.findByRole("heading", { name: /choose the destination technology/i });
  await screen.findByText("Static website (Nginx)");
}

async function completeFirstStep(name = "Main web server") {
  fireEvent.change(screen.getByRole("textbox", { name: /target name/i }), { target: { value: name } });
  expect(screen.getByDisplayValue(name.toLowerCase().replace(/\s+/g, "-"))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /continue to ssh login/i }));
  await screen.findByRole("heading", { name: /enter the ssh username and password/i });
}

describe("SplTargetManager password-only target assistant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSplTargetAdapters as jest.Mock).mockResolvedValue([passwordOnlyAdapter]);
    (getSplProjectAccess as jest.Mock).mockResolvedValue({
      projectId: "project-test",
      role: "owner",
      permissions: { manageTargets: true, manageCredentials: false },
    });
    (getSplTargets as jest.Mock).mockResolvedValue([]);
  });

  test("does not expose managed keys, Keychain, AWS or credential references", async () => {
    await openWizard();
    await completeFirstStep();

    expect(screen.getByRole("textbox", { name: /ssh username/i })).toBeVisible();
    expect(screen.getByLabelText(/ssh password \(used once\)/i)).toBeVisible();
    expect(screen.queryByText(/managed ssh key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/keychain/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/aws secrets manager/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/credential reference/i)).not.toBeInTheDocument();
  });

  test("validates and saves with a one-time password only", async () => {
    (createSplTarget as jest.Mock).mockResolvedValue({
      schemaVersion: "deployment-target-connection/v1",
      id: "ubuntu-server",
      projectId: "project-test",
      name: "Ubuntu server",
      adapter: "ssh-compose-v1",
      endpoint: { host: "server.example.org", port: 22, sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}` },
      publishedPort: 8080,
      publicBaseUrl: "http://server.example.org:8080/",
      images: { nginx: nginxImage },
      capabilities: ["docker", "docker-compose", "static-http", "single-container"],
      authentication: { mode: "prompt-password", username: "deployer" },
      status: "active",
      revision: 1,
    });

    await openWizard();
    await completeFirstStep("Ubuntu server");
    fireEvent.change(screen.getByRole("textbox", { name: /ssh username/i }), {
      target: { value: "deployer" },
    });
    fireEvent.change(screen.getByLabelText(/ssh password \(used once\)/i), {
      target: { value: "temporary-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue to ssh server/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /ssh host \*/i }), { target: { value: "server.example.org" } });
    fireEvent.change(screen.getByRole("textbox", { name: /ssh host-key fingerprint/i }), { target: { value: `SHA256:${"A".repeat(43)}` } });
    fireEvent.click(screen.getByRole("button", { name: /continue to publication/i }));
    fireEvent.click(await screen.findByRole("button", { name: /validate and save target/i }));

    await waitFor(() => expect(createSplTarget).toHaveBeenCalledWith(
      "project-test",
      expect.objectContaining({
        id: "ubuntu-server",
        authentication: { mode: "prompt-password", username: "deployer" },
      }),
      {
        schemaVersion: "ssh-password/v1",
        username: "deployer",
        password: "temporary-password",
      }
    ));
    const storedTarget = (createSplTarget as jest.Mock).mock.calls[0][1];
    expect(storedTarget).not.toHaveProperty("password");
    expect(storedTarget).not.toHaveProperty("deploymentCredentialRef");
    expect(await screen.findByText(/was validated over ssh and saved as revision 1/i)).toBeVisible();
  });

  test("keeps the temporary password in memory after a safe validation error", async () => {
    (createSplTarget as jest.Mock).mockRejectedValueOnce(
      new Error("The authorized deployment directory does not exist on the SSH server.")
    );

    await openWizard();
    await completeFirstStep("Missing directory server");
    fireEvent.change(screen.getByRole("textbox", { name: /ssh username/i }), {
      target: { value: "deployer" },
    });
    fireEvent.change(screen.getByLabelText(/ssh password \(used once\)/i), {
      target: { value: "keep-only-in-component-memory" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue to ssh server/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /ssh host \*/i }), {
      target: { value: "server.example.org" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /ssh host-key fingerprint/i }), {
      target: { value: `SHA256:${"A".repeat(43)}` },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue to publication/i }));
    fireEvent.click(await screen.findByRole("button", { name: /validate and save target/i }));

    expect(await screen.findByText(/authorized deployment directory does not exist/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText(/ssh password \(used once\)/i)).toHaveValue(
      "keep-only-in-component-memory"
    );
  });

  test("deletes a saved target instead of leaving it disabled in the list", async () => {
    const existingTarget = {
      schemaVersion: "deployment-target-connection/v1",
      id: "old-ssh-target",
      projectId: "project-test",
      name: "Old SSH target",
      adapter: "ssh-compose-v1",
      endpoint: {
        host: "server.example.org",
        port: 22,
        sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
      publishedPort: 8080,
      publicBaseUrl: "http://server.example.org:8080/",
      images: { nginx: nginxImage },
      capabilities: ["docker", "docker-compose", "static-http", "single-container"],
      authentication: { mode: "prompt-password", username: "deployer" },
      status: "disabled",
      revision: 2,
    } as any;
    (getSplTargets as jest.Mock)
      .mockResolvedValueOnce([existingTarget])
      .mockResolvedValueOnce([]);
    (deleteSplTarget as jest.Mock).mockResolvedValue({
      deleted: true,
      targetRef: existingTarget.id,
    });
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);

    await openWizard();
    fireEvent.click(screen.getByText(/existing ssh targets/i));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteSplTarget).toHaveBeenCalledWith(
      "project-test",
      "old-ssh-target"
    ));
    await waitFor(() => expect(screen.queryByText("Old SSH target")).not.toBeInTheDocument());
    confirm.mockRestore();
  });
});
