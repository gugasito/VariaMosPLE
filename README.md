# VariaMosPLE

## Project decisions

The canonical scope, terminology, support claims, implementation status, and open decisions for the SPL work are recorded in [Project Source of Truth](docs/spl/PROJECT_SOURCE_OF_TRUTH.md). New work must follow that document. `SPL` is the current public and academic name; previous identifiers are accepted only when reading existing projects.

## Install

```bash
npm install
```

## Run

The application and orchestrator are separate processes. SPL functionality is part of the normal build and uses standard VariaMos authentication; it installs neither users nor demonstration projects.

```bash
# terminal 1: local SPL API
npm run start:spl

# terminal 2: normal VariaMos application
npm start
```

Open `http://localhost:3000` (not `127.0.0.1`). If port 3000 is occupied, the command exits with an explicit message to prevent accidentally opening another instance on 3001. The sign-in page belongs to VariaMos and returns to localhost with a temporary token; that token is immediately removed from the URL and must not be copied into models or descriptors.

When a feature model is open, the **SPL Deployment** bar lets the user download a real `.variamos/spl.json` template, validate the adapted file, and choose among three sources: remote Git, authorized local Git, and an authorized local folder without Git. Both Git sources pin a commit; the non-Git folder creates an immutable digest snapshot. After connecting, the flow imports artifacts, confirms bindings, plans, builds, and deploys. The validator shows supported values and compatibility rules; it does not generate technical decisions from features. The canonical `SPL Deployment Mapping v1` language is bundled with the frontend; Event Portal projects remain optional fixtures.

See [External project onboarding](docs/spl/EXTERNAL_PROJECT_ONBOARDING.md) for the contract, security model, API, execution, and E2E test.
