# Source of truth for the VariaMos SPL project

- **Status:** current and canonical
- **Version:** 1.3
- **Cutoff date:** 2026-07-27
- **Decision participants:** Gustavo (`Gugasito`) and Professor Oscar
- **Evidence base:** follow-up conversation held from 2026-07-09 through 2026-07-23
- **Implementation repository:** `gugasito/VariaMosPLE`, a fork of `variamosple/VariaMosPLE`
- **Branch observed during consolidation:** `feature/dspl-artifact-binding`
- **Commit observed during consolidation:** `d5c2dfee7d396a33d565b78d6716f3645be845ac`

## 1. Authority and usage rules

This file is the single reference for deciding what is built, what may be claimed as supported, and what remains pending. From the cutoff date onward:

1. If another project document conflicts with this file, this file prevails.
2. Code and tests demonstrate implementation status, but do not expand the agreed academic scope by themselves.
3. Exploratory ideas do not become decisions until they are recorded here with **Accepted** status.
4. An accepted decision is neither deleted nor silently rewritten: it is marked **Superseded**, and its successor is added to the decision log.
5. Every field, contract, or element name intended for publication in VariaMos must be in English. Academic explanations are also maintained in English so the deployed tool and its project documentation remain consistent.
6. **SPL** is the current public and academic name. Historical `DSPL` identifiers are retained only for read compatibility and in this decision record; they must not appear as current names in the interface, new contracts, examples, or operational documentation.

Statuses used in this document:

- **Accepted:** an agreed decision that guides the work.
- **Implemented:** a capability that exists and can be verified in the fork.
- **Partial:** a technical foundation exists, but part of the agreed flow is missing.
- **Pending:** work or a decision remains unresolved.
- **Unsupported:** must not be promised or presented as a current capability.
- **Superseded:** a historical decision preserved for traceability.

## 2. Short project definition

The project extends VariaMos so a **Software Product Line (SPL)** can connect an external software project, explicitly associate its features with reusable artifacts, derive a reproducible variant, test it, and deploy it to a user-provided target.

The canonical chain is:

```text
feature model
  -> valid feature selection
  -> feature–artifact mapping
  -> versioned artifact catalog
  -> immutable derivation manifest
  -> builder
  -> tests
  -> external deployment target
  -> traceable release
```

VariaMos manages modeling, configuration, and operation requests. Product code lives in its own project or repository. An orchestration service executes providers, builders, tests, and deployers. The derived product is not hosted on the same server that runs VariaMos.

## 3. Accepted decisions

| ID | Accepted decision | Mandatory consequence |
|---|---|---|
| SPL-DEC-001 | Development starts from a fork of the official `variamosple/VariaMosPLE` repository. Sebastián's repository is an experimental reference, not the base to merge wholesale. | Changes must remain integrable with the official upstream. Sebastián's case is used for comparison and learning. |
| SPL-DEC-002 | The scope is called **SPL**, not DSPL. | Presentations, new documentation, the public UI, and future names must not promise runtime dynamic adaptation or a complete DSPL. |
| SPL-DEC-003 | The application-engineering model is grounded in the existing **feature–artifact mapping** concept. | It will not be presented as a model category invented from scratch. |
| SPL-DEC-004 | The adopted descriptive name is **Derivation and Deployment-Oriented Feature–Artifact Mapping Model**. | The name explains the operational specialization without claiming the mapping itself is a deployment topology. |
| SPL-DEC-005 | The feature model and feature–artifact mapping are separate but linked models. | The domain model must not contain repository paths, credentials, or artifact-specific details. |
| SPL-DEC-006 | The authoritative relationship is `feature -> binding -> artifact`. | One feature may require one or more artifacts and an artifact may be reused. Stable IDs resolve the association. |
| SPL-DEC-007 | The semantic feature–artifact association is explicit and must be confirmed by a person or declared in trusted metadata. | The system may automate imports, validation, and suggestions, but must not invent relationships by reading names or code. |
| SPL-DEC-008 | Every onboardable project must expose a versioned descriptor that acts as the technical index of its artifacts. | The descriptor declares IDs, types, versions, relative paths, dependencies, required capabilities, and compatible build profiles. |
| SPL-DEC-009 | A repository does not need a universal architecture or folder structure. | It may be organized freely as long as its artifacts are described by safe relative paths in a valid descriptor. |
| SPL-DEC-010 | Repository location is defined in a technical connection outside the variability model. | Git uses `repositoryUrl`, `requestedRef`, and `descriptorPath`; a private source may add `credentialRef`. |
| SPL-DEC-011 | A requested branch or tag is resolved to a concrete commit before derivation. | The manifest and artifacts must be reproducible; later branch changes do not alter an already planned derivation. |
| SPL-DEC-012 | Git is a provider, not a mandatory conceptual dependency. | The architecture must allow additional providers. Local, HTTP, package, and container-image sources must not be simulated as fully supported. |
| SPL-DEC-013 | The core is independent of architectural style. | Architecture selection is materialized through artifacts, profiles, builders, dependencies, capabilities, and deployers. |
| SPL-DEC-014 | Support must be demonstrated, not inferred from the schema. | An architecture can be declared supported only when it has an adapter, an example, tests, and end-to-end evidence. |
| SPL-DEC-015 | The first target styles are static sites/frontends and monoliths or modular monoliths. | Microservices and micro-frontends remain prepared extensions, but unsupported until fully validated. |
| SPL-DEC-016 | Every derivation first generates a validated, immutable manifest. | The manifest records configuration, bindings, artifacts, versions, integrity, builder, tests, and target before execution. |
| SPL-DEC-017 | Deployment does not run on the server hosting VariaMos. | Each user must provide or select an authorized external target to avoid overloading and compromising the tool server. |
| SPL-DEC-018 | VariaMos does not store secrets in the feature model, mapping, descriptor, catalog, manifest, URL, build, job, target, API response, browser storage, or logs. | Private source credentials use an opaque `credentialRef`; SSH deployment passwords use an in-memory lease for one attempt and are discarded. |
| SPL-DEC-019 | VariaMos distributes a downloadable template with real values and a descriptor validator; it does not generate the descriptor from the feature model. | Onboarding must make technical decisions explicit, explain every supported option, and avoid implying that the system infers paths or associations. |
| SPL-DEC-020 | Publishable fields are named in English. | Canonical examples include `schemaVersion`, `project`, `artifacts`, `profiles`, `builderAdapter`, `requiredTargetCapabilities`, `repositoryUrl`, `requestedRef`, `descriptorPath`, and `credentialRef`. |
| SPL-DEC-021 | All public terminology and every new identifier in this extension use **SPL**. | The canonical path is `.variamos/spl.json`; the language is `SPL Deployment Mapping v1`; its schema is `spl-deployment-mapping/v1`; the API uses `/api/spl/v1`; configuration, scripts, and operational resources use the `SPL` prefix. Previous DSPL values are accepted only when reading existing projects. |
| SPL-DEC-022 | The first supported remote target is an SSH server with Docker Compose already installed. | `ssh-compose-v1` validates allowlists, the SSH host fingerprint, a restricted folder, pinned images, health checks, and rollback. Other platforms remain future adapters and are not advertised as supported. |
| SPL-DEC-023 | SSH deployment targets authenticate only with a username and a fresh password for validation and every deploy. | The target stores the username only. Managed deployment keys, AWS/Keychain fields, and deployment credential bindings are absent from the target UI and rejected by current contracts/APIs. Private Git authentication remains separate. |

## 4. Canonical contracts and boundaries

### 4.1. Git source connection

| Field | Responsibility |
|---|---|
| `repositoryUrl` | The repository's HTTPS/SSH URL, or a local Git path only when authorized by the operator. It contains no token, username, or password. |
| `requestedRef` | A branch, tag, or commit requested by the user. It must resolve to an immutable commit. |
| `descriptorPath` | A safe relative path to the descriptor inside the repository. The canonical value is `.variamos/spl.json`. |
| `credentialRef` | An optional opaque reference to an externally managed credential; it is never the credential itself. |

The connection supplies location, revision, and operational authorization. The descriptor supplies the portable project description. The mapping supplies the decision about which artifacts implement each feature. These three responsibilities must remain separate.

### 4.2. Project descriptor

The implemented contract is `variamos-project/v1`, validated through JSON Schema. Its public content uses English fields. A ready descriptor:

- identifies the project;
- lists artifacts with an ID, type, version, and relative path;
- may declare integrity, dependencies, and capabilities;
- declares compatible profiles and adapters;
- contains no absolute host paths, private targets, or secrets;
- does not automatically decide which feature uses each artifact.

The repository may keep the descriptor at any path specified by `descriptorPath`. The default and recommended path is `.variamos/spl.json`. A saved connection may continue to read the historical `.variamos/dspl.json` path when explicitly configured, but the interface neither proposes nor generates it.

### 4.3. Mapping

The separate mapping contains confirmed correspondences between features and artifacts. Conceptually:

```text
FeatureBinding
  sourceFeatureId -> stable feature in the feature model
  artifactRef     -> stable artifact in the catalog
  effect          -> deterministic operation required by the selection
```

Boolean conditions over several features are a valid extension of the concept described in the literature. The initial implementation may work with individual selections, but must not claim that this limitation defines the general concept.

### 4.4. Deployment

The expected flow is:

```text
user selects target
  -> VariaMos sends targetRef and an authorized request
  -> owner enters the SSH password for this attempt
  -> orchestrator creates an in-memory credential lease
  -> deployer publishes outside the VariaMos server
  -> verifier checks the result
  -> VariaMos displays status and evidence; it does not host the product
```

The first protocol is SSH/Compose and project authorization comes from the
existing VariaMos session/project services. Only the owner manages targets and
deploys. Secret managers are reserved for private Git sources; they are not a
deployment-target setting.

## 5. Implementation status on 2026-08-07

| Capability | Status | Evidence or boundary |
|---|---|---|
| Integration into the official fork and the normal VariaMos flow | **Implemented** | Branch `feature/dspl-artifact-binding`, observed commit `d5c2dfee…`. |
| `variamos-project/v1` contract and JSON Schema | **Implemented** | `contracts/schemas/variamos-project.schema.json`. |
| Default `.variamos/spl.json` descriptor | **Implemented** | It is the canonical technical index; historical paths remain compatible inputs only. |
| Explicit catalog and bindings | **Implemented** | Associations are not inferred from code. |
| HTTPS/SSH Git and authorized local Git connections | **Implemented** | Branch/tag is pinned to a commit; local paths remain disabled unless explicitly authorized. |
| Source selector in the UI | **Implemented** | Exposes only remote Git, local Git, and local folder without Git; each source changes the form and creates real connections when allowed by policy. |
| Derivation manifest | **Implemented** | The pipeline produces a versioned manifest before building. |
| Static site with local Docker/Nginx | **Implemented and validated** | Demonstrator plus local end-to-end tests. |
| Monolith or modular monolith | **Implemented in adapters, fixture, and local tests** | This does not equal remote deployment or universal monolith support. |
| Descriptor template and validator | **Implemented** | `public/templates/spl.json` reproduces an executable example; the UI downloads, loads, pastes, and validates a `ready` descriptor and shows current options for each field. |
| Private-source credentials through `credentialRef` | **Implemented in broker and contracts** | Git HTTPS tokens and Git SSH keys remain outside models; provider lifecycle and log redaction are covered independently from deployment. |
| Local non-Git provider | **Implemented** | Validates the root and descriptor, pins a digest snapshot, detects changes between preview and save, and imports through the local provider. Requires operator authorization. |
| HTTP, package, and container-image providers | **Outside the current selector** | They remain possible architectural extensions but no longer appear as connection options. |
| Deployment to an SSH/Compose server | **Implemented; manual password-only rerun pending** | Target assistant, owner authorization, one-time password lease, async job, verification, cancellation and rollback are implemented and covered by automated tests. Earlier loopback E2E evidence predates the password-only UI and must be repeated before final production sign-off. |
| Microservices and micro-frontends | **Unsupported** | The design aims for extensibility, but adapters, cases, tests, and E2E evidence are missing. |
| MAPE-K dynamic adaptation | **Outside the committed current scope** | It must not be used to present the scope as a DSPL. |

## 6. Current terminology and compatibility

| Usage | Current name |
|---|---|
| Product-line type | **Software Product Line (SPL)** |
| Correspondence model | **Derivation and Deployment-Oriented Feature–Artifact Mapping Model** |
| Literature concept | **Feature–Artifact Mapping** and **Configuration Knowledge** |
| Portable project contract | `variamos-project/v1` |
| Manifest | `spl-deployment-manifest/v1` |
| Default descriptor | `.variamos/spl.json` |
| Mapping language | `SPL Deployment Mapping v1` |
| Mapping schema | `spl-deployment-mapping/v1` |
| HTTP base | `/api/spl/v1` |
| Operational configuration | `SPL_` and `REACT_APP_SPL_` prefixes |
| Contract fields | English |

Read compatibility for projects created before this decision:

- `DSPL Deployment Mapping v1`;
- `dspl-deployment-mapping/v1`;
- an explicit `descriptorPath` such as `.variamos/dspl.json`.

The application generates and displays SPL names exclusively. When a historical mapping is confirmed again, it is normalized to the canonical name and schema. Compatibility does not authorize creating new resources with DSPL terminology.

## 7. Next work, in priority order

1. Repeat and record the manual loopback/external-server E2E with the final password-only target assistant.
2. Validate production HTTPS, identity/project services, SSH/health allowlists and centralized audit output in the deployment environment.
3. Run and record evidence for both local Git and a real remote private Git repository, including its separate credential lifecycle.
4. Validate the flow with a more realistic project and record reproducible evidence.
5. Run and record evidence for the manual laboratory with a local folder without Git.
6. Evaluate HTTP, package, and container-image providers separately only if a priority use case appears.
7. Expand the supported architecture matrix only after end-to-end tests.

## 8. Open questions that must not be decided accidentally

| ID | Open question | Closure criterion |
|---|---|---|
| SPL-OPEN-005 | What level of Boolean expressiveness will the next mapping version provide? | It must be justified by real cases and preserve deterministic evaluation. |

`SPL-OPEN-001` is closed by `SPL-DEC-022`. `SPL-OPEN-002` is split and closed
for the current scope by `SPL-DEC-018` and `SPL-DEC-023`: private Git uses a
credential provider; deployment uses a non-persisted password. `SPL-OPEN-003`
and `SPL-OPEN-004` were closed by `SPL-DEC-021`.

## 9. Recorded academic foundation

The justification accepted by the professor is based on two references:

1. Nieke et al., [*Guiding the evolution of product-line configurations*](https://link.springer.com/article/10.1007/s10270-021-00906-w), formalizes a **feature–artifact mapping** that evaluates conditions over features to select reusable artifacts.
2. Heidenreich, Kopcsek, and Wende, [*FeatureMapper: Mapping Features to Models*](https://featuremapper.org/files/ICSE08-FeatureMapper--Mapping-Features-to-Models.pdf), supports maintaining a separate mapping model connected to the feature model and solution models.

Canonical wording for reports and presentations:

> The proposal is grounded in the feature–artifact mapping concept used in product-line engineering to relate problem-space decisions to reusable solution-space artifacts. In VariaMos, this concept is specialized to participate in a traceable derivation, testing, and deployment chain. The mapping remains separate from the feature model, uses explicit bindings and stable IDs, and produces a verifiable manifest for a valid configuration. The proposal does not claim to create a new general model category or to represent a deployment topology by itself.

## 10. Chronological decision evidence

| Date | Evidence summary | Related decisions |
|---|---|---|
| 2026-07-09 | The professor asks to review Sebastián's language, automate linking, clarify repositories, support more than one architecture, and compare with the official upstream. | SPL-DEC-001, 006, 007, 009, 013. |
| 2026-07-10 | Catalog, bindings, manifest, interchangeable providers, and initial support for static sites and monoliths are proposed. | SPL-DEC-006 through 016. |
| 2026-07-21 | The professor approves the proposed direction and requests demonstrable progress. | Approach ratification. |
| 2026-07-22 | Integration into the fork, a validated descriptor, Git pinned to a commit, a manifest, a static site, and an assisted generator are reported. | Implementation status. |
| 2026-07-22 | The professor clarifies that deployment must not occur on the VariaMos server; each user provides a target and a secure credential strategy is required. The professor also requests a foundation for the model name. | SPL-DEC-017, 018, and 003. |
| 2026-07-22/23 | `repositoryUrl`, `requestedRef`, `descriptorPath`, and the descriptor as an index without a mandatory architectural structure are clarified. | SPL-DEC-008 through 011. |
| 2026-07-23 | The model is justified through feature–artifact mapping and separate mappings; the professor accepts the justification. | SPL-DEC-003, 004, and 005. |
| 2026-07-23 | The professor requests a downloadable template, instructs the project not to commit to DSPL, and requires English fields. | SPL-DEC-002, 019, and 020. |
| 2026-07-23 | The assisted generator is replaced with a real downloadable descriptor, an importability validator, and a visible reference of current fields and options. | Implementation of SPL-DEC-019. |
| 2026-07-27 | The remaining terminology is closed and SPL is required for buttons, descriptor, language, API, and operational documentation. | SPL-DEC-021. |
| 2026-08-07 | SSH/Compose is fixed as the first remote adapter and deployment authentication is simplified to a fresh username/password flow with no managed deployment-key UI or binding. | SPL-DEC-022 and 023. |

## 11. How to record a new decision

Add a row to the end of this table and update only the affected sections:

| Change | Date | Decision | Reason/evidence | Impact | Owner |
|---|---|---|---|---|---|
| SOT-001 | 2026-07-23 | This source of truth is created with 20 accepted decisions. | Consolidation requested from the professor–student conversation. | Earlier documents become context, and conflicts are resolved here. | Gustavo |
| SOT-002 | 2026-07-23 | Implementation of `SPL-DEC-019` is recorded. | The UI, contract, and orchestrator replace the generator with a real template, field reference, and importability validator. | The draft endpoint is removed; tests cover downloads, errors, compatibility, imports, and Docker E2E. | Gustavo |
| SOT-007 | 2026-08-07 | The first remote target and its password-only authentication boundary are recorded. | Production preparation required removing managed deployment-key and Mac-specific target configuration. | Target contracts, adapter metadata, UI, runtime checks, tests and operations documentation now agree. | Gustavo |
| SOT-003 | 2026-07-25 | An explicit project-source selector is recorded. | Remote and local Git needed to be distinguished while making planned evolution visible without confusing a roadmap with support. | The UI changes its form by source; the orchestrator publishes availability; four future providers were marked `development`. | Gustavo |
| SOT-004 | 2026-07-27 | The selector is limited to remote Git, local Git, and local folder without Git; the third source becomes operational through digest snapshots. | The interface was intentionally focused on the three relevant connection methods and removed future options with no immediate use. | HTTP, package, and OCI options are removed from the visible catalog; validation, persistence, import, and tests are added for the local non-Git provider. | Gustavo |
| SOT-005 | 2026-07-27 | The public DSPL-to-SPL migration is completed. | The professor limited the academic commitment to an SPL and requested the removal of DSPL from current names. | `.variamos/spl.json`, `SPL Deployment Mapping v1`, `spl-deployment-mapping/v1`, `/api/spl/v1`, variables, and the SPL UI become canonical; previous names remain read-compatible only. | Gustavo |
| SOT-006 | 2026-07-27 | The SPL onboarding and deployment surface is standardized in English. | The deployed tool will operate in English. | Buttons, forms, validation and runtime messages, downloadable templates, examples, tests, and operational documentation use English. | Gustavo |

To supersede a decision:

1. Keep its ID and change its status to **Superseded by `SPL-DEC-XXX`**.
2. Create the new decision with a new ID.
3. Record the date, participants, evidence, reason, and impact.
4. Update scope, implementation, pending work, and affected documentation.
5. Do not declare the change complete until code, tests, and documents are aligned.
