"""signage_client.py — cliente mínimo de la API real de venuepro-signage
(server.js) para este agente: solo necesita iniciar sesión como admin del
tenant y llamar /api/devices/:id/mix — el mismo endpoint que usa el panel
web (public/mobile/), así que todo lo que ya vale ahí (validación de
assets, requiere live_source activo, sube revision) aplica igual aquí.
"""
from __future__ import annotations
import requests


class SignageClient:
    def __init__(self, base_url: str, email: str, password: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip('/')
        self.email = email
        self.password = password
        self.timeout = timeout
        self.session = requests.Session()
        self._login()

    def _login(self) -> None:
        r = self.session.post(f'{self.base_url}/api/login', json={'email': self.email, 'password': self.password}, timeout=self.timeout)
        r.raise_for_status()

    def _request(self, method: str, path: str, **kwargs):
        r = self.session.request(method, f'{self.base_url}{path}', timeout=self.timeout, **kwargs)
        if r.status_code == 401:
            # la sesión (cookie sid) dura 12h en server.js — si expiró, entra de nuevo y reintenta una vez
            self._login()
            r = self.session.request(method, f'{self.base_url}{path}', timeout=self.timeout, **kwargs)
        r.raise_for_status()
        return r.json() if r.content else None

    def set_mix(self, device_id: str, layout: str, promo: str | None, logo: str | None, text: str, muted: bool):
        body = {'layout': layout, 'promo': promo, 'logo': logo, 'text': text, 'muted': muted}
        return self._request('POST', f'/api/devices/{device_id}/mix', json=body)

    def clear_mix(self, device_id: str):
        return self._request('POST', f'/api/devices/{device_id}/mix', json={'clear': True})
