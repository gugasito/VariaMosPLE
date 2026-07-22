# Portal de Eventos — fixture de regresión DSPL

Este directorio contiene activos propios usados exclusivamente por pruebas de regresión. La aplicación normal no instala este proyecto ni crea una identidad especial.

Las mismas features de negocio se realizan de dos formas:

- `artifacts/static/`: fragmentos para un sitio estático derivado.
- `artifacts/modular-monolith/`: módulos TypeScript ensamblados por `node-modular-monolith-v1` en un único proceso Node.

La inscripción demuestra una feature compuesta: interfaz, API, esquema de datos y prueba. El producto derivado persiste inscripciones en un volumen local del contenedor; no usa credenciales ni una base de datos externa.

La selección de features y los bindings se encuentran en `contracts/examples/event-portal/`.
