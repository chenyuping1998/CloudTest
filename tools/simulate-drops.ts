/**
 * 掉寶平衡報表：npm run sim:drops [-- killsPerHour]
 * 對每隻怪物列出：掉率、期望擊殺數、50%/90% 機率取得所需擊殺數、換算時數、每小時 NPC 收益。
 * 企劃每次改表都跑一次，把結果貼進 docs/drop-economy.md。
 */
import { killsForConfidence, pityKillStats, poolEntryRatePpm, rollDrops, type DropEntry } from '../src/core/drops';
import { expectedEnchantCost } from '../src/core/enchant';
import { formatPpm, PPM, SeededRng } from '../src/core/rng';
import { RARITY_INFO } from '../src/core/types';
import { ITEM_DB, MONSTERS, POOL_DB } from '../src/data';

const killsPerHour = Number(process.argv[2] ?? 300);
const hrs = (k: number) => (k / killsPerHour < 1 ? `${Math.max(1, Math.round((k / killsPerHour) * 60))} 分` : `${(k / killsPerHour).toFixed(1)} 小時`);

console.log(`# 掉寶平衡報表（假設每小時擊殺 ${killsPerHour} 隻；MVP 以 1 小時 1 隻計）\n`);

for (const m of MONSTERS) {
  const kph = m.mvp ? 1 : killsPerHour;
  const h = (k: number) => (m.mvp ? `${k} 隻（≈${k} 小時）` : hrs(k));
  console.log(`## ${m.name}（Lv ${m.level}${m.mvp ? '，MVP' : ''}）\n`);
  console.log('| 物品 | 稀有度 | 掉率 | 期望擊殺 | 50% 取得 | 90% 取得 |');
  console.log('|---|---|---|---|---|---|');
  const rows = [
    ...m.drops.drops.map((d) => ({ id: d.itemId, rate: d.ratePpm, entry: d as DropEntry | undefined, tag: d.category === 'card' ? '（卡片）' : '' })),
    ...(m.drops.mvpDrops ?? []).map((d) => ({ id: d.itemId, rate: d.ratePpm, entry: d as DropEntry | undefined, tag: d.pity ? `（MVP 得主，${d.pity.startAfter} 次後保底）` : '（MVP 得主）' })),
    ...(m.drops.pools ?? []).flatMap((pid) => {
      const pool = POOL_DB.get(pid)!;
      return [...new Set(pool.entries.map((e) => e.itemId))].map((id) => ({ id, rate: poolEntryRatePpm(pool, id), entry: undefined, tag: `（寶箱池 ${pid}）` }));
    }),
  ];
  for (const r of rows) {
    const def = ITEM_DB.get(r.id)!;
    let exp = r.rate >= PPM ? 1 : Math.round(PPM / r.rate);
    let k50 = killsForConfidence(r.rate, 0.5);
    let k90 = killsForConfidence(r.rate, 0.9);
    if (r.entry?.pity) {
      const st = pityKillStats(r.entry);
      exp = Math.round(st.expected);
      [k50, k90] = st.atConfidence;
    }
    console.log(
      `| ${def.name}${r.tag} | ${RARITY_INFO[def.rarity].name} | ${formatPpm(r.rate)} | ${exp.toLocaleString()} | ${h(k50)} | ${h(k90)} |`,
    );
  }

  // 模擬 NPC 收益：跑 20000 次擊殺取平均
  const rng = new SeededRng(1234);
  const N = 20_000;
  let gold = 0;
  for (let i = 0; i < N; i++) {
    for (const d of rollDrops(m.drops, ITEM_DB, POOL_DB, { playerLevel: m.level, sourceLevel: m.level, luk: 10, personalBonusPct: 0, eventMultiplier: 1 }, rng)) {
      gold += ITEM_DB.get(d.itemId)!.sellPrice * d.qty;
    }
  }
  console.log(`\n> 全部賣 NPC 的平均收益：每隻 ${(gold / N).toFixed(1)}G，每小時約 ${Math.round((gold / N) * kph).toLocaleString()}G\n`);
}

console.log('## 強化期望成本（無保護卷軸，失敗即蒸發）\n');
console.log('| 目標 | 武器：期望卷軸 | 武器：期望消耗裝備 | 防具：期望卷軸 | 防具：期望消耗裝備 |');
console.log('|---|---|---|---|---|');
for (let t = 5; t <= 12; t++) {
  const w = expectedEnchantCost('weapon', t);
  const a = expectedEnchantCost('armor', t);
  console.log(`| +${t} | ${w.scrolls.toFixed(1)} | ${w.items.toFixed(1)} | ${a.scrolls.toFixed(1)} | ${a.items.toFixed(1)} |`);
}
