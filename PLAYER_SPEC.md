# Especificación del reproductor real (APK Motive Signage)

**Actualización:** el reproductor Android real ya existe —
`venuepro-signage/android/` (`MainActivity.java` + `BootReceiver.java`).
Ya hace pairing por QR, descarga y verifica media por SHA-256, reproduce
imagen/video con orientación/ajuste configurables, y se registra como
launcher `HOME` para volver solo tras reiniciar. Todo eso de este
documento ya **no** aplica — quedó resuelto por el código real.

Lo que sigue siendo nuevo (fase 2, no existe en el backend real) es la
parte de **fuente en vivo**: capturadoras SDI/HDMI y cámaras PTZ por
ONVIF/RTSP. Esta especificación ahora es solo el contrato para *eso* —
el resto del documento describe la arquitectura de mensajes que tendría
el módulo nuevo, no un reproductor desde cero.

No lo puedo compilar aquí (este entorno no tiene Android SDK), así que
esto es la base para escribirlo en Android Studio — por ti, por mí en
otra sesión con las herramientas correctas, o por quien se lo encargues.

## 1. Dos roles, un solo APK (o dos)

- **Reproductor de pantalla** — pinta la carta, la señal en vivo, la
  mezcla, o la cámara PTZ en la pantalla física. Uno por pantalla.
- **Servidor local de la ubicación** — habla con las capturadoras
  (SDI/HDMI), las cámaras PTZ (ONVIF/RTSP) y dispositivos ESPHome/ESP32
  de esa LAN, y es el único punto que sincroniza con el VPS. Uno por
  ubicación (ver charla anterior: puede ser una tablet más, o un
  dispositivo dedicado).

En una ubicación pequeña, la misma APK puede hacer ambas cosas en el
mismo dispositivo. En una con varias pantallas, solo una de ellas debe
promoverse a servidor local — las demás son reproductores simples.

## 2. Canal con el VPS

WebSocket o MQTT (recomendado MQTT — reconecta solo, QoS, y es lo mismo
que hablaría un ESP32/ESPHome, así reusas el mismo broker).

Topics sugeridos (ajusta al nombre real de tu backend):

```
motive/{locationId}/screens/{screenId}/command   ← VPS → servidor local
motive/{locationId}/screens/{screenId}/state      → servidor local → VPS
motive/{locationId}/ptz/{camId}/command           ← VPS → servidor local
motive/{locationId}/encoders/{encoderId}/state     → servidor local → VPS
motive/{locationId}/server/heartbeat               → servidor local → VPS (cada 10-30s)
```

`server/heartbeat` es lo que alimenta el "en línea / sin conexión" y el
`lastSeen` que ya se ve en la vista Clientes del panel.

### Payloads (JSON) — nombres de función ilustrativos para el módulo nuevo
(el mock original que usaba estos nombres, `sendPlayerCommand`/
`sendPtzCommand`, ya no está en el repo — `venuepro-signage/public/mobile/`
habla con la API real, sin fuente en vivo. Esto describe el módulo que
falta construir.)

```jsonc
// command a una pantalla (sendPlayerCommand)
{ "command": "set_source", "source": "live" }          // menu|live|loop|split|ptz
{ "command": "set_mix", "layout": "lower", "promo": "p1", "muted": true }

// command a una PTZ (sendPtzCommand)
{ "command": "preset", "presetId": "pr1" }
{ "command": "nudge", "dx": -8, "dy": 0 }
{ "command": "zoom", "delta": 0.3 }
{ "command": "send_to_screens", "value": true }

// command a un dispositivo ESPHome/ESP32 (sendDeviceCommand)
{ "command": "switch", "entity": "pantalla_1_power", "value": false }
```

El panel web de hoy solo hace `console.log` de estos payloads (son
mocks) — cuando tengas el servidor local real, cambia esas tres
funciones por un `publish` MQTT o un `fetch` a tu API, sin tocar el
resto de la app.

## 3. Capturadora SDI/HDMI

- Si la capturadora ya habla red (NDI, RTSP propia, HTTP), el servidor
  local solo necesita el cliente correspondiente — no hace falta tocar
  el player.
- Si es una capturadora **USB (UVC)** conectada al propio Android, el
  sistema la ve como una cámara: `UsbManager` + `Camera2 API`
  (`CameraCharacteristics.LENS_FACING_EXTERNAL` en Android 9+) para leer
  frames, o directo un `SurfaceView` si solo hace falta mostrarla.
- El estado que reporta (`ENC_LABEL`: EN DIRECTO / EN ESPERA / SIN
  ENTRADA) sale de si hay señal detectada en esa entrada — expón eso por
  el topic `encoders/{id}/state`.

## 4. Cámara PTZ — ONVIF + RTSP

- **Descubrimiento/control**: ONVIF Profile S por SOAP/HTTP contra el
  `xAddr` del dispositivo (`http://<ip>/onvif/device_service`). Librería
  recomendada: hacer las llamadas SOAP a mano con OkHttp (son pocas:
  `GetProfiles`, `ContinuousMove`, `AbsoluteMove`, `GotoPreset`) — las
  librerías ONVIF para Java suelen estar poco mantenidas.
- **Fallback sin ONVIF**: VISCA-over-IP, UDP puerto 52381, protocolo
  binario simple — impleméntalo aparte solo si aparece una cámara sin
  ONVIF real.
- **Vídeo**: pide el RTSP de la cámara directamente — no hace falta ONVIF
  para esto, es un stream RTSP normal.

## 5. Vídeo en el reproductor — go2rtc + ExoPlayer

Para mostrar el vídeo (RTSP de la PTZ, o lo que salga de la capturadora)
tanto en la pantalla física como en la previsualización del panel web:

- Corre **go2rtc** en el servidor local de la ubicación (binario ARM vía
  Termux, o nativo si es un mini PC). Le das la URL RTSP y expone
  WebRTC/MSE en el puerto 1984 — el panel web del módulo nuevo consumiría
  ese endpoint (aún no existe: `venuepro-signage/public/mobile/` de hoy
  no tiene pantalla de PTZ, ver nota al principio de este documento).
- En el reproductor Android, **ExoPlayer soporta RTSP nativo** desde la
  2.16 (`MediaItem.fromUri("rtsp://...")` con el módulo
  `media3-exoplayer-rtsp`) — no hace falta pasar por go2rtc si solo vas
  a mostrarlo en la pantalla física, úsalo directo. go2rtc hace falta
  sobre todo para que el **navegador** (panel web) pueda verlo, porque
  ahí sí no hay forma de tocar RTSP directo.

## 6. Qué NO debe hacer el VPS

Ninguna de las conexiones de arriba (ONVIF, RTSP, USB, ESPHome) sale
del VPS — todas las abre el servidor local, porque está en la misma LAN.
El VPS solo manda/recibe mensajes cortos (JSON) por MQTT/WebSocket. Si
en algún diseño futuro alguien propone que el VPS "llame directo" a una
IP privada del restaurante, es un error de arquitectura — no es
alcanzable desde fuera sin abrir el router del local.
