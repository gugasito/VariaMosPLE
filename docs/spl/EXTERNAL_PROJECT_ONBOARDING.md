# External project onboarding for an SPL

## Result

Project onboarding is part of the normal application: the frontend distributes the mapping language, the UI displays **Connect project**, and the orchestrator maintains dynamic connections and imports outside the model.

```text
feature model
  + managed Git connection or local folder
  + .variamos/spl.json at a commit or snapshot
  -> catalog with calculated hashes
  -> mapping confirmed by a person
  -> plan / build / test / local Docker
```

## Prepare a project

The preferred descriptor lives at `.variamos/spl.json`. `project.id`, `project.name`, every artifact ID/type/version/path, and at least one profile are required when `status` is `ready`. Labels, descriptions, dependencies, entry points, and declared integrity are optional.

Paths are relative to the connected repository or folder. Absolute paths, `..`, commands, tokens, passwords, deployment hosts, and keys are not allowed. The exact contract is in `contracts/schemas/variamos-project.schema.json`; `examples/external-project-onboarding/` is a template exercised by tests both as a Git repository and a folder without Git.

The application distributes `public/templates/spl.json`, a verified copy of that external project's working descriptor. It contains neither placeholders nor invented values. The interface explains which fields must be adapted and displays the operational builder, tester, artifact-type, and capability values supported by this fork.

In v1, the included builders materialize identifiable files. A composite feature is represented by several artifacts. Whole directories, Maven/Gradle, OCI images, and AST transformations require future adapters before they can be declared supported.

## Source types shown in the interface

**Connect project** starts with a selector containing only these three sources:

| Option | Status | Form data |
|---|---|---|
| Remote Git repository | Available | HTTPS/SSH URL, branch/tag/commit, descriptor, and optional `credentialRef`. |
| Local Git repository | Available with operator authorization | Absolute path on the orchestrator host, branch/tag/commit, and descriptor. Requires `SPL_ALLOW_LOCAL_GIT_REPOSITORIES=true`. |
| Local folder without Git | Available with operator authorization | Absolute path, descriptor, and `content-digest-v1` snapshot. Requires `SPL_ALLOW_LOCAL_DIRECTORIES=true`. |

## Interface flow

1. Open or create a feature model and select **SPL Deployment**.
2. Select **Template and validator** if the repository does not yet contain the descriptor.
3. Download `spl.json`, adapt its IDs, names, and paths to artifacts that actually exist in the repository, and save it as `.variamos/spl.json`.
4. Load or paste the descriptor into the validator. The interface requires `ready` status and validates its JSON Schema, IDs and cross-references, builder–tester combinations, artifact types, and compatibility with authorized targets.
5. For Git, create a commit; for a folder without Git, make sure the descriptor and all its artifacts are ready. Isolated JSON validation does not claim that paths exist: the connection pins the commit or snapshot and obtains that evidence there.
6. Select **Connect project** and choose one of the three sources.
7. For remote Git, enter an ID, URL, ref, and descriptor. For local Git, enter the absolute path, ref, and descriptor. For the folder without Git, enter its absolute path and descriptor; the snapshot policy is `content-digest-v1`.
8. For a private remote source, use only an operator-managed `secret://...` reference. Never paste the credential value.
9. Validate. The preview shows the pinned commit or snapshot, descriptor, profile, and artifacts.
10. Import. VariaMos creates an empty mapping and records public IDs only.
11. Open **Configure bindings** and confirm the feature–artifact matrix.
12. Plan, review the digest and traceability, build and test, and then deploy.

A new local source is not selected through the browser's filesystem picker. The path belongs to the orchestrator host and is accepted only when the operator explicitly enables that access type.

## Decision change: explicit descriptor

**Date:** 2026-07-23.

| Topic | Record |
|---|---|
| Previous decision | A generator produced a feature-dependent draft with `artifactProposals` and pending questions. |
| Reason | The user still had to replace every proposal with real technical decisions; the flow could appear to perform inference that the system does not actually perform. |
| Considered alternative | Keep the generator and add more guided steps. This was rejected because it increased UI logic without providing evidence about paths, adapters, or associations. |
| Impact | The `/api/spl/v1/descriptors/draft` endpoint and its client were removed. The contract retains `draft` for compatibility, but the tool validates a `ready` descriptor. |
| New decision | Distribute a real, downloadable, versioned `spl.json` together with a validator and a visible reference of supported options. |
| Security and tests | The validator neither executes code nor accesses the repository. The later connection pins a commit, and the import verifies paths and calculates their hashes there. Contract and HTTP tests cover the template and semantic validation. |

## Persistence and security

- Connections, checkouts, snapshots, and imported catalogs are stored under `SPL_EXTERNAL_PROJECT_STATE`, outside the repository.
- The public endpoint hides the checkout, internal snapshot path, and `credentialRef`; external profiles publish only the commit or snapshot digest, descriptor digest, and IDs.
- A movable ref is pinned before preview. For a folder without Git, an ordered digest of the descriptor and declared artifacts is calculated. Saving requires the same values, preventing changes between validation and import.
- Git runs with separate arguments, disabled interactive prompts, a timeout, and size limits.
- Local reads reject absolute descriptor paths, `..` segments, files escaping the root through symbolic links, and files above the permitted limit.
- CORS and the listener remain limited to loopback. External deployments use generic targets from `contracts/resource-registry.local.json`.
- The plan digest covers the normalized catalog; the commit, paths, and hashes are part of that input.

## Operation

```bash
npm install
SPL_ALLOW_LOCAL_GIT_REPOSITORIES=true \
SPL_ALLOW_LOCAL_DIRECTORIES=true \
npm run start:spl
# in another terminal
npm start
```

To validate without the interface:

```bash
npm run validate:contracts
npm run test:contracts
npm run test:orchestrator
npm run test:e2e:external-project
```

The last command requires Docker. It creates the test project under `/tmp`, connects and imports it through HTTP, deploys to an ephemeral loopback port, and removes the container and temporary state when finished. The orchestrator tests cover both Git and folders without Git.

## Verified out of scope

Deployment over SSH, Kubernetes, OCI, microservices, arbitrary commands, semantic repository analysis, and MAPE-K are not declared as supported. Git is a provider; the currently verified architectural styles remain static sites and modular Node monoliths.
