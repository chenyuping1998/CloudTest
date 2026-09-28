from datetime import date

import pandas as pd
import pytest

from twstock import backtest as bt
from twstock.data import demo_data


def _df():
    return demo_data("2317", date(2022, 1, 1), date(2024, 12, 31))


@pytest.mark.parametrize("strategy", list(bt.STRATEGIES))
def test_all_strategies_run(strategy):
    df = _df()
    pos = bt.generate_positions(df, strategy, {})
    assert set(pos.unique()) <= {0, 1}
    res = bt.run_backtest(df, pos, code="2317")
    assert len(res.equity) == len(df)
    assert res.metrics["max_drawdown"] <= 0


def test_trades_execute_next_open_with_fees():
    idx = pd.bdate_range("2024-01-01", periods=5)
    df = pd.DataFrame({"open": [100, 110, 120, 130, 140], "high": [101, 111, 121, 131, 141],
                       "low": [99, 109, 119, 129, 139], "close": [100, 110, 120, 130, 140], "volume": 1e6}, index=idx)
    pos = pd.Series([1, 1, 0, 0, 0], index=idx)
    cfg = bt.BacktestConfig(initial_capital=1_000_000, lot_size=1000)
    res = bt.run_backtest(df, pos, cfg, code="2330")
    (t,) = res.trades
    # 第 0 天訊號 → 第 1 天開盤 110 買；第 2 天收盤轉 0 → 第 3 天開盤 130 賣
    assert t.entry_date == "2024-01-02" and t.entry_price == 110
    assert t.exit_date == "2024-01-04" and t.exit_price == 130
    assert t.shares == 9000


def test_fee_and_tax_math():
    idx = pd.bdate_range("2024-01-01", periods=4)
    df = pd.DataFrame({"open": [100.0] * 4, "high": [100.0] * 4, "low": [100.0] * 4, "close": [100.0] * 4, "volume": 1e6}, index=idx)
    pos = pd.Series([1, 0, 0, 0], index=idx)
    cfg = bt.BacktestConfig(initial_capital=1_000_000, lot_size=1000)
    res = bt.run_backtest(df, pos, cfg, code="2330")
    (t,) = res.trades
    assert t.shares == 9000  # 10 張需 1,001,425 元，資金不足，只能買 9 張
    buy_fee = int(900_000 * 0.001425)
    sell_cost = int(900_000 * 0.001425) + int(900_000 * 0.003)
    assert t.pnl == pytest.approx(-(buy_fee + sell_cost))
    # ETF 證交稅 0.1%
    res_etf = bt.run_backtest(df, pos, cfg, code="0050")
    assert res_etf.trades[0].pnl == pytest.approx(-(buy_fee * 2 + 900))


def test_no_lookahead():
    """未來價格改變不應影響過去的淨值。"""
    df = _df()
    pos = bt.generate_positions(df, "sma_cross", {"fast": 5, "slow": 20})
    eq1 = bt.run_backtest(df, pos).equity
    df2 = df.copy()
    df2.iloc[-50:, :4] *= 1.5
    pos2 = bt.generate_positions(df2, "sma_cross", {"fast": 5, "slow": 20})
    eq2 = bt.run_backtest(df2, pos2).equity
    pd.testing.assert_series_equal(eq1.iloc[:-51], eq2.iloc[:-51])


def test_stop_loss_triggers():
    idx = pd.bdate_range("2024-01-01", periods=4)
    df = pd.DataFrame({"open": [100, 100, 95, 95], "high": [100, 100, 96, 96], "low": [100, 99, 80, 90],
                       "close": [100, 100, 90, 95], "volume": 1e6}, index=idx, dtype=float)
    pos = pd.Series(1, index=idx)
    res = bt.run_backtest(df, pos, bt.BacktestConfig(stop_loss=0.1))
    assert res.trades[0].reason == "停損" and res.trades[0].exit_price == 90


def test_optimize_sorted():
    rows = bt.optimize(_df(), "sma_cross", {"fast": [5, 10], "slow": [20, 60, 5]})
    assert all(r["params"]["fast"] < r["params"]["slow"] for r in rows)
    sharpes = [r["sharpe"] for r in rows]
    assert sharpes == sorted(sharpes, reverse=True)
