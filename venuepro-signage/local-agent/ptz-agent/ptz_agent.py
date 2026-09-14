"""ptz_agent.py — ejecuta de verdad los comandos PTZ que el panel de
venuepro-signage guarda como "buzón" (ver /api/ptz-cameras/:id/command en
server.js): sin este agente, mover la cruceta/zoom/encuadres en el panel
solo guarda la intención, no mueve nada físico (ver la nota en store.js
sobre command/command_seq). Corre en la misma LAN que las cámaras (add-on
de Home Assistant en la Mini PC) y habla ONVIF PTZ directo con cada
cámara — go2rtc NO participa acá, eso es solo para el VIDEO; el control
de movimiento es un protocolo aparte (ver README.md).

Un solo add-on cubre TODAS las cámaras PTZ del tenant que tengan
onvif_url configurada en el panel — no hace falta reconfigurar el add-on
por cámara, ya que la URL (con user:pass embebidos, igual que el
onvif:// que ya usan en go2rtc) se guarda ahí.
"""
from __future__ import annotations
import json
import os
import time
from urllib.parse import urlsplit, urlunsplit

import onvif_client as onvif
from signage_client import SignageClient

OPTIONS_PATH = '/data/options.json'  # convención de los add-ons de Home Assistant (Supervisor la genera)
SEEN_PATH = '/data/ptz_seen.json'    # último command_seq YA ejecutado por cámara — sobrevive reinicios del add-on


def load_config() -> dict:
    if os.path.exists(OPTIONS_PATH):
        with open(OPTIONS_PATH) as f:
            return json.load(f)
    # fuera de Home Assistant (pruebas en tu máquina): config.local.json junto a este archivo
    local = os.path.join(os.path.dirname(__file__), 'config.local.json')
    with open(local) as f:
        return json.load(f)


def load_seen() -> dict:
    if os.path.exists(SEEN_PATH):
        try:
            with open(SEEN_PATH) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_seen(seen: dict) -> None:
    os.makedirs(os.path.dirname(SEEN_PATH), exist_ok=True)
    with open(SEEN_PATH, 'w') as f:
        json.dump(seen, f)


def normalize_onvif_url(onvif_url: str) -> tuple[str, tuple[str, str] | None]:
    """El panel guarda la MISMA convención que ya usan en go2rtc:
    'onvif://user:pass@host[:puerto]' (con o sin puerto — varía por
    cámara). Acá se traduce a la URL http real del servicio "device" de
    ONVIF: se cambia el esquema a http, se usa el puerto 80 si no viene
    ninguno (confirmado para la Amcrest IP2M-841W-V3: su device_service
    vive en el puerto 80), y si no trae ruta se asume '/onvif/device_service'
    (la ruta estándar, también confirmada para esta cámara). Devuelve
    (url_limpia_sin_credenciales, (user,pass)|None)."""
    parts = urlsplit(onvif_url)
    scheme = 'http' if parts.scheme in ('onvif', '') else parts.scheme
    host = parts.hostname or parts.path  # por si alguien pega solo la IP sin esquema
    port = parts.port or 80
    netloc = f'{host}:{port}'
    path = parts.path if parts.scheme else ''
    if not path or path == '/':
        path = '/onvif/device_service'
    clean = urlunsplit((scheme, netloc, path, '', ''))
    auth = (parts.username, parts.password or '') if parts.username else None
    return clean, auth


def clamp(value, lo: float, hi: float) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return lo
    return max(lo, min(hi, value))


class CameraSession:
    """Cachea lo que NO cambia entre comandos de la misma cámara (los
    XAddr reales de Media/PTZ + el token del primer perfil) — pedirlo de
    nuevo en cada tap de la cruceta serían 2-3 llamadas SOAP extra por
    cada comando, sin necesidad."""

    def __init__(self, onvif_url: str):
        self.device_url, self.auth = normalize_onvif_url(onvif_url)
        self.ptz_xaddr: str | None = None
        self.profile_token: str | None = None

    def ensure_ready(self) -> None:
        if self.ptz_xaddr and self.profile_token:
            return
        caps = onvif.get_capabilities(self.device_url, self.auth)
        # Si la cámara no separa PTZ/Media del device_service (pasa en
        # algunas marcas baratas), caps vendrá vacío — se usa el mismo
        # device_url como último recurso en vez de fallar directo.
        media_xaddr = caps.get('Media', self.device_url)
        self.ptz_xaddr = caps.get('PTZ', self.device_url)
        self.profile_token = onvif.get_first_profile_token(media_xaddr, self.auth)

    def execute(self, cmd_type: str, payload: dict, cfg: dict) -> None:
        self.ensure_ready()
        if cmd_type == 'home':
            onvif.goto_home_position(self.ptz_xaddr, self.auth, self.profile_token)
        elif cmd_type == 'preset':
            pan = clamp(payload.get('pan', 0), -1, 1)
            tilt = clamp(payload.get('tilt', 0), -1, 1)
            zoom = clamp(payload.get('zoom', 0), 0, 1)
            onvif.absolute_move(self.ptz_xaddr, self.auth, self.profile_token, pan, tilt, zoom)
        elif cmd_type == 'nudge':
            # El panel manda un tap discreto (dx/dy), no un press-and-hold
            # continuo — así que se traduce a un "empujón": mover a
            # velocidad fija un ratito corto y frenar, en vez de dejarla
            # moviéndose para siempre.
            dx = clamp(payload.get('dx', 0), -1, 1)
            dy = clamp(payload.get('dy', 0), -1, 1)
            speed = cfg.get('nudge_speed', 0.5)
            onvif.continuous_move(self.ptz_xaddr, self.auth, self.profile_token, pan=dx * speed, tilt=dy * speed, zoom=0)
            time.sleep(cfg.get('nudge_seconds', 0.3))
            onvif.stop(self.ptz_xaddr, self.auth, self.profile_token)
        elif cmd_type == 'zoom':
            delta = clamp(payload.get('delta', 0), -1, 1)
            speed = cfg.get('zoom_speed', 0.5)
            onvif.continuous_move(self.ptz_xaddr, self.auth, self.profile_token, pan=0, tilt=0, zoom=delta * speed)
            time.sleep(cfg.get('zoom_seconds', 0.4))
            onvif.stop(self.ptz_xaddr, self.auth, self.profile_token)
        else:
            raise ValueError(f'Comando desconocido: {cmd_type}')


def run(cfg: dict) -> None:
    client = SignageClient(cfg['signage_api'], cfg['signage_email'], cfg['signage_password'])
    seen = load_seen()
    sessions: dict[str, CameraSession] = {}
    poll_interval = cfg.get('poll_interval_ms', 500) / 1000.0

    print('Agente de control PTZ (ONVIF) arrancado. Ctrl+C para salir.')
    while True:
        try:
            cams = client.list_ptz_cameras()
            for cam in cams:
                onvif_url = cam.get('onvif_url')
                if not onvif_url:
                    continue  # cámara solo de video, sin control configurado
                cam_id = cam['id']
                seq = cam.get('command_seq') or 0
                cmd = cam.get('command')
                if not cmd or seq == seen.get(cam_id, 0):
                    continue  # nada nuevo desde la última vuelta
                session = sessions.get(cam_id)
                if session is None or session.device_url != normalize_onvif_url(onvif_url)[0]:
                    session = CameraSession(onvif_url)  # primera vez, o editaron la URL de la cámara
                    sessions[cam_id] = session
                try:
                    session.execute(cmd['type'], cmd.get('payload') or {}, cfg)
                    seen[cam_id] = seq
                    save_seen(seen)
                    print(f'[{time.strftime("%H:%M:%S")}] {cam.get("name", "?")}: {cmd["type"]} ejecutado.')
                except Exception as e:
                    print(f'[{time.strftime("%H:%M:%S")}] {cam.get("name", "?")}: no se pudo ejecutar {cmd.get("type")}: {e}')
                    sessions.pop(cam_id, None)  # fuerza re-descubrir XAddrs/perfil por si fue la sesión/red
        except Exception as e:
            print('Error consultando el panel (se reintenta):', e)
        time.sleep(poll_interval)


if __name__ == '__main__':
    run(load_config())
