# VariaMosPLE

## Project decisions

The canonical scope, terminology, support claims, implementation status, and open decisions for the SPL work are recorded in [Project Source of Truth](docs/spl/PROJECT_SOURCE_OF_TRUTH.md). New work must follow that document. `SPL` is the current public and academic name; previous identifiers are accepted only when reading existing projects.

## Install

```bash
npm install
```

## Run

SPL functionality is built into the VariaMosPLE backend. One command builds the React client and Node server, then serves both from port 3000. It uses standard VariaMos authentication and installs neither users nor demonstration projects.

```bash
npm start
```

Open `http://localhost:3000` (not `127.0.0.1`). If port 3000 is occupied, the command exits with an explicit message to prevent accidentally opening another instance on 3001. The sign-in page belongs to VariaMos and returns to localhost with a temporary token; that token is immediately removed from the URL and must not be copied into models or descriptors.

The VariaMos backend has no unauthenticated SPL runtime mode. It refuses to start
unless it knows the VariaMos session and project-permission services. Every
project operation forwards the incoming Bearer token to those services and
fails closed if the session is missing, expired, or cannot be verified.

When a feature model is open, the **SPL Deployment** bar lets the user download a real `.variamos/spl.json` template, validate it, and choose a remote Git repository or **Upload project folder**. Folder uploads transfer only the descriptor and declared artifacts, remain private for 24 hours, and never cause the backend to read a user-supplied host path. Remote Git operations pin a commit and remove their checkout when finished. After connecting, the flow imports artifacts, confirms bindings, plans, builds, and deploys. The validator shows supported values and compatibility rules; it does not generate technical decisions from features. The canonical `SPL Deployment Mapping v1` language is bundled with the frontend; Event Portal projects remain optional fixtures.

See the [project source of truth](docs/spl/PROJECT_SOURCE_OF_TRUTH.md) for the agreed scope, contract boundaries, and validation status.

Remote SSH/Compose deployment is an optional feature with personal, reusable targets that uses a
fresh SSH username/password login for every attempt. Private Git credentials
are a separate optional feature and may use AWS Secrets Manager. Remote
deployment is disabled by default; the [project source of truth](docs/spl/PROJECT_SOURCE_OF_TRUTH.md)
records the security controls required before it can be enabled.
