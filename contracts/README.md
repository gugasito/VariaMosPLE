# SPL contracts

These contracts implement the first part of the master baseline: separating the variability model from the technical details needed to derive and deploy a product.

```text
Selected feature
  -> declarative binding
  -> versioned catalog artifact
  -> validated manifest
  -> builder/deployer with an explicit adapter
```

## Contents

- `schemas/`: JSON Schema Draft 2020-12 definitions for artifacts, catalogs, bindings, configurations, targets, manifests, and the external `variamos-project/v1` descriptor.
- `examples/event-portal/`: an isolated regression fixture with a feature model, two mappings, three configurations, a catalog, targets, a local registry, and verifiable hashes.
- `languages/spl-deployment-mapping-v1/`: the versioned bundle of the private language that models the technical realization of a feature without replacing the public feature language.
- `examples/invalid/`: fixtures that must fail validation.
- `examples/variamos-project/`: a ready descriptor, a valid draft, and unsafe cases that must fail.
- `scripts/validate-contracts.cjs`: schema and cross-reference validation.
- `tests/contracts.test.cjs`: automated contract tests.

## Commands

From the repository root:

```bash
npm run validate:contracts
npm run test:contracts
```

## Scope of this iteration

The contracts do not download, build, or deploy software by themselves. They establish which information must exist before an orchestrator resolver or adapter can do so reproducibly. The local `nginx-container-v1` adapter consumes the validated manifest, but its runtime records are operational state and are not part of the configuration contract.

The catalog also declares `derivation.builderAdapter` and, optionally, `derivation.testAdapter`. The resolver can therefore produce a build and test plan without inferring those adapters from a filename or URL.

The Event Portal fixture uses only project-owned assets and verifies two profiles: static site and modular monolith. Contract validation checks its schemas, IDs, model–mapping relationships, confined paths, and every asset's SHA-256 before the orchestrator can use it. It is not installed as a project or user when the normal application runs.

The VariaMos visual `ImplementedBy` relationship is preserved during migration, but it is interpreted as a reference to a binding or an `artifact_ref`, never as a direct production URL.

`variamos-project/v1` separates the repository from its operational connection. The descriptor declares relative paths, artifacts, and authorized adapters; the orchestrator supplies the provider, resolved commit, checkout, target, and `credentialRef`. The contract retains `draft` for incomplete documents and `ready` for imports. The UI no longer generates drafts: it distributes `public/templates/spl.json` with real values and verifies that the adapted descriptor is `ready`, consistent, and uses authorized operational combinations.
