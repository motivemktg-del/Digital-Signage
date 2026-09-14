"""state_machine.py — decide EN_VIVO vs EN_COMERCIAL a partir de las
señales de heuristics.py, con histéresis (tiempo mínimo sostenido antes de
cambiar) para no parpadear cada vez que una jugada real tiene un cuadro
oscuro o un corte de cámara rápido.

Uso: cada "tick" (un cuadro analizado) se llama update(...) con las señales
de ESE cuadro; devuelve 'AD_START' o 'AD_END' solo en el instante exacto en
que el estado realmente cambia — el resto de los ticks devuelve None.
"""
from __future__ import annotations


class AdBreakStateMachine:
    LIVE = 'LIVE'
    AD = 'AD'

    def __init__(self, min_ad_seconds: float = 3.0, min_live_seconds: float = 3.0,
                 votes_needed: int = 2):
        """votes_needed: cuántas de las señales booleanas (is_black_recent,
        bug_absent, high_cut_rate) tienen que estar activas en un cuadro
        para contarlo como "parece comercial" ese cuadro."""
        self.min_ad_seconds = min_ad_seconds
        self.min_live_seconds = min_live_seconds
        self.votes_needed = votes_needed
        self.state = self.LIVE
        self._since = None  # marca de tiempo desde que empezó a verse distinto al estado actual

    def update(self, now: float, is_black_recent: bool, bug_absent: bool, high_cut_rate: bool) -> str | None:
        votes = sum([is_black_recent, bug_absent, high_cut_rate])
        looks_like_ad = votes >= self.votes_needed

        if self.state == self.LIVE:
            if looks_like_ad:
                if self._since is None:
                    self._since = now
                elif now - self._since >= self.min_ad_seconds:
                    self.state = self.AD
                    self._since = None
                    return 'AD_START'
            else:
                self._since = None
        else:  # self.state == self.AD
            if not looks_like_ad:
                if self._since is None:
                    self._since = now
                elif now - self._since >= self.min_live_seconds:
                    self.state = self.LIVE
                    self._since = None
                    return 'AD_END'
            else:
                self._since = None
        return None
