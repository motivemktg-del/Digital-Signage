"""Pruebas de las funciones PURAS de onvif_client.py (parseo de XML y el
header WS-Security) — sin red, sin mockear HTTP. Lo que sí pega a una
cámara real (_soap_call y las funciones que lo envuelven) solo se valida
en campo, como aclara el README."""
import base64
import unittest

import onvif_client as onvif

GET_CAPABILITIES_RESPONSE = b'''<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <tds:GetCapabilitiesResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
      <tds:Capabilities>
        <tt:Media xmlns:tt="http://www.onvif.org/ver10/schema">
          <tt:XAddr>http://192.168.12.13/onvif/media_service</tt:XAddr>
        </tt:Media>
        <tt:PTZ xmlns:tt="http://www.onvif.org/ver10/schema">
          <tt:XAddr>http://192.168.12.13/onvif/ptz_service</tt:XAddr>
        </tt:PTZ>
      </tds:Capabilities>
    </tds:GetCapabilitiesResponse>
  </s:Body>
</s:Envelope>'''

GET_CAPABILITIES_NO_PTZ = b'''<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <tds:GetCapabilitiesResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
      <tds:Capabilities>
        <tt:Media xmlns:tt="http://www.onvif.org/ver10/schema">
          <tt:XAddr>http://192.168.12.13/onvif/media_service</tt:XAddr>
        </tt:Media>
      </tds:Capabilities>
    </tds:GetCapabilitiesResponse>
  </s:Body>
</s:Envelope>'''

GET_PROFILES_RESPONSE = b'''<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <trt:GetProfilesResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
      <trt:Profiles xmlns:tt="http://www.onvif.org/ver10/schema" token="Profile_1" fixed="true">
        <tt:Name>MainStream</tt:Name>
      </trt:Profiles>
      <trt:Profiles xmlns:tt="http://www.onvif.org/ver10/schema" token="Profile_2" fixed="true">
        <tt:Name>SubStream</tt:Name>
      </trt:Profiles>
    </trt:GetProfilesResponse>
  </s:Body>
</s:Envelope>'''

GET_PROFILES_EMPTY = b'''<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <trt:GetProfilesResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>
  </s:Body>
</s:Envelope>'''


class ParseCapabilitiesTests(unittest.TestCase):
    def test_extracts_media_and_ptz_xaddr(self):
        caps = onvif.parse_capabilities(GET_CAPABILITIES_RESPONSE)
        self.assertEqual(caps['Media'], 'http://192.168.12.13/onvif/media_service')
        self.assertEqual(caps['PTZ'], 'http://192.168.12.13/onvif/ptz_service')

    def test_missing_ptz_is_simply_absent(self):
        caps = onvif.parse_capabilities(GET_CAPABILITIES_NO_PTZ)
        self.assertIn('Media', caps)
        self.assertNotIn('PTZ', caps)


class ParseProfileTokenTests(unittest.TestCase):
    def test_returns_first_profile_token(self):
        self.assertEqual(onvif.parse_profile_token(GET_PROFILES_RESPONSE), 'Profile_1')

    def test_raises_on_empty_profiles(self):
        with self.assertRaises(RuntimeError):
            onvif.parse_profile_token(GET_PROFILES_EMPTY)


class WsSecurityHeaderTests(unittest.TestCase):
    def test_contains_expected_fields_and_valid_digest(self):
        header = onvif.ws_security_header('admin', 'secret123')
        self.assertIn('<Username>admin</Username>', header)
        self.assertIn('<wsu:Created>', header)
        digest_start = header.index('PasswordDigest">') + len('PasswordDigest">')
        digest = header[digest_start:header.index('</Password>')]
        # SHA1 son 20 bytes -> 28 caracteres en base64 (con relleno)
        self.assertEqual(len(base64.b64decode(digest)), 20)

    def test_nonce_changes_between_calls(self):
        h1 = onvif.ws_security_header('admin', 'secret123')
        h2 = onvif.ws_security_header('admin', 'secret123')
        self.assertNotEqual(h1, h2)  # nonce (y por lo tanto el digest) debe variar cada vez


class LocalTagTests(unittest.TestCase):
    def test_strips_namespace(self):
        self.assertEqual(onvif._local('{http://www.onvif.org/ver10/schema}PTZ'), 'PTZ')
        self.assertEqual(onvif._local('PTZ'), 'PTZ')


if __name__ == '__main__':
    unittest.main()
