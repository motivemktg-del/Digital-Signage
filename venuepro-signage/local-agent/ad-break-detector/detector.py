"""detector.py — orquesta el detector de corte comercial: lee un cuadro de
go2rtc, saca las señales de heuristics.py, decide con state_machine.py, y
llama la API real de venuepro-signage (signage_client.py) para poner/quitar
la mezcla. Corre como loop infinito dentro del add-on de Home Assistant.

Dos modos:
  python3 detector.py --calibrate   # una vez, viendo la señal EN VIVO
  python3 detector.py               # loop normal (lo que corre el add-on)
"""
from __future__ import annotations
import argparse
import io
import json
import os
import sys
import time

import numpy as np
import requests
from PIL import Image

from heuristics import (
    to_gray_downscaled, is_black_frame, crop_roi, hist_signature,
    hist_distance, frame_diff, CutRateCounter,
)
from state_machine import AdBreakStateMachine
from signage_client import SignageClient

OPTIONS_PATH = '/data/options.json'  # convención de los add-ons de Home Assistant (Supervisor la genera)
REFERENCE_PATH = '/data/bug_reference.json'


def load_config() -> dict:
    if os.path.exists(OPTIONS_PATH):
        with open(OPTIONS_PATH) as f:
            cfg = json.load(f)
    else:
        # fuera de Home Assistant (pruebas en tu máquina): config.local.json junto a este archivo
        local = os.path.join(os.path.dirname(__file__), 'config.local.json')
        with open(local) as f:
            cfg = json.load(f)
    if isinstance(cfg.get('bug_roi'), str):
        cfg['bug_roi'] = tuple(float(v) for v in cfg['bug_roi'].split(','))
    return cfg


def fetch_frame(go2rtc_url: str, stream: str, timeout: float = 5.0) -> Image.Image:
    # go2rtc expone un JPEG suelto del último cuadro en /api/frame.jpeg —
    # no hace falta decodificar video, solo pedir la foto cuando toca.
    r = requests.get(f'{go2rtc_url}/api/frame.jpeg', params={'src': stream}, timeout=timeout)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content))


def calibrate(cfg: dict, seconds: float = 8.0) -> None:
    """Guarda cómo se ve el "bug" del canal (logo/marcador en una esquina)
    AHORA MISMO — hay que correrlo mientras la TV muestra la señal en vivo,
    no un comercial. Repetir cada vez que cambie de canal o de liga/deporte,
    porque el bug cambia de posición o diseño entre transmisiones."""
    print(f'Calibrando {seconds}s — confirma que se está viendo la señal EN VIVO (no un comercial)...')
    sigs = []
    end = time.time() + seconds
    while time.time() < end:
        try:
            img = fetch_frame(cfg['go2rtc_url'], cfg['stream'])
            gray = to_gray_downscaled(img)
            sigs.append(hist_signature(crop_roi(gray, cfg['bug_roi'])))
        except Exception as e:
            print('  (cuadro fallido, se ignora):', e)
        time.sleep(0.5)
    if not sigs:
        print('No se pudo leer ningún cuadro de go2rtc — revisa go2rtc_url/stream en la configuración del add-on.')
        sys.exit(1)
    reference = np.mean(sigs, axis=0).tolist()
    os.makedirs(os.path.dirname(REFERENCE_PATH), exist_ok=True)
    with open(REFERENCE_PATH, 'w') as f:
        json.dump(reference, f)
    print(f'Listo — referencia guardada en {REFERENCE_PATH} ({len(sigs)} cuadros promediados).')


def run(cfg: dict) -> None:
    if not os.path.exists(REFERENCE_PATH):
        print('Falta calibrar primero: corre "python3 detector.py --calibrate" viendo la señal en vivo.')
        sys.exit(1)
    with open(REFERENCE_PATH) as f:
        reference = np.array(json.load(f), dtype=np.float32)

    client = SignageClient(cfg['signage_api'], cfg['signage_email'], cfg['signage_password'])
    sm = AdBreakStateMachine(
        min_ad_seconds=cfg.get('min_ad_seconds', 3.0),
        min_live_seconds=cfg.get('min_live_seconds', 3.0),
        votes_needed=cfg.get('votes_needed', 2),
    )
    cut_counter = CutRateCounter(cfg.get('cutrate_window_seconds', 4.0), cfg.get('cutrate_diff_threshold', 40.0))

    prev_gray = None
    last_black_at = None
    poll_interval = cfg.get('poll_interval_ms', 700) / 1000.0

    print('Agente de detección de corte comercial arrancado. Ctrl+C para salir.')
    while True:
        now = time.time()
        try:
            img = fetch_frame(cfg['go2rtc_url'], cfg['stream'])
            gray = to_gray_downscaled(img)

            if is_black_frame(gray, cfg.get('black_luma_threshold', 24.0)):
                last_black_at = now
            is_black_recent = last_black_at is not None and (now - last_black_at) <= 1.5

            bug_absent = hist_distance(hist_signature(crop_roi(gray, cfg['bug_roi'])), reference) > cfg.get('bug_diff_threshold', 0.35)

            if prev_gray is not None:
                cut_counter.add(now, frame_diff(gray, prev_gray))
            prev_gray = gray
            high_cut_rate = cut_counter.rate() >= cfg.get('cutrate_cuts_threshold', 3)

            event = sm.update(now, is_black_recent, bug_absent, high_cut_rate)
            if event == 'AD_START':
                print(f'[{time.strftime("%H:%M:%S")}] -> corte comercial detectado: mostrando tu promo.')
                client.set_mix(cfg['device_id'], cfg.get('promo_layout', 'full'), cfg.get('promo_asset_id') or None,
                                cfg.get('promo_logo_asset_id') or None, cfg.get('promo_text', ''), cfg.get('muted_during_ad', False))
            elif event == 'AD_END':
                print(f'[{time.strftime("%H:%M:%S")}] -> señal en vivo de vuelta: quitando la mezcla.')
                client.clear_mix(cfg['device_id'])
        except Exception as e:
            print('Error en el ciclo de detección (se reintenta):', e)
        time.sleep(poll_interval)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Detector de corte comercial para venuepro-signage.')
    parser.add_argument('--calibrate', action='store_true')
    parser.add_argument('--calibrate-seconds', type=float, default=8.0)
    args = parser.parse_args()
    config = load_config()
    calibrate(config, args.calibrate_seconds) if args.calibrate else run(config)
