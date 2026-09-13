# Gestor móvil y reproductor Android

## Crear clientes y abrir desde el CRM

Agencia → Settings → Digital Signage → Clientes exclusivos de DS → Nueva cuenta de DS. Indica el negocio, correo y contraseña inicial del administrador. Crea un tenant independiente en Signage, sin crear una empresa del CRM. El cliente entra directamente en ds.venueprocrm.cloud; no se envía correo automáticamente. La agencia puede seleccionar esa cuenta y abrir su gestor.

Para empresas del CRM, vincula primero la empresa desde la agencia. Su administrador encuentra Settings → Digital Signage → Abrir gestor de pantallas dentro del CRM. El acceso usa un ticket de un solo uso, válido durante un minuto, y abre DS con una sesión de una hora sin pedir otras credenciales. No se concede acceso a otro tenant ni se permite esta entrada a perfiles de solo operaciones. Si el vínculo se desactiva, la entrada desde el CRM queda bloqueada.

## Gestor para cada suscriptor

Abre https://ds.venueprocrm.cloud/ e inicia sesión con el usuario de tu organización. Pulsa **Instalar app**. En iPhone: Safari → Compartir → Añadir a pantalla de inicio (activa Abrir como app web si aparece). En Android: Chrome → Instalar aplicación. La misma web app muestra únicamente el tenant de la sesión; instalarla no crea usuarios ni concede acceso.

En Ubicaciones / Pantallas, pulsa Vincular pantalla y abre la cámara para leer el QR del reproductor. También puedes introducir su código. Biblioteca, listas y programación se gestionan desde el teléfono. El gestor necesita internet para guardar; los reproductores mantienen sus archivos descargados. El service worker no guarda respuestas de API ni datos de sesión.

## APK del reproductor 0.3.0 (prueba)

Descarga `/downloads/venuepro-signage-test.apk` desde el gestor e instálala en el Android TV, TV box o tableta dedicada. Esta APK está firmada para pruebas; la distribución comercial necesita una clave de firma de producción conservada para futuras actualizaciones.

1. Abre VenuePro Signage una vez tras instalarla.
2. Antes de vincular, pulsa **Configurar inicio automático** → **Elegir app de inicio** y selecciona VenuePro Signage como Inicio predeterminado. También puedes entrar desde Ajustes de Android → Aplicaciones predeterminadas → Inicio. En un mando con tecla Menú, esa tecla vuelve a abrir la configuración durante la reproducción.
3. Escanea el QR desde el gestor del suscriptor y publica una lista. Espera a que termine la descarga.
4. Reinicia el equipo para validar que abre el reproductor y vuelve a mostrar la lista. Repite sin red para validar los archivos locales.

La APK declara Inicio/HOME y recibe BOOT_COMPLETED. Android moderno puede bloquear aperturas desde segundo plano: el receptor por sí solo no garantiza el arranque. La opción Inicio predeterminado es la configuración para equipos dedicados compatibles. Algunos fabricantes no permiten cambiar el launcher; esos equipos requieren su gestión empresarial/firmware. Un bloqueo con PIN requiere desbloquear el equipo antes de reproducir. Esta versión no elimina el bloqueo del sistema ni provisiona device-owner.

Para restaurar el launcher original, cambia la app Inicio en Ajustes del sistema. No fuerces la detención del reproductor durante el uso; si lo haces, vuelve a abrirlo.

Validado en desarrollo: compilación de APK, lint sin errores, QR real en navegador, aislamiento de tenants, instalación PWA (manifest/guía), caché pública, recuperación del gestor y reproducción web sin conexión. Pendiente: instalación en iPhone/Android físicos y prueba de reinicio en el hardware elegido.

Referencia Android: https://developer.android.com/work/dpc/dedicated-devices/cookbook

## Orientación y ajuste por pantalla

En el gestor: Pantallas → Opciones → Orientación y ajuste. Selecciona Automática, Horizontal o Vertical. El giro adicional permite 0°, 90°, 180° o 270° en sentido horario. Automática utiliza el tamaño actual de la ventana; no detecta cómo está montado físicamente un TV sin sensor. Horizontal/Vertical rotan el lienzo 90° si la ventana tiene la proporción opuesta; el giro adicional se aplica después.

Rellenar (predeterminado) escala imágenes y videos de forma proporcional y recorta los bordes alrededor del centro. Mostrar completo conserva todo el contenido, con bandas negras cuando las proporciones no coinciden. Estos ajustes no alteran los archivos originales y se guardan en el manifiesto local para usarlos sin conexión. Los ajustes nuevos llegan cuando el reproductor se sincroniza.

Actualiza la APK instalada a 0.3.0 para aplicar estos ajustes en Android. El reproductor web los recibe al recargar conectado. Compilación y lint Android verificados; rotaciones, ajuste y persistencia sin red probados en navegador. Validar imagen y video en el Android físico antes de entregar el equipo.
