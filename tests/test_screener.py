import numpy as np
import pytest

from twstock import market as M
from twstock import screener as S


def test_streak():
    assert S._streak(np.array([1, -1, 2, 3, 4.0])) == 3
    assert S._streak(np.array([1, -1, -2.0])) == -2
    assert S._streak(np.array([1, 2, 0.0])) == 0
    assert S._streak(np.array([])) == 0


def test_screen_trust_top10():
    r = S.screen(days=10, filters=[{"field": "trust_net", "op": ">", "value": 0}], sort="trust_net", limit=10, use_demo=True)
    assert len(r["dates"]) == 10
    assert 0 < len(r["rows"]) <= 10
    vals = [row["trust_net"] for row in r["rows"]]
    assert all(v > 0 for v in vals) and vals == sorted(vals, reverse=True)
    assert all(not row["code"].startswith("00") for row in r["rows"])


def test_screen_between_asc_and_technical():
    r = S.screen(days=5, filters=[{"field": "change_pct", "op": "between", "value": -5, "value2": 5}],
                 technical=["above_ma20"], sort="change_pct", order="asc", limit=5, use_demo=True)
    vals = [row["change_pct"] for row in r["rows"]]
    assert all(-5 <= v <= 5 for v in vals) and vals == sorted(vals)
    assert all(row["close"] > row["tech_ma20"] for row in r["rows"])


def test_screen_rejects_unknown_field():
    with pytest.raises(ValueError):
        S.screen(filters=[{"field": "nope", "op": ">", "value": 0}], use_demo=True)


T86 = {"stat": "OK", "fields": ["證券代號", "證券名稱", "外陸資買進股數(不含外資自營商)", "外陸資賣出股數(不含外資自營商)",
                                "外陸資買賣超股數(不含外資自營商)", "外資自營商買進股數", "外資自營商賣出股數", "外資自營商買賣超股數",
                                "投信買進股數", "投信賣出股數", "投信買賣超股數", "自營商買賣超股數", "自營商買進股數(自行買賣)",
                                "自營商賣出股數(自行買賣)", "自營商買賣超股數(自行買賣)", "自營商買進股數(避險)", "自營商賣出股數(避險)",
                                "自營商買賣超股數(避險)", "三大法人買賣超股數"],
       "data": [["2330", "台積電", "1", "1", "5,000,000", "0", "0", "1,000", "0", "0", "-200,000", "300,000",
                 "0", "0", "0", "0", "0", "0", "5,101,000"]]}

MI_INDEX = {"stat": "OK", "tables": [
    {"title": "大盤統計資訊", "fields": ["指數", "收盤指數"], "data": [["發行量加權股價指數", "22,000"]]},
    {"title": "每日收盤行情", "fields": ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價",
                                     "收盤價", "漲跌(+/-)", "漲跌價差"],
     "data": [["2330", "台積電", "30,000,000", "1", "30,000,000,000", "990.00", "1,005.00", "985.00", "1,000.00", "+", "10"]]}]}


def test_parse_twse(monkeypatch):
    from datetime import date
    monkeypatch.setattr(M, "_get_json", lambda url, params: T86 if "T86" in url else MI_INDEX)
    inst = M._fetch_twse_inst(date(2026, 9, 25)).iloc[0]
    assert inst["foreign"] == 5_001_000 and inst["trust"] == -200_000 and inst["dealer"] == 300_000
    assert inst["inst"] == 5_101_000
    q = M._fetch_twse_quotes(date(2026, 9, 25)).iloc[0]
    assert q["close"] == 1000 and q["high"] == 1005 and q["volume"] == 30_000_000
