import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/extend-expect";
import SplProjectOnboarding from "./SplProjectOnboarding";
import {
  SplProjectDescriptor,
  getSplCredentialBindings,
  getSplProjectSources,
  getSplRuntimeCapabilities,
  getSplTargets,
  uploadSplProjectFolder,
  validateSplDescriptor,
  validateSplProjectConnection,
} from "../../DataProvider/Services/splOrchestratorService";

jest.mock("alertifyjs", () => ({ success: jest.fn() }));

jest.mock("../../DataProvider/Services/splOrchestratorService", () => ({
  getSplOrchestratorErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Error",
  getSplCredentialBindings: jest.fn().mockResolvedValue([]),
  getSplProjectSources: jest.fn(),
  getSplRuntimeCapabilities: jest.fn().mockResolvedValue({ localTargetsEnabled: true }),
  getSplTargets: jest.fn().mockResolvedValue([]),
  importSplProject: jest.fn(),
  saveSplProjectConnection: jest.fn(),
  uploadSplProjectFolder: jest.fn(),
  validateSplDescriptor: jest.fn(),
  validateSplProjectConnection: jest.fn(),
}));

const template: SplProjectDescriptor = {
  schemaVersion: "variamos-project/v1",
  status: "ready",
  project: { id: "real-project", name: "Real project" },
  artifacts: [{
    id: "real-project.shell",
    kind: "html-fragment",
    version: "1.0.0",
    source: { path: "artifacts/shell.html" },
  }],
  profiles: [{
    id: "real-project.static",
    name: "Static",
    builderAdapter: "static-site-v1",
    testAdapter: "html-validation-v1",
    artifactIds: ["real-project.shell"],
    requiredTargetCapabilities: ["docker", "static-http", "single-container"],
  }],
};

const projectSources = [
  {
    id: "git-remote",
    provider: "git",
    name: "Remote Git repository",
    availability: "available",
    descriptorPath: ".variamos/spl.json",
    supportsCredentialRef: true,
    help: "Repository over HTTPS or SSH.",
    plannedFields: ["repositoryUrl", "requestedRef", "descriptorPath", "credentialRef"],
  },
  {
    id: "folder-upload",
    provider: "upload",
    name: "Upload project folder",
    availability: "available",
    descriptorPath: ".variamos/spl.json",
    supportsCredentialRef: false,
    help: "Transfers descriptor and declared artifacts temporarily.",
    plannedFields: ["uploadId", "snapshotDigest", "descriptorDigest"],
  },
] as const;

const renderOnboarding = () =>
  render(
    <SplProjectOnboarding
      projectService={{ getProject: () => ({ id: "project-test" }) } as any}
      featureModel={{ id: "feature-model", name: "Feature model", elements: [] } as any}
    />
  );

const openDescriptorTool = async () => {
  fireEvent.click(screen.getByRole("button", { name: /template and validator/i }));
  const editor = await screen.findByRole("textbox", { name: /spl\.json descriptor content/i });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("\"real-project.shell\""));
  return editor;
};

describe("SplProjectOnboarding descriptor tool", () => {
  const validateMock = validateSplDescriptor as jest.MockedFunction<typeof validateSplDescriptor>;
  const projectSourcesMock = getSplProjectSources as jest.MockedFunction<typeof getSplProjectSources>;
  const validateConnectionMock = validateSplProjectConnection as jest.MockedFunction<typeof validateSplProjectConnection>;

  beforeEach(() => {
    jest.clearAllMocks();
    (getSplCredentialBindings as jest.Mock).mockResolvedValue([]);
    projectSourcesMock.mockResolvedValue(projectSources as any);
    (getSplTargets as jest.Mock).mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `${JSON.stringify(template, null, 2)}\n`,
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("replaces the generator with a real downloadable template and field reference", async () => {
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    renderOnboarding();

    expect(screen.queryByRole("button", { name: /generate descriptor/i })).not.toBeInTheDocument();
    const editor = await openDescriptorTool();
    expect((editor as HTMLTextAreaElement).value).toContain("\"real-project.shell\"");
    expect(screen.getByRole("heading", { name: /what is the descriptor/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: /what does it do/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: /what should you change in this template/i })).toBeVisible();
    expect(screen.getByText(/technical index of your external project/i)).toBeVisible();
    expect(screen.queryByText(/template corresponds to the event portal test/i)).not.toBeInTheDocument();
    expect(screen.getByText(/supported options by field/i)).toBeVisible();
    expect(screen.getByText(/do not represent a page's visual order/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /download spl\.json template/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test("checks a ready descriptor through the orchestrator", async () => {
    validateMock.mockResolvedValue({ valid: true, errors: [] });
    renderOnboarding();
    await openDescriptorTool();
    fireEvent.click(screen.getByRole("button", { name: /validate spl\.json/i }));

    await waitFor(() => expect(validateMock).toHaveBeenCalledWith(template, true, "project-test"));
    expect(await screen.findByText(/valid descriptor/i)).toBeVisible();
  });

  test("shows every importability error returned by the checker", async () => {
    validateMock.mockResolvedValue({
      valid: false,
      errors: [
        "The profile does not include a required dependency.",
        "The builder does not support the artifact type.",
      ],
    });
    renderOnboarding();
    await openDescriptorTool();
    fireEvent.click(screen.getByRole("button", { name: /validate spl\.json/i }));

    expect(await screen.findByText(/not importable yet/i)).toBeVisible();
    expect(screen.getByText(/does not include a required dependency/i)).toBeVisible();
    expect(screen.getByText(/does not support the artifact type/i)).toBeVisible();
  });

  test("reports malformed JSON without calling the orchestrator", async () => {
    renderOnboarding();
    const editor = await openDescriptorTool();
    fireEvent.change(editor, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: /validate spl\.json/i }));

    expect(await screen.findByText(/invalid json/i)).toBeVisible();
    expect(validateMock).not.toHaveBeenCalled();
  });

  test("shows only remote Git and the browser folder upload source", async () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole("button", { name: /connect project/i }));

    await waitFor(() => expect(projectSourcesMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /upload project folder available/i })).toBeVisible()
    );
    expect(screen.getByRole("radio", { name: /remote git repository/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /upload project folder/i })).toBeVisible();
    expect(screen.queryByRole("radio", { name: /http file or catalog/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /package registry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /oci image/i })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /remote git repository url/i })).toBeVisible();
    expect(screen.getByRole("combobox", { name: /credential reference/i })).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: /upload project folder/i }));
    expect(screen.getByLabelText("Project folder", { exact: true })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /remote git repository url/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import and create feature.artifact mapping/i })).toBeDisabled();
  });

  test("does not expose a local Git path option", async () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole("button", { name: /connect project/i }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /upload project folder/i })).toBeVisible());
    expect(screen.queryByText(/local git repository/i)).not.toBeInTheDocument();
  });

  test("allows importing a validated project before a production target exists", async () => {
    (getSplRuntimeCapabilities as jest.Mock).mockResolvedValue({ localTargetsEnabled: false });
    validateConnectionMock.mockResolvedValue({
      connection: {
        id: "real-project",
        provider: "git",
        repositoryUrl: "https://github.com/example/real-project.git",
        requestedRef: "main",
        descriptorPath: ".variamos/spl.json",
        resolvedCommit: "a".repeat(40),
        descriptorDigest: "sha256:test",
        validatedAt: "2026-08-12T00:00:00.000Z",
        usesCredentialRef: false,
      },
      descriptor: template,
      validation: { valid: true, errors: [] },
    } as any);
    renderOnboarding();
    fireEvent.click(screen.getByRole("button", { name: /connect project/i }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: /remote git repository url/i })).toBeVisible());
    fireEvent.change(screen.getByRole("textbox", { name: /remote git repository url/i }), {
      target: { value: "https://github.com/example/real-project.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: /validate remote repository/i }));

    await waitFor(() => expect(validateConnectionMock).toHaveBeenCalled());
    expect(await screen.findByText(/no compatible external target available/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /import and create feature.artifact mapping/i })).toBeEnabled();
  });

  test("requires a browser folder selection before uploading", async () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole("button", { name: /connect project/i }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /upload project folder/i })).toBeVisible());
    fireEvent.click(screen.getByRole("radio", { name: /upload project folder/i }));
    expect(screen.getByLabelText("Project folder", { exact: true })).toHaveAttribute("webkitdirectory");
    expect(screen.getByRole("button", { name: /^upload project folder$/i })).toBeDisabled();
  });
});
