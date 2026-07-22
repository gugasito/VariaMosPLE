# DSPL Orchestrator — adapters de ejecución v1

Este servicio es la frontera entre VariaMos y la ejecución técnica. El resolver transforma una configuración válida en un manifest reproducible. Los adapters posteriores materializan el producto y permiten un despliegue local, acotado y trazable.

## Entrada

El resolver recibe:

```text
catalog + bindings + configuration + target + sourceModel
```

Valida los JSON Schemas compartidos, comprueba referencias cruzadas, resuelve artefactos `include`, expande dependencias, verifica capacidades del target y genera un manifest v1.

## Límite deliberado de v1

Solo se soporta la acción de binding `include`. Las acciones `generate`, `configure`, `test`, `publish`, `deploy`, `migrate` y `observe` pertenecen al contrato, pero el resolver las rechaza por ahora para no prometer una semántica inexistente.

El resolver solo genera un **plan**: no ejecuta por sí mismo los pasos que incluye. Los adapters implementados consumen explícitamente el manifest y se niegan a actuar si el plan no declara su adapter esperado.

## Comandos desde la raíz del repositorio

```bash
npm run build:orchestrator
npm run test:orchestrator
```

## Providers y builder estático

Los providers recuperan bytes de un artefacto; no deciden features ni despliegan software.

- `GitArtifactProvider`: usa un checkout local previamente registrado y lee `git show <commit>:<path>`. Verifica que el remoto `origin` coincida con la fuente declarada y nunca cambia de branch o commit.
- `LocalArtifactProvider`: lee únicamente bajo raíces locales registradas y rechaza rutas absolutas o con `..`.
- `StaticSiteBuilder`: acepta solo `html-fragment`, calcula SHA-256 de cada contenido, compara catálogo y manifest y genera `index.html` más `build-metadata.json` de forma atómica.

## Deployer local Nginx

`NginxContainerDeployer` implementa `nginx-container-v1` para el caso estático. Es un adapter de laboratorio, no un mecanismo de producción ni un cliente SSH.

- exige `deploy: nginx-container-v1`, `verify: http-health-check-v1` y rollback `previous-successful-release` en el manifest;
- comprueba que `index.html` y `build-metadata.json` correspondan exactamente al manifest y crea un snapshot propio por release antes de montar archivos; así un build posterior no altera una liberación anterior;
- solo publica en `127.0.0.1`; no acepta host remoto, SSH, secretos ni puertos privilegiados;
- crea un contenedor Nginx con filesystem de solo lectura y directorios temporales explícitos;
- verifica HTTP y el marcador `data-manifest-id` para confirmar que responde el producto correcto;
- registra cada liberación bajo un directorio de estado externo, incluyendo manifest, imagen Docker resuelta, digest de `index.html`, endpoint y release previa;
- es idempotente: al invocar el mismo manifest y puerto activos únicamente vuelve a comprobar salud;
- si el candidato falla, elimina el candidato y restaura la liberación previa; también expone rollback explícito.

Docker Desktop (o un daemon Docker equivalente) debe estar activo para desplegar. La imagen por defecto es `nginx:1.27-alpine`; el registro de release guarda el ID de imagen realmente utilizado. Para un entorno no local, la política del target deberá fijar una imagen por digest y sustituir este adapter por uno autorizado para ese entorno.

## Frontera HTTP para la UI

El servidor local permite que la UI solicite una derivación sin recibir acceso a Docker, Git, SSH ni secretos:

```bash
npm run serve:orchestrator
```

Por defecto escucha solo en `127.0.0.1:8090` y expone:

```text
GET  /health
GET  /api/dspl/v1/providers
GET  /api/dspl/v1/profiles
POST /api/dspl/v1/connections/validate
POST /api/dspl/v1/connections
GET  /api/dspl/v1/connections/{id}
POST /api/dspl/v1/connections/{id}/descriptor/validate
POST /api/dspl/v1/imports
GET  /api/dspl/v1/imports/{id}
POST /api/dspl/v1/descriptors/draft
POST /api/dspl/v1/descriptors/validate
POST /api/dspl/v1/derivations
```

### Proyectos externos

El onboarding Git mantiene su estado fuera del repositorio —por defecto en `/tmp/variamos-dspl-external-projects`— y usa checkouts administrados que nunca cambian el checkout de desarrollo. Una rama o tag se resuelve a commit antes de leer `.variamos/dspl.json`. Al importar, el servicio calcula SHA-256 desde ese commit y crea un catálogo inmutable consumido por el pipeline existente.

Los repositorios HTTPS y SSH están habilitados. Las rutas Git locales están bloqueadas salvo que el operador configure `DSPL_ALLOW_LOCAL_GIT_REPOSITORIES=true`; esta excepción se usa en pruebas para crear un repositorio independiente bajo `/tmp`. Un repositorio privado debe usar un `credentialRef` y un mecanismo de credenciales Git/SSH administrado por el operador; el valor no viaja por la API ni se persiste en el modelo.

### Flujo DSPL propio: feature model + mapping model

La ruta vigente recibe un feature model y un segundo modelo `DSPL Deployment Mapping v1`:

```text
featureModel.Selected
  + mappingModel.sourceModelIds[0]
  + FeatureBinding.source_feature_id / feature_ref
  + SoftwareArtifact.artifact_ref
  + ImplementedBy
  -> product-configuration/v1 + feature-artifact-bindings/v1
  -> manifest + builder/test/deployer autorizados
```

El mapping debe declarar exactamente el feature model fuente, un `DeploymentMapping` y referencias estables a catálogo y target. `DsplMappingModelAdapter` rechaza bindings duplicados, features seleccionadas sin realización, artefactos inexistentes y referencias fuera del registro. En consecuencia, la UI puede ser genérica y no contiene reglas del dominio Portal de Eventos.

La acción puede ser `plan`, `build` o `deploy`. En el flujo propio, `build` y `deploy` exigen el `expectedPlanDigest` obtenido con `plan`; si cambia cualquiera de los dos modelos, el servidor rechaza la ejecución obsoleta. El servidor calcula internamente un `configurationId` determinista, adapta el modelo, resuelve el manifest y solo construye o despliega cuando corresponde.

La configuración local predeterminada es [contracts/resource-registry.local.json](../../contracts/resource-registry.local.json). No registra proyectos de demostración: solo autoriza targets genéricos para proyectos importados (`:8092` estático y `:8093` Node). Los catálogos y perfiles aparecen después de validar e importar un descriptor externo.

El endpoint impone JSON con tamaño máximo de 1 MiB y CORS para orígenes locales configurados. La guía de operación está en [DERIVATION_DEPLOYMENT_BUTTON.md](../../docs/dspl/DERIVATION_DEPLOYMENT_BUTTON.md); el bundle versionado del lenguaje propio está en [contracts/languages/dspl-deployment-mapping-v1](../../contracts/languages/dspl-deployment-mapping-v1/README.md).

## Reglas de determinismo

- las features seleccionadas se ordenan por ID;
- los artefactos se ordenan de forma topológica y determinista;
- el ID del manifest deriva de producto y configuración;
- no se usa fecha, estado global, red ni información de runtime;
- un input idéntico genera el mismo manifest.

## Validación

```bash
npm run validate:contracts
npm run test:contracts
npm run test:orchestrator
npm run test:event-portal
npm run test:e2e:external-project # Git independiente + Docker en un puerto efímero
```

`test:event-portal` conserva una regresión aislada para los dos builders sin instalar un proyecto en la aplicación. `test:e2e:external-project` crea un Git independiente y comprueba conexión → importación → plan → build → test → deploy.
