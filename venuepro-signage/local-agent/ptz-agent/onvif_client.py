"""onvif_client.py — cliente ONVIF PTZ mínimo, escrito a mano (sin
librerías tipo onvif-zeep que dependen de WSDL empaquetados) porque solo
necesitamos 5 operaciones puntuales, no el estándar completo:

  GetCapabilities (Device) -> XAddr real de Media y PTZ (varían por marca:
    en la Amcrest IP2M-841W-V3, por ejemplo, viven en /onvif/media_service
    y /onvif/ptz_service, NO en la misma URL que /onvif/device_service).
  GetProfiles (Media) -> token del primer perfil, lo que piden todas las
    operaciones PTZ para saber DE QUÉ perfil de video hablamos.
  ContinuousMove / Stop / AbsoluteMove / GotoHomePosition (PTZ).

Las funciones que solo PARSEAN xml (parse_capabilities/parse_profile_token)
están separadas de las que hacen red (_soap_call) para poder probarlas
sin mockear HTTP — ver test_onvif_client.py.

Autenticación: se manda TANTO HTTP Digest (auth= en requests) COMO un
header WS-Security UsernameToken con digest de contraseña dentro del
SOAP — no sabemos de antemano cuál de los dos exige una cámara dada
(varía por firmware, incluso entre cámaras Amcrest — ver el hilo del
foro de Amcrest sobre "ONVIF authentication not working in newer
cameras"), y mandar ambos no rompe nada en la que solo revisa uno.
"""
from __future__ import annotations
import base64
import hashlib
import os
import time
import xml.etree.ElementTree as ET

import requests
from requests.auth import HTTPDigestAuth

DEVICE_NS = 'http://www.onvif.org/ver10/device/wsdl'
MEDIA_NS = 'http://www.onvif.org/ver10/media/wsdl'
PTZ_NS = 'http://www.onvif.org/ver10/ptz/wsdl'
SCHEMA_NS = 'http://www.onvif.org/ver10/schema'


def _local(tag: str) -> str:
    """'{http://...}Foo' -> 'Foo' — para comparar tags sin pelear con el
    namespace/prefix exacto que use el firmware de turno."""
    return tag.rsplit('}', 1)[-1] if '}' in tag else tag


def _find_all(root: ET.Element, name: str) -> list[ET.Element]:
    return [el for el in root.iter() if _local(el.tag) == name]


def ws_security_header(username: str, password: str) -> str:
    """UsernameToken con PasswordDigest, como pide ONVIF Core Spec §5.12.2.1:
    digest = Base64(SHA1(nonce + created + password)), nonce en binario
    crudo (no el base64) concatenado con el timestamp en texto."""
    created = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    nonce = os.urandom(16)
    digest = base64.b64encode(hashlib.sha1(nonce + created.encode('utf-8') + password.encode('utf-8')).digest()).decode('ascii')
    nonce_b64 = base64.b64encode(nonce).decode('ascii')
    return (
        '<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
        'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
        f'<UsernameToken><Username>{username}</Username>'
        '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
        f'{digest}</Password>'
        '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
        f'{nonce_b64}</Nonce>'
        f'<wsu:Created>{created}</wsu:Created></UsernameToken></Security>'
    )


def parse_capabilities(xml_bytes: bytes) -> dict:
    """De la respuesta de GetCapabilities, saca {'Media': xaddr, 'PTZ': xaddr}
    (las que falten no vienen — cámara sin ese servicio)."""
    root = ET.fromstring(xml_bytes)
    result = {}
    for category in ('Media', 'PTZ'):
        for el in _find_all(root, category):
            xaddr_els = _find_all(el, 'XAddr')
            if xaddr_els and xaddr_els[0].text:
                result[category] = xaddr_els[0].text.strip()
                break
    return result


def parse_profile_token(xml_bytes: bytes) -> str:
    """Del primer <Profiles token="..."> de GetProfiles."""
    root = ET.fromstring(xml_bytes)
    profiles = _find_all(root, 'Profiles')
    if not profiles:
        raise RuntimeError('La cámara no devolvió ningún perfil (GetProfiles vacío).')
    token = profiles[0].get('token')
    if not token:
        raise RuntimeError('El primer perfil de la cámara no trae "token".')
    return token


def _soap_call(url: str, auth, body: str, timeout: float = 8.0) -> bytes:
    header = ''
    http_auth = None
    if auth:
        username, password = auth
        header = f'<s:Header>{ws_security_header(username, password)}</s:Header>'
        http_auth = HTTPDigestAuth(username, password)
    envelope = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
        f'{header}<s:Body>{body}</s:Body></s:Envelope>'
    )
    r = requests.post(
        url, data=envelope.encode('utf-8'),
        headers={'Content-Type': 'application/soap+xml; charset=utf-8'},
        auth=http_auth, timeout=timeout,
    )
    r.raise_for_status()
    return r.content


def get_capabilities(device_url: str, auth) -> dict:
    body = f'<GetCapabilities xmlns="{DEVICE_NS}"><Category>All</Category></GetCapabilities>'
    return parse_capabilities(_soap_call(device_url, auth, body))


def get_first_profile_token(media_xaddr: str, auth) -> str:
    body = f'<GetProfiles xmlns="{MEDIA_NS}"/>'
    return parse_profile_token(_soap_call(media_xaddr, auth, body))


def continuous_move(ptz_xaddr: str, auth, profile_token: str, pan: float = 0.0, tilt: float = 0.0, zoom: float = 0.0) -> None:
    body = (
        f'<ContinuousMove xmlns="{PTZ_NS}"><ProfileToken>{profile_token}</ProfileToken>'
        f'<Velocity><PanTilt x="{pan}" y="{tilt}" xmlns="{SCHEMA_NS}"/>'
        f'<Zoom x="{zoom}" xmlns="{SCHEMA_NS}"/></Velocity></ContinuousMove>'
    )
    _soap_call(ptz_xaddr, auth, body)


def stop(ptz_xaddr: str, auth, profile_token: str) -> None:
    body = f'<Stop xmlns="{PTZ_NS}"><ProfileToken>{profile_token}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>'
    _soap_call(ptz_xaddr, auth, body)


def absolute_move(ptz_xaddr: str, auth, profile_token: str, pan: float, tilt: float, zoom: float) -> None:
    body = (
        f'<AbsoluteMove xmlns="{PTZ_NS}"><ProfileToken>{profile_token}</ProfileToken>'
        f'<Position><PanTilt x="{pan}" y="{tilt}" xmlns="{SCHEMA_NS}"/>'
        f'<Zoom x="{zoom}" xmlns="{SCHEMA_NS}"/></Position></AbsoluteMove>'
    )
    _soap_call(ptz_xaddr, auth, body)


def goto_home_position(ptz_xaddr: str, auth, profile_token: str) -> None:
    body = f'<GotoHomePosition xmlns="{PTZ_NS}"><ProfileToken>{profile_token}</ProfileToken></GotoHomePosition>'
    _soap_call(ptz_xaddr, auth, body)
