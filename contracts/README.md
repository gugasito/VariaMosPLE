# Contratos DSPL

Estos contratos implementan la primera parte de la línea base maestra: separar el modelo de variabilidad de los detalles tecnológicos necesarios para derivar y desplegar un producto.

```text
Feature seleccionada
  -> binding declarativo
  -> artefacto versionado del catálogo
  -> manifest validado
  -> builder/deployer con adapter explícito
```

## Contenido

- `schemas/`: JSON Schema Draft 2020-12 de artefacto, catálogo, binding, configuración, target, manifest y descriptor externo `variamos-project/v1`.
- `examples/event-portal/`: fixture de regresión propio con feature model, dos mappings, tres configuraciones, catálogo, targets, registro local y hashes verificables.
- `languages/dspl-deployment-mapping-v1/`: bundle versionado del lenguaje privado que modela la realización técnica de una feature sin reemplazar el lenguaje público de features.
- `examples/invalid/`: fixtures que deben fallar una validación.
- `examples/variamos-project/`: descriptor listo, borrador válido y casos inseguros que deben fallar.
- `scripts/validate-contracts.cjs`: validación de esquema y referencias cruzadas.
- `tests/contracts.test.cjs`: pruebas automáticas de los contratos.

## Comandos

Desde la raíz del repositorio:

```bash
npm run validate:contracts
npm run test:contracts
```

## Alcance de esta iteración

Los contratos no descargan, construyen ni despliegan software por sí mismos. Establecen qué información debe existir antes de que un resolver o un adapter del orquestador pueda hacerlo de manera reproducible. El adapter local `nginx-container-v1` consume el manifest validado, pero sus registros de runtime son estado operacional y no forman parte del contrato de configuración.

El catálogo declara además `derivation.builderAdapter` y, opcionalmente, `derivation.testAdapter`. Así, el resolver puede producir un plan de build y test sin deducir esos adapters a partir de un nombre de archivo o de una URL.

El fixture Portal de Eventos usa exclusivamente activos propios y verifica dos perfiles: sitio estático y monolito modular. La validación de contratos comprueba sus esquemas, IDs, relaciones modelo–mapping, rutas confinadas y SHA-256 de cada activo antes de que el orquestador pueda usarlo. No se instala como proyecto ni usuario al ejecutar la aplicación normal.

La relación visual `ImplementedBy` de VariaMos se conservará durante la migración, pero se interpretará como referencia a un binding o a un `artifact_ref`, nunca como una URL directa de producción.

`variamos-project/v1` separa el repositorio de su conexión operacional. El descriptor declara rutas relativas, artefactos y adapters autorizados; el orquestador aporta provider, commit resuelto, checkout, target y `credentialRef`. Un descriptor `draft` puede incluir `artifactProposals` no ejecutables, preguntas pendientes, validarse y descargarse; sólo `ready`, sin propuestas ni pendientes, puede importarse.
