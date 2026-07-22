# DSPL Deployment Mapping v1

Este lenguaje complementa, pero no reemplaza, el lenguaje de features de VariaMos. Un modelo de este lenguaje se enlaza mediante `sourceModelIds` a un feature model y expresa solamente la realización técnica: bindings, referencias de catálogo y target.

`language.json` es el manifiesto de distribución. Para crear el lenguaje en VariaMos se cargan los contenidos de `abstract-syntax.json`, `concrete-syntax.json` y `semantics.json` en el editor de lenguajes. Debe ser de tipo **Application** y privado mientras se valida.

Al crear el modelo de mapping, se registra el ID del feature model en **Source model IDs**. El orquestador exige exactamente un ID fuente y los fixtures de `contracts/examples/event-portal/models/` muestran la forma serializada esperada. La definición remota debe exportarse y compararse con estos archivos antes de solicitar publicación.

## Qué vincula realmente una feature con un artefacto

El texto que se ve dentro de la caja `SoftwareArtifact` **no es** el vínculo por sí solo: es la etiqueta legible de una referencia técnica. La trazabilidad se forma con estos cuatro datos, que el asistente genera y la persona confirma en su matriz:

1. El mapping declara un solo `sourceModelIds`: el ID del modelo de features de origen.
2. Cada caja `FeatureBinding` conserva `source_feature_id`, que es el ID exacto de una feature de ese modelo, y un `feature_ref` estable para informes.
3. Cada caja `SoftwareArtifact` conserva `artifact_ref`, que es el ID exacto de una entrada del catálogo autorizado del perfil. El catálogo, no el nombre mostrado en el diagrama, describe el artefacto que el builder puede materializar.
4. La flecha `ImplementedBy` desde `FeatureBinding` hacia `SoftwareArtifact` es la asociación semántica confirmada: «esta feature se realiza con este o estos artefactos».

Por ello una feature puede tener varios artefactos (por ejemplo, interfaz, API, migración y prueba), y un artefacto puede participar en más de una feature si el responsable lo confirma. Durante `Planificar`, el orquestador sigue la cadena `feature seleccionada → FeatureBinding → ImplementedBy → artifact_ref → catálogo`; no intenta adivinarla a partir de nombres ni inspeccionando líneas de código.

## Instalación privada verificada

El 2026-07-18 se creó una instalación privada con este nombre en `app.variamos.com`, de tipo **Application**, estado **Pending** y propiedad de la cuenta de práctica. No está compartida ni publicada.

La instalación remota es una **proyección** del contenido de esta carpeta; no es la fuente de verdad del proyecto. Cualquier cambio se realiza primero aquí, se revisa y prueba en el fork local y solo después se replica de manera explícita en VariaMos. Si la plataforma permite exportar una definición completa, se guardará como evidencia de comparación, nunca como sustituto de los archivos fuente versionados.
