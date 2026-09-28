/**
 * 練功節奏報表：npm run sim:leveling [-- 效率]
 */
import { CONTENT_LEVEL_CAP, DEFAULT_PACING, MILESTONE_NOTES, PACING_CHECKPOINTS, PACING_TOLERANCE, simulateLeveling, targetCumulativeHours } from '../src/balance/pacing';
import { baseExpToNext } from '../src/core/leveling';

const efficiency = Number(process.argv[2] ?? DEFAULT_PACING.efficiency);
const rows = simulateLeveling(99, { ...DEFAULT_PACING, efficiency });
const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)} 分` : `${h.toFixed(1)} 時`);

console.log(`# 練功節奏報表（玩家效率 ${efficiency}）\n`);
console.log('| Lv | 升級所需經驗 | 最佳練功怪 | 擊殺秒數 | 每隻損血 | 每小時經驗 | 本級耗時 | 累積 | Job |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.level > 50 && r.level % 5 !== 0) continue;
  console.log(`| ${r.level} | ${baseExpToNext(r.level).toLocaleString()} | ${r.best.monster.name} Lv${r.best.monster.level} | ${r.best.ttkSec.toFixed(1)} | ${Math.round(r.best.hpLossPerKill * 100)}% | ${Math.round(r.best.baseExpPerHour).toLocaleString()} | ${fmtH(r.hoursThisLevel)} | ${fmtH(r.cumulativeHours)} | ${r.classId === 'novice' ? '初心者' : '劍士'} ${r.jobLevel} |`);
}
console.log(`\n## 目標檢查（目標曲線 ±${PACING_TOLERANCE * 100}%，現有內容上限 Lv ${CONTENT_LEVEL_CAP}）\n`);
console.log('| 等級 | 模擬 | 目標 | 差距 | 結果 | 說明 |');
console.log('|---|---|---|---|---|---|');
for (const lv of PACING_CHECKPOINTS) {
  const sim = rows.find((x) => x.level === lv - 1)!.cumulativeHours;
  const target = targetCumulativeHours(lv);
  const diff = sim / target - 1;
  const ok = Math.abs(diff) <= PACING_TOLERANCE;
  console.log(`| ${lv} | ${fmtH(sim)} | ${fmtH(target)} | ${diff >= 0 ? '+' : ''}${Math.round(diff * 100)}% | ${ok ? '✅' : '❌'} | ${MILESTONE_NOTES[lv] ?? ''} |`);
}
