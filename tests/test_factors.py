"""第一、二階段新增的因子與模型。解析測試使用 2026-11 證交所 OpenAPI 的真實回應樣本。"""
import numpy as np
import pandas as pd
import pytest

from twstock import fundamentals as F
from twstock import models as M
from twstock import picks
from twstock import screener as S

INCOME = [{"出表日期": "1151106", "年度": "115", "季別": "3", "公司代號": "1215", "公司名稱": "卜蜂", "營業收入": "21866426.00",
           "營業成本": "17802912.00", "營業毛利（毛損）": "4063514.00", "營業毛利（毛損）淨額": "4063514.00", "營業費用": "1907738.00",
           "營業利益（損失）": "2149648.00", "稅前淨利（淨損）": "2068268.00", "繼續營業單位本期淨利（淨損）": "1639340.00",
           "本期淨利（淨損）": "1639340.00", "淨利（淨損）歸屬於母公司業主": "1612807.00", "基本每股盈餘（元）": "5.47"}]
BALANCE = [{"出表日期": "1151106", "年度": "115", "季別": "3", "公司代號": "1215", "公司名稱": "卜蜂", "流動資產": "10528738.00",
            "非流動資產": "23943653.00", "資產總計": "34472391.00", "流動負債": "12209471.00", "非流動負債": "10054206.00",
            "負債總計": "22263677.00", "股本": "2947901.00", "保留盈餘": "7775353.00",
            "歸屬於母公司業主之權益合計": "11763790.00", "權益總計": "12208714.00", "每股參考淨值": "39.91"}]
MARGINS = [{"出表日期": "1151106", "年度": "115", "季別": "3", "公司代號": "1215", "公司名稱": "卜蜂", "營業收入(百萬元)": "21866.43",
            "毛利率(%)(營業毛利)/(營業收入)": "18.58", "營業利益率(%)(營業利益)/(營業收入)": "9.83"}]
MARGIN_TRADING = [{"股票代號": "2330", "股票名稱": "台積電", "融資買進": "640", "融資賣出": "1157", "融資現金償還": "31",
                   "融資前日餘額": "35144", "融資今日餘額": "34596", "融資限額": "6483092", "融券買進": "4", "融券賣出": "35",
                   "融券現券償還": "", "融券前日餘額": "16", "融券今日餘額": "47", "融券限額": "6483092", "資券互抵": "3", "註記": " "},
                  {"股票代號": "00400A", "股票名稱": "ETF", "融資前日餘額": "16207", "融資今日餘額": "16781", "融資限額": "581035",
                   "融券今日餘額": ""}]


def test_parse_statements_real_sample():
    df = F.parse_statements(INCOME, BALANCE, MARGINS).set_index("code")
    r = df.loc["1215"]
    assert r["fs_period"] == "115Q3" and r["eps"] == 5.47
    assert r["roe"] == pytest.approx(1612807 * 4 / 3 / 11763790 * 100)          # 年化 ROE ≈ 18.28%
    assert r["debt_ratio"] == pytest.approx(22263677 / 34472391 * 100)            # ≈ 64.6%
    assert r["current_ratio"] == pytest.approx(10528738 / 12209471)               # ≈ 0.86
    assert r["gross_margin"] == 18.58 and r["op_margin"] == 9.83                  # 營益分析官方值
    assert r["ebit_annual"] == pytest.approx(2149648 * 4 / 3)
    score, n = F.quality_score({**r.to_dict(), "rev_cum_yoy": 3.3})
    assert (score, n) == (4, 6)  # 獲利、本業、ROE、營收成長 ✓；負債比 64.6%、流動比 0.86 ✗


def test_parse_margin_real_sample():
    m = F.parse_margin(MARGIN_TRADING).set_index("code")
    assert m.loc["2330", "margin_usage"] == pytest.approx(34596 / 6483092 * 100)
    assert m.loc["2330", "short_ratio"] == pytest.approx(47 / 34596 * 100)
    assert m.loc["2330", "margin_chg"] == pytest.approx((34596 - 35144) / 35144 * 100)
    assert np.isnan(m.loc["00400A", "short_ratio"]) and m.loc["00400A", "margin_usage"] > 0


def test_parse_company_and_bad_format():
    c = F.parse_company([{"公司代號": "1101", "公司簡稱": "台泥", "已發行普通股數或TDR原股發行股數": "7723181742"}])
    assert c.iloc[0]["shares"] == 7723181742
    with pytest.raises(Exception):
        F.parse_margin([{"代號": "1", "完全不同的欄位": "x"}])


def test_price_metrics_altman_and_magic():
    row = F.parse_statements(INCOME, BALANCE, MARGINS).iloc[0].to_dict() | {"shares": 294790098}
    pm = F.price_metrics(row, 104.0)
    mcap_k = 104.0 * 294790098 / 1000
    ta, tl = 34472391, 22263677
    z = (1.2 * (10528738 - 12209471) / ta + 1.4 * 7775353 / ta + 3.3 * 2149648 * 4 / 3 / ta
         + 0.6 * mcap_k / tl + 1.0 * 21866426 * 4 / 3 / ta)
    assert pm["z_score"] == pytest.approx(z) and pm["market_cap"] == pytest.approx(104.0 * 294790098)
    assert pm["magic_roc"] == pytest.approx(2149648 * 4 / 3 / (ta - 12209471) * 100)
    assert M.altman_z(row, 104.0).detail["z"] == pytest.approx(z)


def test_graham_quality_altman_models():
    assert M.graham({"pe": 10, "pb": 2}).passed and not M.graham({"pe": 20, "pb": 2}).passed
    assert not M.graham({"pe": -3, "pb": 0.5}).passed
    assert M.quality({"quality_score": 6}).passed and M.quality({"quality_score": 1}).score < 0
    bad = {"total_assets": 100, "total_liab": 95, "current_assets": 10, "current_liab": 60, "retained": -40,
           "ebit_annual": -5, "sales_annual": 20, "shares": 1000}
    assert M.altman_z(bad, 5.0).score < 0 and M.altman_z(bad, 5.0).risks


def _bench(trend):
    idx = pd.bdate_range("2024-01-01", periods=300)
    c = pd.Series(100 * np.exp(np.linspace(0, trend, 300)), index=idx)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": 1e6})


def test_market_regime():
    assert M.market_regime(_bench(0.5))["state"] == "bull"
    assert M.market_regime(_bench(-0.5))["state"] == "bear"
    assert M.market_regime(None)["state"] == "unknown"


def test_factor_helpers():
    df = _bench(0.5)
    assert M.high_52w_ratio(df) == pytest.approx(1.0)
    assert M.volatility(df) == pytest.approx(0, abs=1e-6)


def test_bear_market_three_picks_and_industry_cap(monkeypatch):
    picks._cache.clear()
    monkeypatch.setattr(M, "market_regime", lambda bench: {"state": "bear", "label": "空頭", "detail": "測試"})
    r = picks.compute(use_demo=True)
    assert len(r["picks"]) == 3 and r["weights"]["lowvol"] == 0.20
    assert "空頭" in picks.format_message(r)
    picks._cache.clear()
    monkeypatch.setattr(M, "market_regime", lambda bench: {"state": "bull", "label": "多頭", "detail": "測試"})
    r = picks.compute(use_demo=True)
    assert len(r["picks"]) == 5
    inds = [p["industry"] for p in r["picks"] if p["industry"]]
    assert all(inds.count(i) <= picks.MAX_PER_INDUSTRY for i in inds)
    assert all(0 <= v <= 100 for p in r["picks"] for v in p["factors"].values())
    picks._cache.clear()


def test_screener_new_fields():
    r = S.screen(days=5, filters=[{"field": "z_score", "op": ">", "value": 2.99}, {"field": "quality_score", "op": ">=", "value": 4}],
                 technical=["near_52w_high"], sort="magic_ey", limit=5, use_demo=True)
    assert all(x["z_score"] > 2.99 and x["quality_score"] >= 4 for x in r["rows"])
    r2 = S.screen(days=5, filters=[{"field": "pe_pb", "op": "<", "value": 22.5}], sort="margin_usage", order="asc", limit=5, use_demo=True)
    vals = [x["margin_usage"] for x in r2["rows"]]
    assert vals == sorted(vals) and all(x["pe_pb"] < 22.5 for x in r2["rows"])
