"""真實資料中，行情（MI_INDEX）有些代號不在法人資料（T86）中，例如受益證券 01001T。"""
from datetime import date, timedelta

import pandas as pd

from twstock import market as M
from twstock import picks
from twstock import screener as S


def _window(n=11):
    out = []
    d = date(2026, 10, 1)
    for i in range(n):
        d += timedelta(days=1)
        q = pd.DataFrame([
            {"code": "2330", "name": "台積電", "volume": 3e7, "value": 3e10, "open": 1000 + i, "high": 1010 + i, "low": 990 + i, "close": 1000 + i},
            {"code": "01001T", "name": "受益證券", "volume": 1e5, "value": 1e6, "open": 10, "high": 10, "low": 10, "close": 10},
        ])
        inst = pd.DataFrame([{"code": "2330", "name": "台積電", "foreign": 1e6, "trust": 2e5, "dealer": 0, "inst": 1.2e6}])
        out.append((d, q, inst))
    return out


def test_build_table_with_codes_missing_from_institutional(monkeypatch):
    monkeypatch.setattr(M, "get_window", lambda market, days, use_demo=False: _window(days))
    table, dates = S.build_table("twse", 10, use_demo=True)
    t = table.set_index("code")
    assert t.loc["2330", "trust_streak"] == 10 and t.loc["2330", "trust_net"] == 2000
    assert t.loc["01001T", "trust_streak"] == 0 and pd.isna(t.loc["01001T", "trust_net"])


def test_picks_with_codes_missing_from_institutional(monkeypatch):
    monkeypatch.setattr(M, "get_window", lambda market, days, use_demo=False: _window(days))
    picks._cache.clear()
    r = picks.compute(use_demo=True)
    assert all(p["code"] != "01001T" for p in r["picks"])
    picks._cache.clear()


def test_one_bad_stock_does_not_break_picks(monkeypatch):
    from twstock import models
    real = models.evaluate_all
    bad = {}

    def flaky(df, fund, bench):
        if not bad:  # 第一檔候選股故意出錯
            bad["hit"] = True
            raise KeyError("壞資料")
        return real(df, fund, bench)
    monkeypatch.setattr(picks.M, "evaluate_all", flaky)
    picks._cache.clear()
    r = picks.compute(use_demo=True)
    assert bad and len(r["picks"]) == 5
    picks._cache.clear()
