# Detector de corte comercial

Agente local (add-on de Home Assistant) que mira la señal en vivo que ya
capturas con go2rtc, detecta cuándo entra un corte comercial, y activa
automáticamente el **Mezclador** de esa pantalla en `venuepro-signage`
(tu propia promo/logo/texto) — y lo quita solo cuando la transmisión en
vivo vuelve. Es el disparador automático de lo que ya construimos a mano
en el panel (`/api/devices/:id/mix`, ver `PLAYER_SPEC.md` §4.5).

**Uso previsto: mostrar TUS propias promos en tu propio local durante el
corte.** No está pensado para vender ese espacio a terceros anunciantes —
esa versión (estilo Taiv) trae capas de contrato con tu proveedor de
cable/satélite que no cubre este agente (ver la conversación sobre eso).

## Cómo detecta el corte (y sus límites)

No hay metadato de "esto es un comercial" disponible a esta altura (ya es
solo video HDMI capturado) — así que combina 3 señales débiles y exige que
al menos 2 coincidan, sostenidas un mínimo de segundos, antes de cambiar:

1. **Cuadro negro reciente** — casi todo corte pasa 1-3 cuadros en negro.
2. **"Bug" del canal ausente** — el logo del canal / marcador del juego en
   una esquina fija desaparece o cambia durante los comerciales.
3. **Tasa de cortes de plano alta** — los comerciales editan mucho más
   rápido que una jugada en vivo.

**Esto es heurística de campo, no magia** — la tasa de aciertos depende de
calibrar bien el `bug_roi` para el canal/liga que se esté viendo, y de
ajustar los umbrales con la señal real de tu local. Arranca con
`min_ad_seconds`/`min_live_seconds` altos (3-5s) mientras confirmas que no
hay falsos positivos con jugadas normales, y bájalos después si hace falta
más velocidad de reacción.

## Instalar como add-on local de Home Assistant

1. Copia esta carpeta completa (`ad-break-detector/`) a
   `/addons/local/ad-break-detector/` en tu Mini PC — por Samba (add-on
   "Samba share") o por la terminal (add-on "Terminal & SSH").
2. En Home Assistant: **Ajustes → Add-ons → Tienda de add-ons → ⋮ (arriba
   a la derecha) → Comprobar actualizaciones**. Debería aparecer
   "Detector de corte comercial" bajo **Add-ons locales**. Instálalo
   (la primera vez compila la imagen, tarda unos minutos).
3. Antes de arrancarlo, llena las **Opciones** del add-on (pestaña
   "Configuración"):
   - `go2rtc_url` / `stream`: lo que ya tienes funcionando (ej.
     `http://localhost:1984` y `mivideo` si go2rtc corre en el mismo
     host de red — o la IP LAN del Mini PC si no).
   - `signage_api`: tu dominio real (ej. `https://ds.venueprocrm.cloud`).
   - `signage_email` / `signage_password`: **crea un usuario dedicado**
     para este bot desde Equipo en el panel, rol `editor` alcanza (no
     hace falta `admin`) — así no compartes tu propia contraseña con un
     proceso automatizado.
   - `device_id`: el id de la pantalla — ábrela en el panel y mira la
     URL/red, o pide `GET /api/state` con tu sesión.
   - `promo_asset_id` / `promo_logo_asset_id`: sube el contenido en
     Biblioteca primero y toma sus ids ahí.
   - `promo_text`, `promo_layout` (`lower`/`split`/`full`), `muted_during_ad`.

## Calibrar (obligatorio antes de arrancar el loop normal)

El add-on necesita saber cómo se ve el "bug" del canal EN VIVO antes de
poder notar cuando desaparece. Con el add-on instalado pero corriendo el
modo calibración (no el loop normal):

```sh
# desde el add-on "Terminal & SSH" del Mini PC:
docker exec -it addon_local_ad_break_detector python3 detector.py --calibrate
```

Hazlo mientras la TV muestra la transmisión en vivo (no un comercial).
Repite la calibración cada vez que cambien de canal o de partido/liga, ya
que el bug cambia de posición o diseño entre transmisiones.

Si el `bug_roi` por defecto (`0.02,0.85,0.18,0.12` — esquina inferior
izquierda) no coincide con dónde está el logo/marcador en tu transmisión,
ajústalo en las Opciones del add-on: son 4 fracciones `x,y,w,h` (0 a 1)
del cuadro completo — puedes estimarlas mirando una captura de go2rtc
(su propia interfaz ya te la muestra en `http://<mini-pc>:1984`).

## Correr fuera de Home Assistant (para probar en tu máquina)

```sh
pip install -r requirements.txt
cp config.local.example.json config.local.json   # y edítalo
python3 detector.py --calibrate     # una vez, viendo la señal en vivo
python3 detector.py                 # loop normal
```

## Pruebas (sin red, sin go2rtc real)

```sh
python3 -m unittest test_heuristics.py -v
```

Cubren las funciones de visión puras (`heuristics.py`) y la máquina de
estados con histéresis (`state_machine.py`) con imágenes sintéticas —
no prueban la calidad real de detección contra un feed de cable de
verdad, eso solo se valida en campo.
