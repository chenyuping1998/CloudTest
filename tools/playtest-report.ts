/**
 * 封測報表：讀取伺服器的稽核日誌，整理成一份 Markdown。
 *
 *   npm run report:playtest                      # 讀 server-data/audit.log（npm run host 的預設位置）
 *   npm run report:playtest -- --out report.md   # 另存檔案
 *   DATABASE_URL=postgres://... npm run report:playtest   # 正式伺服器（PostgreSQL）
 *
 * 內容：練功節奏（真實玩家 vs 設計曲線）、新手教學的流失點、回報的問題、經濟事件。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACING_CHECKPOINTS, targetCumulativeHours } from '../src/balance/pacing';
import { CLASSES, type ClassId } from '../src/data/classes';
import { QUESTS } from '../src/data/quests';
import { ZONE_NAMES, type ZoneId } from '../src/shared/maps';

interface Row {
  at: string;
  kind: string;
  actor: string;
  data: Record<string, unknown>;
}

async function loadRows(): Promise<Row[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
    const r = await pool.query("SELECT at, kind, actor, data FROM audit_log WHERE kind IN ('level_up','feedback','quest_done','account_created','trade','market_sale','enchant_destroyed','rare_drop') ORDER BY at");
    await pool.end();
    return r.rows.map((x) => ({ at: new Date(x.at).toISOString(), kind: x.kind, actor: x.actor, data: typeof x.data === 'string' ? JSON.parse(x.data) : x.data }));
  }
  const file = join(process.env.DATA_DIR ?? 'server-data', 'audit.log');
  if (!existsSync(file)) {
    console.error(`找不到 ${file}。請在執行過 npm run host 的資料夾裡執行，或設定 DATA_DIR。`);
    process.exit(1);
  }
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as Row];
    } catch {
      return [];
    }
  });
}

const hours = (sec: number) => sec / 3600;
const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)} 分` : `${h.toFixed(1)} 時`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

function report(rows: Row[]): string {
  const out: string[] = [];
  const levels = rows.filter((r) => r.kind === 'level_up');
  const feedback = rows.filter((r) => r.kind === 'feedback');
  const quests = rows.filter((r) => r.kind === 'quest_done');
  const players = new Map<string, { level: number; classId: string; playSeconds: number; last: string }>();
  for (const r of [...levels, ...feedback]) {
    const d = r.data as { level?: number; classId?: string; playSeconds?: number };
    const p = players.get(r.actor) ?? { level: 1, classId: 'novice', playSeconds: 0, last: r.at };
    p.level = Math.max(p.level, d.level ?? 1);
    p.classId = d.classId ?? p.classId;
    p.playSeconds = Math.max(p.playSeconds, d.playSeconds ?? 0);
    p.last = r.at;
    players.set(r.actor, p);
  }
  const created = rows.filter((r) => r.kind === 'account_created').length;

  out.push('# 封測報表', '');
  out.push(`產生時間：${new Date().toLocaleString('zh-TW')}`, '');
  out.push(`- 玩家：${players.size} 人（新建帳號 ${created}）`);
  out.push(`- 總遊玩時間：${fmtH(hours([...players.values()].reduce((s, p) => s + p.playSeconds, 0)))}（不含掛機）`);
  out.push(`- 回報：${feedback.length} 則`, '');

  // ---------------- 練功節奏
  out.push('## 練功節奏：真實玩家 vs 設計曲線', '');
  out.push('設計曲線假設「一般玩家」；比值 > 1 代表玩家升得比設計慢，< 1 代表比設計快。±30% 以內算正常。', '');
  out.push('| 等級 | 人數 | 中位數時數 | 設計時數 | 比值 | 判斷 |', '|---|---|---|---|---|---|');
  const reachedAt = new Map<string, Map<number, number>>();
  for (const r of levels) {
    const d = r.data as { level: number; playSeconds: number };
    const m = reachedAt.get(r.actor) ?? new Map<number, number>();
    if (!m.has(d.level)) m.set(d.level, d.playSeconds);
    reachedAt.set(r.actor, m);
  }
  for (const lv of PACING_CHECKPOINTS) {
    const xs = [...reachedAt.values()].map((m) => m.get(lv)).filter((x): x is number => x !== undefined).map(hours);
    if (!xs.length) continue;
    const med = median(xs);
    const target = targetCumulativeHours(lv);
    const ratio = med / target;
    const verdict = xs.length < 3 ? '樣本太少' : ratio > 1.3 ? '⚠ 太慢' : ratio < 0.7 ? '⚠ 太快' : '✅';
    out.push(`| ${lv} | ${xs.length} | ${fmtH(med)} | ${fmtH(target)} | ${ratio.toFixed(2)} | ${verdict} |`);
  }
  out.push('');

  // ---------------- 玩家
  out.push('## 玩家', '', '| 玩家 | 等級 | 職業 | 遊玩時間 | 最後紀錄 |', '|---|---|---|---|---|');
  for (const [name, p] of [...players].sort((a, b) => b[1].level - a[1].level)) {
    out.push(`| ${name} | ${p.level} | ${CLASSES[p.classId as ClassId]?.name ?? p.classId} | ${fmtH(hours(p.playSeconds))} | ${p.last.slice(0, 16).replace('T', ' ')} |`);
  }
  out.push('');

  // ---------------- 新手教學流失
  out.push('## 新手教學：每一步完成的人數', '', '人數突然掉很多的那一步，就是玩家卡關或覺得無聊的地方。', '');
  out.push('| 任務 | 完成人數 |', '|---|---|');
  for (const q of QUESTS.filter((x) => !x.daily)) {
    const n = new Set(quests.filter((r) => (r.data as { id: string }).id === q.id).map((r) => r.actor)).size;
    out.push(`| ${q.name} | ${n} |`);
  }
  const dailies = quests.filter((r) => (r.data as { id: string }).id.startsWith('d_')).length;
  out.push('', `每日討伐完成次數：${dailies}`, '');

  // ---------------- 經濟
  const count = (k: string) => rows.filter((r) => r.kind === k).length;
  out.push('## 經濟事件', '');
  out.push(`- 玩家交易 ${count('trade')} 次、交易所成交 ${count('market_sale')} 次`);
  out.push(`- 強化失敗蒸發 ${count('enchant_destroyed')} 次、稀有掉寶 ${count('rare_drop')} 次`, '');

  // ---------------- 回報
  out.push('## 玩家回報', '');
  const catName: Record<string, string> = { bug: '錯誤', balance: '平衡', idea: '建議', other: '其他' };
  for (const cat of ['bug', 'balance', 'idea', 'other']) {
    const list = feedback.filter((r) => (r.data as { category: string }).category === cat);
    if (!list.length) continue;
    out.push(`### ${catName[cat]}（${list.length}）`, '');
    for (const r of list) {
      const d = r.data as { text: string; level: number; classId: string; zone: string; x: number; z: number; client?: string };
      out.push(`- **${r.actor}**（Lv ${d.level} ${CLASSES[d.classId as ClassId]?.name ?? d.classId}，${ZONE_NAMES[d.zone as ZoneId] ?? d.zone} (${d.x}, ${d.z})，${r.at.slice(0, 16).replace('T', ' ')}）`);
      out.push(`  ${d.text.replace(/\n/g, '\n  ')}`);
    }
    out.push('');
  }
  if (!feedback.length) out.push('（還沒有回報）', '');
  return out.join('\n');
}

const rows = await loadRows();
const md = report(rows);
const outIdx = process.argv.indexOf('--out');
if (outIdx > 0 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], md);
  console.log(`已寫入 ${process.argv[outIdx + 1]}`);
} else console.log(md);
