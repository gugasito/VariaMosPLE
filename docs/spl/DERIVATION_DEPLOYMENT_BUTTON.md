# SPL derivation and deployment panel

**Status:** implemented for the normal SPL project flow. The panel replaces the previous experimental button.

## What appears in VariaMos

The [SplDerivationPanel.tsx](../../src/UI/WorkSpace/SplDerivationPanel.tsx) component opens as a drawer from the right edge. When closed, the **SPL Deployment** button remains available to reopen it, preserving the flow on small screens. It appears when the current selection is:

- a feature model with at least one associated `SPL Deployment Mapping v1` model; or
- the mapping associated with a feature model.

The association does not depend on the displayed name: the mapping declares exactly one identifier in `sourceModelIds`. For `SPL Deployment Mapping v1` models, the editor displays the **Source feature model** selector instead of requiring a manually entered ID. The orchestrator validates this link before producing a plan.

The panel never reads code, executes Docker, or receives secrets. It sends a serialized representation of both models to a loopback orchestrator that uses only previously authorized catalogs and targets.

```text
Feature model (Selected decisions)
  + Mapping model (FeatureBinding -> SoftwareArtifact)
  -> local POST to the orchestrator
  -> deterministic configuration + bindings
  -> immutable manifest
  -> profile builder and tests
  -> local deployer, when requested
```

## Panel actions

1. **Plan:** validates features, bindings, catalog, target, and capabilities. It neither writes nor executes anything and returns a `planDigest`.
2. **Build and test:** requires the digest from that plan. It materializes hash-verified artifacts and runs the profile tests.
3. **Deploy:** validates the same digest again and creates or updates a local Docker release.

The actions remain separate because a release can be valid and tested before publication is authorized. This supports test review, manifest approval, and failure diagnosis before changing a target.

If selections or the mapping change between the plan and later actions, the digest no longer matches and the server responds with `409`; the user must plan again. The optional saved configuration reference is a human trace: the serialized feature model remains the actual source of decisions. After a successful deploy, **Open deployed product** remains visible in the bar for the session, even after replanning.

## Required languages and models

No special feature is added to VariaMos code. The system uses two modeling layers:

| Layer | Language | Responsibility |
|---|---|---|
| Variability | Public `Feature model with attributes` | Features and their `Selected` property. |
| Technical realization | Private `SPL Deployment Mapping v1` | Catalog, target, bindings, and versioned artifacts. |

The installable specification of the second language is in [contracts/languages/spl-deployment-mapping-v1](../../contracts/languages/spl-deployment-mapping-v1/README.md). Its elements are:

- `DeploymentMapping`: one per profile, with `mapping_ref`, `catalog_ref`, and `target_ref`.
- `FeatureBinding`: links a source feature (`source_feature_id`) to its stable ID (`feature_ref`).
- `SoftwareArtifact`: references a technical artifact through `artifact_ref`.
- `ImplementedBy`: connects a binding to one or more artifacts. A feature can therefore include UI, API, schema, and tests without assuming that it is a single file.

### Source of truth: local first, VariaMos second

`app.variamos.com` is an already deployed VariaMos installation. Creating a private language there stores **account modeling data**, but neither changes nor deploys platform code. Development for this project occurs exclusively in the local fork:

| Resource | Canonical source | Role of VariaMos.com |
|---|---|---|
| Language definition | `contracts/languages/spl-deployment-mapping-v1/` | Private installation that must match the local bundle. |
| Regression fixtures | `contracts/examples/event-portal/` and `examples/event-portal/` | Not installed in the account or used as the working project. |
| Orchestrator and panel | `services/spl-orchestrator/` and `src/UI/WorkSpace/` | Tested only by running the frontend from the local fork. |

The newly created language is therefore not “moved” from the cloud to the repository: it was already created from the local bundle. The correct change direction is **repository → review/tests → private installation**. A future remote export will be kept only as evidence to detect drift.

## Current HTTP contract

`POST /api/spl/v1/derivations`

```json
{
  "action": "plan",
  "projectId": "project.event-portal",
  "productLineId": "event-portal",
  "featureModel": { "id": "...", "elements": [], "relationships": [] },
  "mappingModel": { "id": "...", "sourceModelIds": ["..."], "elements": [], "relationships": [] }
}
```

For `build` and `deploy`, add the `expectedPlanDigest` received from the plan. The response does not return host paths, credentials, commands, or secret contents. `GET /health` checks orchestrator availability; `GET /api/spl/v1/catalogs/<catalog-id>` exposes only a summary of registered catalogs.

`GET /api/spl/v1/profiles` gives the assistant only the profile ID and name, its mapping/catalog/target references, adapters, and the public `{ id, kind, version }` artifact inventory. It never exposes paths, ports, internal hashes, code, or credentials.

## Binding assistant

The **Configure bindings** button opens a modal inside the drawer. The assistant:

1. requests authorized profiles from the local orchestrator;
2. generates a mapping under *Application engineering*, with one binding per configurable feature and the catalog artifacts;
3. sets `sourceModelIds` to the chosen feature model;
4. presents a feature × artifact matrix and creates the confirmed `ImplementedBy` relationships.

The automation creates the structure and preserves stable IDs; it does not guess semantics from filenames or source-code lines. A person declares which artifacts implement each feature. One feature can have several artifacts, such as UI, API, schema, and tests.

## Local execution

```bash
# Terminal 1
npm run start:spl

# Terminal 2
npm start
```

The UI uses `REACT_APP_SPL_ORCHESTRATOR_URL=http://127.0.0.1:8090`. If an older process was already using that port, restart it to load this code. The local environment publishes nothing to the Internet: targets accept only `127.0.0.1`.

To verify the chain without operating the UI:

```bash
npm run validate:contracts
npm run test:orchestrator
npm run test:e2e:event-portal
```

The last command requires Docker and only creates or updates test releases outside the repository.

## Verified architectures and limits

| Profile | Builder | Target | Local URL | Status |
|---|---|---|---|---|
| Static site | `static-site-v1` | `nginx-container-v1` | `http://127.0.0.1:8089/` | verified |
| Node/TypeScript modular monolith | `node-modular-monolith-v1` | `node-container-v1` | `http://127.0.0.1:8091/` | verified |

Microservices, Kubernetes, SSH, remote deployment, and production MAPE-K are not declared as supported. The contract allows future profiles through a new catalog, builder, deployer, tests, and evidence—not through arbitrary rules inside a model.
