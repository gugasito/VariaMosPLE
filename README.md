# VariaMosPLE

## Install

```bash
npm install
```

## Run

La aplicación y el orquestador son procesos separados. La funcionalidad DSPL forma parte del build normal y usa la autenticación habitual de VariaMos; no instala usuarios ni proyectos de demostración.

```bash
# terminal 1: API DSPL local
npm run start:dspl

# terminal 2: aplicación VariaMos normal
npm start
```

Abre `http://localhost:3000` (no `127.0.0.1`). Si el puerto 3000 está ocupado, el comando termina con un mensaje explícito para evitar abrir accidentalmente otra instancia en 3001. La pantalla de inicio de sesión pertenece a VariaMos y vuelve a localhost con un token temporal; ese token se retira inmediatamente de la URL y no debe copiarse en modelos ni descriptores.

Al abrir un feature model, la barra **Despliegue DSPL** permite conectar un repositorio Git con `.variamos/dspl.json`, importar sus artefactos, confirmar bindings, planificar, derivar y desplegar. El lenguaje `DSPL Deployment Mapping v1` se distribuye con el frontend; los proyectos del Portal de Eventos siguen siendo fixtures opcionales.

Ver [Incorporación de proyectos externos](docs/dspl/EXTERNAL_PROJECT_ONBOARDING.md) para el contrato, seguridad, API, ejecución y prueba E2E.
