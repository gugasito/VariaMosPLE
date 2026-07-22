# Incorporación de proyectos externos DSPL

## Resultado

La incorporación de proyectos forma parte de la aplicación normal: el frontend distribuye el lenguaje de mapping, la UI muestra **Conectar proyecto** y el orquestador mantiene conexiones e importaciones dinámicas fuera del modelo.

```text
feature model
  + conexión Git administrada
  + .variamos/dspl.json en un commit
  -> catálogo con hashes calculados
  -> mapping confirmado por una persona
  -> plan / build / test / Docker local
```

## Preparar un repositorio

El descriptor preferido vive en `.variamos/dspl.json`. `project.id`, `project.name`, cada ID/tipo/versión/ruta de artefacto y al menos un perfil son obligatorios cuando `status` es `ready`. Etiquetas, descripciones, dependencias, entrypoints e integridad declarada son opcionales.

Las rutas son relativas al repositorio. No se admiten rutas absolutas, `..`, comandos, tokens, contraseñas, hosts de despliegue ni claves. El contrato exacto está en `contracts/schemas/variamos-project.schema.json`; `examples/external-project-onboarding/` es una plantilla que las pruebas convierten en un repositorio Git independiente real.

En v1 los builders incluidos materializan archivos identificables. Una feature compuesta se representa con varios artefactos. Los directorios completos, Maven/Gradle, imágenes OCI y transformaciones AST requieren adapters posteriores antes de declararse soportados.

## Flujo de interfaz

1. Abrir o crear un feature model y seleccionar **Despliegue DSPL**.
2. Elegir **Generar descriptor** si el repositorio aún no posee uno. El resultado es un borrador con propuestas no ejecutables (`artifactProposals`) y preguntas por feature, sin rutas, tipos, comandos ni versiones inventadas.
3. Editar la plantilla en la propia interfaz, pulsar **Validar JSON Schema**, copiarla o descargarla; luego sustituir las propuestas por artefactos y perfiles reales, marcarla `ready` y crear un commit.
4. Elegir **Conectar proyecto** e indicar ID, URL, ref y ruta del descriptor.
5. Para una fuente privada, usar sólo un `secret://...` administrado por el operador. Nunca pegar el valor.
6. Validar. La vista previa muestra commit, descriptor, perfil y artefactos.
7. Importar. VariaMos crea un mapping vacío y registra únicamente IDs públicos.
8. Abrir **Configurar bindings** y confirmar la matriz feature–artefacto.
9. Planificar, revisar digest/trazabilidad, derivar y probar, y desplegar.

Una fuente local nueva no se identifica mediante una ruta arbitraria del navegador. Debe registrarse como raíz/perfil autorizado por el administrador o subirse mediante un mecanismo administrado futuro. Los perfiles locales ya autorizados aparecen en **Configurar bindings**.

## Persistencia y seguridad

- Conexiones, checkouts y catálogos importados se guardan bajo `DSPL_EXTERNAL_PROJECT_STATE`, fuera del repositorio.
- El endpoint público oculta checkout y `credentialRef`; los perfiles externos publican sólo commit, digest del descriptor e IDs.
- Una ref móvil se fija antes de la vista previa. Guardar la conexión exige el mismo commit y digest, evitando cambios entre validación e importación.
- Git se ejecuta con argumentos separados, prompt interactivo desactivado, timeout y límites de tamaño.
- CORS y el listener continúan restringidos a loopback. Despliegues externos usan targets genéricos de `contracts/resource-registry.local.json`.
- El digest del plan cubre el catálogo normalizado; commit, rutas y hashes forman parte de ese input.

## Operación

```bash
npm install
npm run start:dspl
# en otra terminal
npm start
```

Para validar sin interfaz:

```bash
npm run validate:contracts
npm run test:contracts
npm run test:orchestrator
npm run test:e2e:external-project
```

El último comando requiere Docker. Crea el repositorio Git de prueba bajo `/tmp`, conecta e importa mediante HTTP, despliega en un puerto loopback efímero y elimina el contenedor y el estado temporal al terminar.

## Fuera de alcance comprobado

No se declara soporte de SSH de despliegue, Kubernetes, OCI, microservicios, comandos arbitrarios, análisis semántico de repositorios o MAPE-K. Git es un provider; los estilos arquitectónicos actualmente comprobados siguen siendo sitio estático y monolito modular Node.
