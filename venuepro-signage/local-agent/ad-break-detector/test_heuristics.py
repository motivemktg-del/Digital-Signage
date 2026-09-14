"""test_heuristics.py — pruebas sin red, sin go2rtc real: solo funciones
puras sobre imágenes sintéticas (PIL) y la máquina de estados. Correr con:
    python3 -m unittest test_heuristics.py -v
"""
import unittest
import numpy as np
from PIL import Image

from heuristics import (
    to_gray_downscaled, avg_luma, is_black_frame, crop_roi,
    hist_signature, hist_distance, frame_diff, CutRateCounter,
)
from state_machine import AdBreakStateMachine


def solid(color, size=(320, 180)):
    return Image.new('RGB', size, color)


class HeuristicsTests(unittest.TestCase):
    def test_black_frame_detected(self):
        gray = to_gray_downscaled(solid((0, 0, 0)))
        self.assertLess(avg_luma(gray), 5)
        self.assertTrue(is_black_frame(gray, threshold=24))

    def test_bright_frame_not_black(self):
        gray = to_gray_downscaled(solid((220, 220, 220)))
        self.assertFalse(is_black_frame(gray, threshold=24))

    def test_hist_distance_identical_is_zero(self):
        gray = to_gray_downscaled(solid((100, 140, 180)))
        patch = crop_roi(gray, (0.0, 0.0, 1.0, 1.0))
        sig = hist_signature(patch)
        self.assertAlmostEqual(hist_distance(sig, sig), 0.0, places=5)

    def test_hist_distance_different_patches_is_high(self):
        gray_dark = to_gray_downscaled(solid((10, 10, 10)))
        gray_bright = to_gray_downscaled(solid((250, 250, 250)))
        sig_dark = hist_signature(crop_roi(gray_dark, (0, 0, 1, 1)))
        sig_bright = hist_signature(crop_roi(gray_bright, (0, 0, 1, 1)))
        self.assertGreater(hist_distance(sig_dark, sig_bright), 0.8)

    def test_frame_diff_zero_for_identical_frames(self):
        gray = to_gray_downscaled(solid((128, 128, 128)))
        self.assertEqual(frame_diff(gray, gray), 0.0)

    def test_frame_diff_high_for_scene_cut(self):
        a = to_gray_downscaled(solid((0, 0, 0)))
        b = to_gray_downscaled(solid((255, 255, 255)))
        self.assertGreater(frame_diff(a, b), 200)

    def test_cut_rate_counter_window_expires(self):
        c = CutRateCounter(window_seconds=2.0, diff_threshold=50)
        c.add(now=0.0, diff=100)
        c.add(now=0.5, diff=100)
        self.assertEqual(c.rate(), 2)
        c.add(now=3.0, diff=100)  # los dos primeros ya salieron de la ventana de 2s
        self.assertEqual(c.rate(), 1)

    def test_cut_rate_counter_ignores_small_diffs(self):
        c = CutRateCounter(window_seconds=2.0, diff_threshold=50)
        c.add(now=0.0, diff=5)
        self.assertEqual(c.rate(), 0)


class StateMachineTests(unittest.TestCase):
    def test_stays_live_on_single_ad_like_frame(self):
        sm = AdBreakStateMachine(min_ad_seconds=3.0, min_live_seconds=3.0, votes_needed=2)
        event = sm.update(now=0.0, is_black_recent=True, bug_absent=True, high_cut_rate=False)
        self.assertIsNone(event)
        self.assertEqual(sm.state, 'LIVE')

    def test_switches_to_ad_after_sustained_signal(self):
        sm = AdBreakStateMachine(min_ad_seconds=3.0, min_live_seconds=3.0, votes_needed=2)
        self.assertIsNone(sm.update(now=0.0, is_black_recent=False, bug_absent=True, high_cut_rate=True))
        self.assertIsNone(sm.update(now=1.5, is_black_recent=False, bug_absent=True, high_cut_rate=True))
        event = sm.update(now=3.1, is_black_recent=False, bug_absent=True, high_cut_rate=True)
        self.assertEqual(event, 'AD_START')
        self.assertEqual(sm.state, 'AD')

    def test_flickering_signal_never_switches(self):
        sm = AdBreakStateMachine(min_ad_seconds=3.0, min_live_seconds=3.0, votes_needed=2)
        for t in range(10):
            looks_ad = t % 2 == 0
            event = sm.update(now=float(t), is_black_recent=looks_ad, bug_absent=looks_ad, high_cut_rate=False)
            self.assertIsNone(event)
        self.assertEqual(sm.state, 'LIVE')

    def test_switches_back_to_live_after_sustained_normal_signal(self):
        sm = AdBreakStateMachine(min_ad_seconds=1.0, min_live_seconds=1.0, votes_needed=2)
        self.assertIsNone(sm.update(now=0.0, is_black_recent=True, bug_absent=True, high_cut_rate=False))
        self.assertEqual(sm.update(now=1.1, is_black_recent=True, bug_absent=True, high_cut_rate=False), 'AD_START')
        self.assertIsNone(sm.update(now=1.2, is_black_recent=False, bug_absent=False, high_cut_rate=False))
        event = sm.update(now=2.3, is_black_recent=False, bug_absent=False, high_cut_rate=False)
        self.assertEqual(event, 'AD_END')
        self.assertEqual(sm.state, 'LIVE')


if __name__ == '__main__':
    unittest.main()
