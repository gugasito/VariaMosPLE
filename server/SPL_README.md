# SPL Orchestrator — execution adapters v1

This service is the boundary between VariaMos and technical execution. The resolver transforms a valid configuration into a reproducible manifest. Downstream adapters materialize the product and enable a local, bounded, and traceable deployment.

## Input

The resolver receives:

```text
catalog + bindings + configuration + target + sourceModel
```

It validates the shared JSON Schemas, checks cross-references, resolves `include` artifacts, expands dependencies, verifies target capabilities, and generates a v1 manifest.

## Deliberate v1 boundary

Only the `include` binding action is supported. The `generate`, `configure`, `test`, `publish`, `deploy`, `migrate`, and `observe` actions belong to the contract, but the resolver currently rejects them to avoid promising semantics that do not yet exist.

The resolver only generates a **plan**: it does not execute the included steps itself. The implemented adapters consume the manifest explicitly and refuse to act if the plan does not declare their expected adapter.

## Commands from the repository root

```bash
npm run build:server
npm run test:spl
```

## Providers and static builder

Providers retrieve artifact bytes; they do not decide features or deploy software.

- `GitArtifactProvider` uses a previously registered local checkout and reads `git show <commit>:<path>`. It verifies that the `origin` remote matches the declared source and never switches branches or commits.
- `LocalArtifactProvider` reads only below registered local roots and rejects absolute paths or paths containing `..`.
- `StaticSiteBuilder` accepts only `html-fragment`, calculates the SHA-256 of each item, compares catalog and manifest, and atomically generates `index.html` plus `build-metadata.json`.

## Local Nginx deployer

`NginxContainerDeployer` implements `nginx-container-v1` for the static case. It is a laboratory adapter, not a production mechanism or SSH client.

- It requires `deploy: nginx-container-v1`, `verify: http-health-check-v1`, and `previous-successful-release` rollback in the manifest.
- It verifies that `index.html` and `build-metadata.json` match the manifest exactly and creates its own per-release snapshot before mounting files, so a later build cannot alter an earlier release.
- It publishes only on `127.0.0.1` and rejects remote hosts, SSH, secrets, and privileged ports.
- It creates an Nginx container with a read-only filesystem and explicit temporary directories.
- It verifies HTTP plus the `data-manifest-id` marker to confirm that the correct product is responding.
- It records every release under an external state directory, including its manifest, resolved Docker image, `index.html` digest, endpoint, and previous release.
- It is idempotent: invoking the same active manifest and port only reruns the health check.
- If a candidate fails, it removes the candidate and restores the previous release; it also exposes explicit rollback.

Docker Desktop—or an equivalent Docker daemon—must be running to deploy. The default image is `nginx:1.27-alpine`; the release record stores the image ID actually used. For a non-local environment, the target policy must pin an image by digest and replace this adapter with one authorized for that environment.

## HTTP boundary for the UI

The VariaMosPLE backend lets the UI request a derivation without receiving access to Docker, Git, SSH, or secrets:

```bash
npm start
```

It listens on `127.0.0.1:3000` by default and exposes:

```text
GET  /health
GET  /api/spl/v1/providers
GET  /api/spl/v1/profiles
POST /api/spl/v1/connections/validate
POST /api/spl/v1/connections
GET  /api/spl/v1/connections/{id}
POST /api/spl/v1/connections/{id}/descriptor/validate
POST /api/spl/v1/imports
GET  /api/spl/v1/imports/{id}
POST /api/spl/v1/descriptors/validate
POST /api/spl/v1/derivations
```

There is no disabled authentication mode. Except for health checks and public
adapter/descriptor definitions, requests are authorized against the current
VariaMos session and the role stored by the project service. Missing or expired
tokens and unavailable identity/project services fail closed. `owner`,
`editor`, and `viewer` are never read from request bodies, mappings, or
descriptors.

### External projects

Onboarding keeps persistent state outside version control—under `.runtime/spl` by default. For Git, it uses managed checkouts that never alter the development checkout: a branch or tag is resolved to a commit before `.variamos/spl.json` is read. For a folder without Git, it copies the descriptor and declared artifacts to a managed snapshot identified by SHA-256. Both paths produce an immutable catalog consumed by the existing pipeline.

`GET /api/spl/v1/providers` publishes only the catalog used by the **Source type** selector: remote Git and **Upload project folder**. Folder upload is available only when the operator enables `SPL_FOLDER_UPLOAD_ENABLED=true`.

The UI distributes `public/templates/spl.json` and uses `POST /api/spl/v1/descriptors/validate` as a checker before connecting. The endpoint optionally requires `requireReady`; beyond JSON Schema validation, it checks IDs and cross-references, builder–tester combinations, the types each builder can process, and the existence of an authorized target with all declared capabilities. Draft generation from features was removed: the system does not infer technical decisions from a repository.

HTTPS and SSH repositories are enabled. The backend does not accept local Git paths or local directories. Browser uploads contain only `.variamos/spl.json` and its declared artifacts, are validated for unsafe paths and sensitive names, and expire after the configured TTL. Remote Git checkouts are operation-scoped and removed when the operation finishes. A private repository must use a `credentialRef` plus a Git/SSH credential mechanism managed by the operator; the credential itself neither crosses the API nor persists in the model.

### Native SPL flow: feature model + mapping model

The current route receives a feature model and a second `SPL Deployment Mapping v1` model:

```text
featureModel.Selected
  + mappingModel.sourceModelIds[0]
  + FeatureBinding.source_feature_id / feature_ref
  + SoftwareArtifact.artifact_ref
  + ImplementedBy
  -> product-configuration/v1 + feature-artifact-bindings/v1
  -> manifest + authorized builder/test/deployer
```

The mapping must declare exactly one source feature model, one `DeploymentMapping`, and stable catalog and target references. `SplMappingModelAdapter` rejects duplicate bindings, selected features without an implementation, missing artifacts, and references outside the registry. The UI can therefore remain generic and contains no Event Portal domain rules.

The action can be `plan`, `build`, or `deploy`. In the native flow, `build` and `deploy` require the `expectedPlanDigest` returned by `plan`; if either model changes, the server rejects the stale execution. The server computes a deterministic `configurationId`, adapts the model, resolves the manifest, and only builds or deploys when appropriate.

The default local configuration is [contracts/resource-registry.local.json](../../contracts/resource-registry.local.json). It registers no demonstration projects; it authorizes only generic targets for imported projects (static on `:8092` and Node on `:8093`). Catalogs and profiles appear after an external descriptor has been validated and imported.

The endpoint enforces a maximum JSON body size of 1 MiB and CORS for configured local origins. The operations guide is [DERIVATION_DEPLOYMENT_BUTTON.md](../../docs/spl/DERIVATION_DEPLOYMENT_BUTTON.md); the versioned custom-language bundle is [contracts/languages/spl-deployment-mapping-v1](../../contracts/languages/spl-deployment-mapping-v1/README.md).

## Secure remote targets

The optional `ssh-compose-v1` adapter adds personal targets reusable in projects the owner can deploy to, one-time SSH
password authentication, immutable build records and asynchronous deployment
jobs. It is feature-flagged off by default and cannot start without VariaMos
authentication, all host allowlists and an audit sink. Targets persist only the
SSH username; validation and every deployment require a password that is never
stored. Use `SPL_SECRET_BACKEND=none` unless private Git sources need a separate
credential provider.

The API publishes adapter definitions at `GET /api/spl/v1/target-adapters`.
Target routes live below `/api/spl/v1/projects/{projectId}`; jobs use
`/api/spl/v1/deployments`. Credential-binding routes are reserved for private
Git source connections. Responses omit provider identifiers, secret values,
remote filesystem paths and local state paths.

The server setup and security model are documented in
[Secure remote deployment](../../docs/spl/SECURE_REMOTE_DEPLOYMENT.md).

## Determinism rules

- Selected features are sorted by ID.
- Artifacts are sorted topologically and deterministically.
- The manifest ID derives from the product and configuration.
- Dates, global state, the network, and runtime information are not used.
- Identical input generates the same manifest.

## Validation

```bash
npm run validate:contracts
npm run test:contracts
npm run test:orchestrator
npm run test:event-portal
npm run test:e2e:external-project # independent Git repository + Docker on an ephemeral port
```

`test:event-portal` preserves an isolated regression test for both builders without installing a project in the application. `test:e2e:external-project` creates an independent Git repository and verifies connection → import → plan → build → test → deploy.
