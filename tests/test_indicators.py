import numpy as np
import pandas as pd

from twstock import indicators as ind
from twstock.data import demo_data
from datetime import date


def _df():
    return demo_data("2330", date(2023, 1, 1), date(2024, 12, 31))


def test_sma_and_ema():
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    assert ind.sma(s, 3).tolist()[2:] == [2, 3, 4]
    assert np.isnan(ind.sma(s, 3).iloc[1])
    assert ind.ema(s, 2).iloc[-1] > ind.sma(s, 2).iloc[-1] - 1


def test_rsi_extremes_and_range():
    up = pd.Series(np.arange(1, 40, dtype=float))
    assert ind.rsi(up, 14).iloc[-1] == 100
    r = ind.rsi(_df()["close"]).dropna()
    assert ((r >= 0) & (r <= 100)).all()


def test_kd_bounded_and_starts_after_window():
    k = ind.kd(_df())
    assert k["k"].iloc[:8].isna().all()
    valid = k.dropna()
    assert ((valid >= 0) & (valid <= 100)).all().all()


def test_macd_hist_is_dif_minus_signal():
    m = ind.macd(_df()["close"]).dropna()
    assert np.allclose(m["hist"], m["dif"] - m["signal"])


def test_crosses():
    a = pd.Series([1, 2, 3, 2, 1], dtype=float)
    b = pd.Series([2, 2, 2, 2, 2], dtype=float)
    assert ind.crossed_above(a, b).tolist() == [False, False, True, False, False]
    assert ind.crossed_below(a, b).tolist() == [False, False, False, False, True]
