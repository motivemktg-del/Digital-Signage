"""heuristics.py — funciones puras de visión (sin red, sin estado global) que
detectan "esto probablemente es un corte comercial" mirando cuadros sueltos
de la señal en vivo. Cada función es chica y comprobable por separado
(ver test_heuristics.py) — el orquestador con estado vive en detector.py.

Ninguna heurística sola es confiable (un cuadro negro también pasa en un
apagón de estadio; una escena con muchos cortes también pasa en un gol).
Por eso detector.py combina 2-3 de estas señales con un mínimo de tiempo
sostenido (debounce) antes de decidir que sí cambió de estado — igual que
hace go2rtc/cualquier detector de silencio de audio real.
"""
from __future__ import annotations
import numpy as np
from PIL import Image


def to_gray_downscaled(img: Image.Image, size=(160, 90)) -> np.ndarray:
    """Cuadro completo -> escala de grises chica (rápido de comparar)."""
    small = img.convert('L').resize(size, Image.BILINEAR)
    return np.asarray(small, dtype=np.float32)


def avg_luma(gray: np.ndarray) -> float:
    """Brillo promedio 0-255. Bajo = cuadro casi negro (típico al entrar/
    salir de un corte, dura 1-3 cuadros nada más)."""
    return float(gray.mean())


def is_black_frame(gray: np.ndarray, threshold: float = 24.0) -> bool:
    return avg_luma(gray) < threshold


def crop_roi(gray: np.ndarray, roi) -> np.ndarray:
    """roi = (x, y, w, h) como fracción 0..1 del cuadro — recorta, p.ej.,
    la esquina donde vive el "bug" (logo del canal / marcador del juego)."""
    h, w = gray.shape
    x0, y0, rw, rh = roi
    x1, y1 = int(x0 * w), int(y0 * h)
    x2, y2 = int((x0 + rw) * w), int((y0 + rh) * h)
    return gray[max(0, y1):max(1, y2), max(0, x1):max(1, x2)]


def hist_signature(patch: np.ndarray, bins: int = 8) -> np.ndarray:
    """Histograma normalizado (suma 1) de una región — resumen barato de
    "cómo se ve" esa zona sin importar el detalle exacto de cada pixel."""
    hist, _ = np.histogram(patch, bins=bins, range=(0, 255))
    total = hist.sum()
    return hist.astype(np.float32) / total if total else hist.astype(np.float32)


def hist_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Distancia L1 / 2, en 0..1. 0 = idéntico, 1 = totalmente distinto.
    Se usa para decidir si el "bug" de canal sigue en su lugar (transmisión
    en vivo) o desapareció/cambió (típico de un corte comercial)."""
    return float(np.abs(a - b).sum() / 2)


def frame_diff(gray_a: np.ndarray, gray_b: np.ndarray) -> float:
    """Diferencia media absoluta entre dos cuadros consecutivos — un valor
    alto es un corte de plano/cambio de toma."""
    return float(np.abs(gray_a - gray_b).mean())


class CutRateCounter:
    """Cuenta "cortes de plano" (frame_diff por encima de un umbral) dentro
    de una ventana deslizante de tiempo — los comerciales suelen editar
    mucho más rápido que una jugada en vivo, así que una tasa alta y
    sostenida es una señal (débil por sí sola) de que empezó un corte."""

    def __init__(self, window_seconds: float, diff_threshold: float):
        self.window = window_seconds
        self.diff_threshold = diff_threshold
        self._events: list[float] = []  # timestamps de cortes detectados

    def add(self, now: float, diff: float) -> None:
        if diff >= self.diff_threshold:
            self._events.append(now)
        cutoff = now - self.window
        self._events = [t for t in self._events if t >= cutoff]

    def rate(self) -> int:
        """Cuántos cortes de plano hay registrados en la ventana actual."""
        return len(self._events)
