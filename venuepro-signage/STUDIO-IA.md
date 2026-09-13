# Estudio IA de Digital Signage

Disponible únicamente para empresas VenuePro con vínculo CRM activo y usuarios DS editor/administrador. Las cuentas DS independientes quedan excluidas por el servidor, aunque conozcan las rutas. Se mantienen la biblioteca y los datos de la organización existente; no se crea otra cuenta para el estudio.

## Configuración y credenciales

El CRM ya guarda la clave de cada empresa en `tenant_ai_settings.api_key_encrypted`, cifrada y ligada al tenant. Al abrir DS desde Settings del CRM o desde la agencia para una empresa CRM, el servidor lee esa clave usando el contexto de tenant, la descifra y la envía por HTTPS con firma HMAC al servicio DS. El secreto no viaja en la URL ni en la respuesta de SSO. DS vuelve a cifrarlo con AES-256-GCM y el tenant como AAD. El material de cifrado DS deriva de `AGENCY_SIGNAGE_SECRET` con un propósito separado; conservar ese secreto junto con el respaldo de la base de datos. No se usa como clave de OpenAI.

Entrar de nuevo desde el CRM actualiza la copia importada si cambió o se eliminó la clave. Esto no es sincronización continua: una sesión DS abierta puede conservar la configuración anterior hasta el siguiente acceso desde CRM. Una clave propia configurada explícitamente en Estudio IA tiene prioridad y no se sobrescribe con la importación. El administrador puede configurar una clave de la empresa en DS cuando falta. No se devuelve ninguna clave guardada al navegador, ni se guarda en localStorage. No hay fallback a una clave OpenAI global ni al saldo de la agencia.

En Estudio IA → Configurar OpenAI, establece el cupo mensual (inicialmente 0), habilita y verifica el acceso al modelo. La comprobación usa GET `/v1/models/gpt-image-2` y no genera imágenes. Confirma que la API reconoce el modelo, pero no garantiza saldo ni permiso efectivo para generación. Tener chat configurado o una suscripción de ChatGPT no confirma estas capacidades. La configuración de producción de cada empresa solo se puede confirmar al acceder/verificar; no se han probado claves reales ni generado imágenes con costo durante el desarrollo.

## Flujo y consumo

1. Seleccionar imagen de la biblioteca o subir una imagen de hasta 20 MB; también se admite generar un fondo desde descripción.
2. Elegir promoción/ventas, menú, evento, bienvenida o portada; escribir los textos, precio/fecha cuando aplique, estilo y orientación.
3. Guardar el borrador. Las capas permiten editar texto, posición, tamaño y color.
4. Solicitar expresamente una generación y confirmar el uso de la API de la empresa. Se genera un fondo sin textos; los datos exactos siguen en las capas. La referencia y descripción se envían a OpenAI.
5. Revisar la propuesta, hacer ajustes y guardar el borrador. Cambiar textos no genera imágenes ni consume API.
6. Guardar el resultado PNG revisado en biblioteca. El diseño editable sigue disponible. La publicación en pantallas se hace después mediante las acciones habituales de listas/pantallas.

Modelo: `gpt-image-2`, calidad `medium`, una imagen por solicitud. Imágenes API generaciones/ediciones con salida PNG; el servidor elige la referencia únicamente dentro del tenant. Salida final del editor: horizontal 1920×1080, vertical 1080×1920 o cuadrada 1080×1080. Los fondos se adaptan proporcionalmente con recorte centrado. Revisar bordes, saltos de texto y datos antes de exportar.

El cupo cuenta solicitudes reservadas durante el mes UTC, incluidos fallos y resultados inciertos; no representa dinero ni saldo OpenAI. Solo una generación en curso por empresa. Las solicitudes tienen ID persistido para evitar repetir un envío cuyo resultado HTTP no llegó al navegador. Se registra el estado, fecha, request ID y los tokens que OpenAI reporte; si no los reporta se muestra como desconocido. No se calculan costos inventados.

Si se interrumpe un envío a OpenAI, no se reintenta automáticamente: queda incierto para revisar consumo. Si OpenAI ya entregó una imagen y falla el almacenamiento, la imagen se conserva temporalmente en la base de datos y se ofrece reintentar solo el guardado. Los fondos no aparecen en la biblioteca hasta que el usuario exporta la composición revisada. No se publican listas ni se asignan pantallas desde este módulo.

## Validación

- Pruebas backend con proveedor inyectado: claves por tenant, copia cifrada desde CRM, aislamiento, exclusión independiente, roles, revisiones, cuotas, idempotencia, consumo, resultados inciertos y recuperación de almacenamiento.
- Prueba de navegador con proveedor simulado: configuración, propuesta, edición de precio/teléfono, exportación separada y diseño a 320/390/768/1440 px.
- No se ejecutaron generaciones reales, no se consultó saldo y no se publicó contenido en pantallas.

Documentación oficial consultada: https://developers.openai.com/api/docs/guides/image-generation
