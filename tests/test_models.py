import numpy as np
import pandas as pd
import pytest

from twstock import fundamentals as F
from twstock import models as M
from twstock import screener as S


def _frame(closes):
    idx = pd.bdate_range("2024-01-01", periods=len(closes))
    c = pd.Series(closes, index=idx, dtype=float)
    return pd.DataFrame({"open": c, "high": c * 1.005, "low": c * 0.995, "close": c, "volume": 1e6})


UP = _frame(100 * np.exp(np.linspace(0, 0.9, 300)))       # 穩定上漲
DOWN = _frame(100 * np.exp(np.linspace(0, -0.6, 300)))    # 穩定下跌
FLAT = _frame(np.full(300, 100.0)).close


def test_minervini():
    r = M.minervini(UP, FLAT)
    assert r.passed and r.detail["passed"] == 8 and r.score == 3
    d = M.minervini(DOWN, FLAT)
    assert not d.passed and d.detail["passed"] <= 2 and d.score == 0
    assert not M.minervini(UP.iloc[-100:], FLAT).passed  # 資料不足


def test_momentum_12_1():
    assert M.momentum_12_1(UP, FLAT).passed
    assert not M.momentum_12_1(DOWN, FLAT).passed
    assert not M.momentum_12_1(UP, UP.close * 2 ** np.linspace(0, 2, 300)).passed  # 輸給大盤


def test_revenue_and_value():
    assert M.revenue_growth({"rev_yoy": 35, "rev_cum_yoy": 15}).passed
    assert not M.revenue_growth({"rev_yoy": 35, "rev_cum_yoy": 2}).passed
    bad = M.revenue_growth({"rev_yoy": -40, "rev_cum_yoy": -10})
    assert bad.score < 0 and bad.risks
    assert M.value_yield({"pe": 10, "dividend_yield": 6}).passed
    assert not M.value_yield({"pe": -5, "dividend_yield": 6}).passed  # 虧損公司本益比無意義
    assert M.value_yield({"pe": 80, "dividend_yield": 0.5}).score < 0
    assert not M.revenue_growth(None).passed and not M.value_yield(None).passed


@pytest.mark.parametrize("keys", [
    ("公司代號", "營業收入-去年同月增減(%)", "累計營業收入-前期比較增減(%)"),
    ("公司代號", "營業收入_去年同月增減", "累計營業收入_前期比較增減"),
])
def test_parse_revenue_key_variants(keys):
    kc, ky, kcum = keys
    df = F.parse_revenue([{kc: "2330", "公司名稱": "台積電", ky: "35.12", kcum: "28.5", "營業收入-當月營收": "1,000"}])
    row = df.iloc[0]
    assert row["code"] == "2330" and row["rev_yoy"] == pytest.approx(35.12) and row["rev_cum_yoy"] == pytest.approx(28.5)


def test_parse_valuation():
    df = F.parse_valuation([{"Date": "1151102", "Code": "2330", "Name": "台積電", "PEratio": "25.3", "DividendYield": "1.5", "PBratio": "7.1"},
                            {"Code": "2002", "PEratio": "", "DividendYield": "0.00", "PBratio": "1.0"}])
    assert df.iloc[0]["pe"] == pytest.approx(25.3) and np.isnan(df.iloc[1]["pe"])


def test_live_fundamentals_failure_is_non_fatal(monkeypatch):
    def boom(path):
        raise ConnectionError("blocked")
    monkeypatch.setattr(F, "_fetch", boom)
    monkeypatch.setattr(F.time, "sleep", lambda s: None)
    F._mem.clear()
    df = F.get_fundamentals(use_demo=False)
    assert df.empty and set(F.COLUMNS[1:]) <= set(df.columns)
    assert all(v.startswith("失敗") for v in F.status().values())
    F._mem.clear()


def test_screener_fundamental_and_model_filters():
    r = S.screen(days=10, filters=[{"field": "rev_yoy", "op": ">", "value": 20}], technical=["minervini"],
                 sort="rev_yoy", limit=5, use_demo=True)
    assert r["rows"] and all(x["rev_yoy"] > 20 for x in r["rows"])
    r2 = S.screen(days=10, filters=[{"field": "pe", "op": "between", "value": 0.01, "value2": 15}], sort="dividend_yield",
                  limit=5, use_demo=True)
    assert all(0.01 <= x["pe"] <= 15 for x in r2["rows"])
