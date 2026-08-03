# Event Portal — SPL regression fixture

This directory contains project-owned assets used exclusively by regression tests. The normal application neither installs this project nor creates a special identity.

The same business features are implemented in two ways:

- `artifacts/static/`: fragments for a derived static site.
- `artifacts/modular-monolith/`: TypeScript modules assembled by `node-modular-monolith-v1` into a single Node process.

Registration demonstrates a composite feature: UI, API, data schema, and test. The derived product persists registrations in a local container volume; it uses neither credentials nor an external database.

Feature selections and bindings are in `contracts/examples/event-portal/`.
