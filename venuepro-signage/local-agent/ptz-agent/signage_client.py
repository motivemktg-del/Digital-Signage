"""signage_client.py — cliente mínimo de la API real de venuepro-signage
(server.js) para este agente: inicia sesión como el usuario configurado
y llama /api/ptz-cameras — el mismo endpoint que ya usa el panel web
(public/mobile/) — para leer el buzón de comandos (command/command_seq)
de cada cámara PTZ del tenant.
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

    def list_ptz_cameras(self):
        return self._request('GET', '/api/ptz-cameras')
