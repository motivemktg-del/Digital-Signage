# Control PTZ (ONVIF)

Agente local (add-on de Home Assistant) que ejecuta de verdad los
comandos PTZ que el panel de `venuepro-signage` ya guarda — sin este
add-on, mover la cruceta/zoom/encuadres en el panel **solo guarda la
intención**, no mueve nada físico (ver la nota en `store.js` sobre
`command`/`command_seq`, y `PLAYER_SPEC.md` para el resto del contrato).

**Importante — dos cosas separadas:**
- **Ver el video de la cámara PTZ** (y mandarlo a pantallas) ya funciona
  hoy, sin este add-on — es el mismo camino que cualquier canal: la
  cámara entra a go2rtc, y `view_url` en el panel apunta a esa URL de
  go2rtc. Nada que instalar para eso.
- **Mover la cámara** (cruceta/zoom/presets) es lo que arregla ESTE
  add-on — habla **ONVIF PTZ** directo con la cámara. go2rtc no
  participa acá: es un relay de video, no traduce comandos de cámara.

## Tu cámara (Amcrest IP2M-841W-V3, 192.168.12.13)

Ya la tienes detectada en go2rtc local. Para dejar las dos cosas
funcionando (video + control real), configura así:

**1. go2rtc (Mini PC) — la fuente de VIDEO**, con el RTSP que ya tienes:
```yaml
streams:
  ptz1: rtsp://usuario:contraseña@192.168.12.13:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif
```

**2. Panel venuepro-signage → Ubicación → "+ Agregar" cámara PTZ:**
- `onvifUrl` (control real, lo que usa este add-on):
  `onvif://usuario:contraseña@192.168.12.13` — mismo formato que ya usan
  en go2rtc. Confirmado para este modelo: el servicio ONVIF vive en el
  puerto 80 con `GetCapabilities` devolviendo XAddr propios para Media
  (`/onvif/media_service`) y PTZ (`/onvif/ptz_service`) — este add-on los
  descubre solo, no hace falta escribirlos.
- `rtspUrl`: el mismo RTSP de arriba (referencia informativa, no la usa
  este add-on).
- `viewUrl` (lo que se VE en el panel/pantallas): la URL de go2rtc para
  ese stream, ej. `http://<ip-mini-pc>:1984/api/stream.mp4?src=ptz1` (o
  vía Tailscale si el panel/dispositivo no está en la misma LAN).

## Cómo se traduce cada botón del panel a ONVIF

| Botón del panel | Comando guardado | Qué hace este add-on |
|---|---|---|
| Cruceta (▲▼◀▶) | `nudge {dx,dy}` | `ContinuousMove` a velocidad fija por `nudge_seconds`, luego `Stop` — es un "empujón corto", no press-and-hold (el panel manda un tap discreto, no un stream de posición). |
| Zoom +/− | `zoom {delta}` | Igual que nudge pero solo en el eje de zoom, duración `zoom_seconds`. |
| Ir a un encuadre guardado | `preset {pan,tilt,zoom}` | `AbsoluteMove` directo a esos valores (pan/tilt en -1..1, zoom en 0..1 — espacio normalizado genérico de ONVIF). |
| HOME | `home {}` | `GotoHomePosition` (la posición de fábrica que la propia cámara tenga guardada). |

## Instalar como add-on local de Home Assistant

1. Copia esta carpeta completa (`ptz-agent/`) a
   `/addons/local/ptz-agent/` en tu Mini PC (Samba o Terminal & SSH,
   igual que hiciste con `ad-break-detector/`).
2. **Ajustes → Add-ons → Tienda de add-ons → ⋮ → Comprobar
   actualizaciones.** Debería aparecer "Control PTZ (ONVIF)" bajo
   **Add-ons locales**. Instálalo (compila la imagen la primera vez).
3. Llena las **Opciones** del add-on:
   - `signage_api`: `https://ds.venueprocrm.cloud`
   - `signage_email` / `signage_password`: **crea un usuario dedicado**
     para este bot desde Equipo en el panel (rol `editor` alcanza, no
     hace falta `admin`).
   - El resto de opciones (`poll_interval_ms`, `nudge_seconds`,
     `nudge_speed`, `zoom_seconds`, `zoom_speed`) ya traen valores
     razonables — ajústalos solo si la cámara se mueve muy poco/mucho
     por tap.
4. Arráncalo. En los **Logs** del add-on deberías ver
   `Agente de control PTZ (ONVIF) arrancado.` y, al mover la cruceta en
   el panel, una línea `<cámara>: nudge ejecutado.` (o el error exacto si
   algo falla — ver Solución de problemas abajo).

No hace falta reconfigurar el add-on por cámara: revisa TODAS las
cámaras PTZ del tenant que tengan `onvifUrl` puesta, automáticamente.

## Solución de problemas (ONVIF varía por marca/firmware)

Esto está escrito a mano contra el estándar ONVIF Core/PTZ, no probado
todavía contra la Amcrest real — son los puntos donde más varían las
cámaras entre sí, en orden de probabilidad:

- **"401" o "no autorizado"**: la Amcrest tiene un hilo propio en su
  foro sobre ONVIF con problemas de autenticación en firmwares nuevos.
  Este agente manda tanto HTTP Digest como WS-Security (UsernameToken
  con digest) en cada llamada por si acaso — si sigue fallando, entra a
  la interfaz web de la cámara y confirma que el usuario ONVIF tenga
  permisos de "Operator" o superior (no solo "viewer").
- **"La cámara no devolvió ningún perfil"**: pasa si `GetProfiles` no
  encontró `token` en el primer `<Profiles>` — revisa el log completo
  del add-on, ahí se imprime el error tal cual.
- **Se mueve al revés (izquierda en vez de derecha, etc.)**: cambia el
  signo de `pan`/`tilt` — es común que el eje Y esté invertido entre
  cámaras. Como es un ajuste de un par de líneas en `ptz_agent.py`
  (`continuous_move`/`absolute_move`), avisa con qué dirección salió mal
  y se corrige puntual.
- **No hace nada y no hay error en el log**: confirma que `onvifUrl` esté
  realmente puesta en la cámara del panel (no solo `rtspUrl`/`viewUrl`)
  — sin `onvifUrl` el add-on la salta de plano, a propósito (es una
  cámara "solo video").

## Correr fuera de Home Assistant (para probar en tu máquina)

```sh
pip install -r requirements.txt
cp config.local.example.json config.local.json   # y edítalo
python3 ptz_agent.py
```

## Pruebas (sin red, sin cámara real)

```sh
python3 -m unittest test_onvif_client.py test_ptz_agent.py -v
```

Cubren el parseo de las respuestas SOAP (`GetCapabilities`/
`GetProfiles`), el header WS-Security, y la conversión
`onvif://user:pass@host` → URL http real — no prueban contra una cámara
de verdad, eso solo se valida en campo (ver Solución de problemas).
