# SPL Deployment Mapping v1

This language complements, but does not replace, the VariaMos feature language. A model in this language is linked to a feature model through `sourceModelIds` and expresses only its technical realization: bindings, catalog references, and the target.

`language.json` is the distribution manifest. To create the language in VariaMos, load the contents of `abstract-syntax.json`, `concrete-syntax.json`, and `semantics.json` in the language editor. It must be an **Application** language and remain private while it is being validated.

When creating the mapping model, register the feature model ID under **Source model IDs**. The orchestrator requires exactly one source ID, and the fixtures in `contracts/examples/event-portal/models/` show the expected serialized structure. Export the remote definition and compare it with these files before requesting publication.

## What actually links a feature to an artifact

The text displayed inside a `SoftwareArtifact` box is **not** the link by itself: it is the readable label of a technical reference. Traceability is formed by these four pieces of data, which the assistant generates and the user confirms in the matrix:

1. The mapping declares a single `sourceModelIds` entry: the source feature model ID.
2. Each `FeatureBinding` box stores `source_feature_id`, the exact ID of a feature in that model, plus a stable `feature_ref` for reports.
3. Each `SoftwareArtifact` box stores `artifact_ref`, the exact ID of an entry in the profile's authorized catalog. The catalog—not the name displayed in the diagram—describes the artifact the builder can materialize.
4. The `ImplementedBy` arrow from `FeatureBinding` to `SoftwareArtifact` is the confirmed semantic association: “this feature is implemented by this artifact or these artifacts.”

A feature can therefore have several artifacts—for example, UI, API, migration, and test—and an artifact can participate in more than one feature when the responsible person confirms it. During `Plan`, the orchestrator follows `selected feature → FeatureBinding → ImplementedBy → artifact_ref → catalog`; it does not guess from names or inspect source-code lines.

## Verified private installation

On 2026-07-18, a private installation with this name was created in `app.variamos.com` as an **Application** language, with **Pending** status and owned by the practice account. It is neither shared nor published.

The remote installation is a **projection** of this folder's contents; it is not the project's source of truth. Every change is made here first, reviewed and tested in the local fork, and only then explicitly replicated in VariaMos. If the platform allows a complete definition to be exported, it will be kept as comparison evidence, never as a replacement for the versioned source files.
