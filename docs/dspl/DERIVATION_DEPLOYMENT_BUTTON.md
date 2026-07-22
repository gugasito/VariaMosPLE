# Panel de derivación y despliegue DSPL

**Estado:** implementado para el flujo normal de proyectos DSPL. El panel sustituye al botón experimental anterior.

## Qué aparece en VariaMos

El componente [DsplDerivationPanel.tsx](../../src/UI/WorkSpace/DsplDerivationPanel.tsx) se abre como una barra lateral deslizable desde el borde derecho. Si se cierra, queda el botón **Despliegue DSPL** para abrirla de nuevo; así no se corta el flujo en pantallas pequeñas. Se muestra cuando la selección actual es:

- un feature model que tiene al menos un mapping `DSPL Deployment Mapping v1` asociado; o
- el propio mapping asociado a un feature model.

La asociación no depende del nombre visible: el mapping declara exactamente un identificador en `sourceModelIds`. Para los modelos `DSPL Deployment Mapping v1`, el editor muestra el selector **Modelo de features fuente** en lugar de pedir que se escriba un ID. El orquestador lo valida antes de producir un plan.

El panel nunca lee código, ejecuta Docker ni recibe secretos. Envía una representación serializada de ambos modelos a un orquestador de loopback, que usa solamente catálogos y targets previamente autorizados.

```text
Feature model (decisiones Selected)
  + Mapping model (FeatureBinding -> SoftwareArtifact)
  -> POST local al orquestador
  -> configuración + bindings deterministas
  -> manifest inmutable
  -> builder y pruebas del perfil
  -> deployer local, si se solicita
```

## Acciones del panel

1. **Planificar:** valida features, bindings, catálogo, target y capacidades. No escribe ni ejecuta nada. Devuelve `planDigest`.
2. **Derivar y probar:** requiere el digest de ese plan. Materializa los artefactos con hash verificado y ejecuta las pruebas del perfil.
3. **Desplegar:** vuelve a validar el mismo digest y crea/actualiza una release Docker local.
Se mantienen las acciones separadas porque una release puede ser válida y probada sin que todavía exista autorización para publicarla; esto permite revisar pruebas, aprobar el manifest y diagnosticar fallos antes de cambiar un destino.

Si cambian las selecciones o el mapping entre el plan y las acciones posteriores, el digest deja de coincidir y el servidor responde `409`; se debe planificar otra vez. La referencia de configuración guardada que se puede escribir en el panel es una traza humana: la fuente real de las decisiones sigue siendo el feature model serializado. Cuando hubo un deploy exitoso, **Abrir producto desplegado** permanece visible en la barra durante la sesión, incluso si se vuelve a planificar.

## Lenguajes y modelos requeridos

No se agrega una feature especial al código de VariaMos. Se usan dos capas de modelado:

| Capa | Lenguaje | Responsabilidad |
|---|---|---|
| Variabilidad | `Feature model with attributes` público | Features y su propiedad `Selected`. |
| Realización técnica | `DSPL Deployment Mapping v1` privado | Catálogo, target, bindings y artefactos versionados. |

La especificación instalable del segundo está en [contracts/languages/dspl-deployment-mapping-v1](../../contracts/languages/dspl-deployment-mapping-v1/README.md). Sus elementos son:

- `DeploymentMapping`: uno por perfil, con `mapping_ref`, `catalog_ref` y `target_ref`.
- `FeatureBinding`: enlaza una feature fuente (`source_feature_id`) a su ID estable (`feature_ref`).
- `SoftwareArtifact`: referencia un artefacto técnico mediante `artifact_ref`.
- `ImplementedBy`: une un binding con uno o más artefactos. Así una feature puede incluir UI, API, esquema y pruebas sin asumir que es un único archivo.

### Fuente de verdad: local primero, VariaMos después

`app.variamos.com` es una instalación ya desplegada de VariaMos. Crear allí un lenguaje privado guarda **datos de modelado de la cuenta**, pero no modifica ni despliega el código de la plataforma. El desarrollo de esta práctica ocurre exclusivamente en el fork local:

| Recurso | Fuente canónica | Rol de VariaMos.com |
|---|---|---|
| Definición del lenguaje | `contracts/languages/dspl-deployment-mapping-v1/` | Instalación privada que debe coincidir con el bundle local. |
| Fixtures de regresión | `contracts/examples/event-portal/` y `examples/event-portal/` | No se instalan en la cuenta ni se usan como proyecto de trabajo. |
| Orquestador y panel | `services/dspl-orchestrator/` y `src/UI/WorkSpace/` | Solo se prueban al ejecutar el frontend del fork local. |

Por tanto, no se “mueve” el lenguaje recién creado desde la nube hacia el repositorio: ya se creó desde el bundle local. La dirección correcta de cambio es **repositorio → revisión/pruebas → instalación privada**. Una futura exportación remota se guardará solo como evidencia para comparar que no haya deriva.

## Contrato HTTP vigente

`POST /api/dspl/v1/derivations`

```json
{
  "action": "plan",
  "projectId": "project.event-portal",
  "productLineId": "event-portal",
  "featureModel": { "id": "...", "elements": [], "relationships": [] },
  "mappingModel": { "id": "...", "sourceModelIds": ["..."], "elements": [], "relationships": [] }
}
```

Para `build` y `deploy` se añade el `expectedPlanDigest` recibido en el plan. La respuesta no devuelve rutas del host, credenciales, comandos ni contenido de secretos. `GET /health` comprueba que el orquestador está disponible; `GET /api/dspl/v1/catalogs/<catalog-id>` expone solo un resumen de los catálogos registrados.

`GET /api/dspl/v1/profiles` entrega al asistente únicamente el identificador y nombre del perfil, sus referencias de mapping/catálogo/target, adapters y el inventario público `{ id, kind, version }` de artefactos. Nunca expone rutas, puertos, hashes internos, código o credenciales.

## Asistente de bindings

El botón **Configurar bindings** abre un modal dentro de la barra lateral. El asistente:

1. consulta los perfiles autorizados al orquestador local;
2. genera un mapping en *Application engineering* con un binding por feature configurable y los artefactos del catálogo;
3. establece `sourceModelIds` con el feature model elegido;
4. presenta una matriz feature × artefacto y crea las relaciones `ImplementedBy` confirmadas.

La automatización crea la estructura y conserva IDs estables; no intenta adivinar semántica leyendo nombres de archivos ni líneas de código. Una persona declara qué artefactos realizan cada feature. Una feature puede tener varios artefactos, por ejemplo UI, API, esquema y pruebas.

## Ejecución local

```bash
# Terminal 1
npm run start:dspl

# Terminal 2
npm start
```

La UI usa `REACT_APP_DSPL_ORCHESTRATOR_URL=http://127.0.0.1:8090`. Si ya había un proceso antiguo en ese puerto, debe reiniciarse para que cargue este código. El entorno local no publica a Internet: los targets solo aceptan `127.0.0.1`.

Para comprobar la cadena sin manipular la UI:

```bash
npm run validate:contracts
npm run test:orchestrator
npm run test:e2e:event-portal
```

El último comando requiere Docker y genera/actualiza únicamente releases de prueba fuera del repositorio.

## Arquitecturas comprobadas y límites

| Perfil | Builder | Target | URL local | Estado |
|---|---|---|---|---|
| Sitio estático | `static-site-v1` | `nginx-container-v1` | `http://127.0.0.1:8089/` | comprobado |
| Monolito modular Node/TypeScript | `node-modular-monolith-v1` | `node-container-v1` | `http://127.0.0.1:8091/` | comprobado |

No se declara soporte de microservicios, Kubernetes, SSH, despliegue remoto ni MAPE-K en producción. El contrato permite añadir perfiles futuros mediante un nuevo catálogo, builder, deployer, pruebas y evidencia; no mediante reglas arbitrarias dentro de un modelo.
