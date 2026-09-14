"""Pruebas de las funciones puras de ptz_agent.py (sin red, sin tocar
/data — CameraSession.execute sí pega a la cámara real, eso se valida en
campo)."""
import unittest

from ptz_agent import clamp, normalize_onvif_url


class ClampTests(unittest.TestCase):
    def test_within_range_unchanged(self):
        self.assertEqual(clamp(0.4, -1, 1), 0.4)

    def test_clamps_above_and_below(self):
        self.assertEqual(clamp(5, -1, 1), 1)
        self.assertEqual(clamp(-5, -1, 1), -1)

    def test_non_numeric_falls_back_to_low(self):
        self.assertEqual(clamp('nope', -1, 1), -1)
        self.assertEqual(clamp(None, 0, 1), 0)


class NormalizeOnvifUrlTests(unittest.TestCase):
    def test_onvif_scheme_with_credentials_defaults_port_80_and_device_service_path(self):
        # Exactamente el formato que ya usan en go2rtc para esta cámara.
        url, auth = normalize_onvif_url('onvif://admin:secret@192.168.12.13')
        self.assertEqual(url, 'http://192.168.12.13:80/onvif/device_service')
        self.assertEqual(auth, ('admin', 'secret'))

    def test_explicit_port_is_kept(self):
        url, auth = normalize_onvif_url('onvif://admin:secret@192.168.12.13:8000')
        self.assertEqual(url, 'http://192.168.12.13:8000/onvif/device_service')

    def test_no_credentials_means_no_auth(self):
        url, auth = normalize_onvif_url('onvif://192.168.12.13')
        self.assertIsNone(auth)

    def test_explicit_path_is_preserved(self):
        url, _ = normalize_onvif_url('onvif://admin:secret@192.168.12.13/custom/device_service')
        self.assertEqual(url, 'http://192.168.12.13:80/custom/device_service')


if __name__ == '__main__':
    unittest.main()
