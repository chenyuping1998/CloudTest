/**
 * 匯出目前的程序化材質，給美術當範本：
 *   art/templates/blocks/<tile>.png   每個 16×16 方塊材質
 *   art/templates/atlas-preview.png   全部拼在一起（放大 4 倍方便檢視）
 *   art/templates/tiles.json          tile 清單
 *   art/templates/models.json         可替換的模型 key（art/models/<key>.glb）
 * 美術修改後放到 art/blocks/<tile>.png（同名）即可生效。
 *
 * 執行：npm run art:export
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { CLASSES } from '../src/data/classes';
import { MONSTERS } from '../src/data/monsters';
import { ATLAS_TILES, paintTile, TILE } from '../src/game/voxel/atlas';

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = join(process.cwd(), 'art', 'templates');
const blocks = join(out, 'blocks');
mkdirSync(blocks, { recursive: true });

const COLS = 8;
const SCALE = 4;
const GAP = 2;
const cell = TILE * SCALE + GAP;
const rows = Math.ceil(ATLAS_TILES.length / COLS);
const sheetW = COLS * cell;
const sheetH = rows * cell;
const sheet = new Uint8Array(sheetW * sheetH * 4);

ATLAS_TILES.forEach((name, i) => {
  const px = paintTile(name);
  writeFileSync(join(blocks, `${name}.png`), png(TILE, TILE, new Uint8Array(px.buffer)));
  const ox = (i % COLS) * cell;
  const oy = Math.floor(i / COLS) * cell;
  for (let y = 0; y < TILE * SCALE; y++) {
    for (let x = 0; x < TILE * SCALE; x++) {
      const s = (Math.floor(y / SCALE) * TILE + Math.floor(x / SCALE)) * 4;
      const d = ((oy + y) * sheetW + ox + x) * 4;
      sheet.set(px.subarray(s, s + 4), d);
    }
  }
});

writeFileSync(join(out, 'atlas-preview.png'), png(sheetW, sheetH, sheet));
writeFileSync(join(out, 'tiles.json'), JSON.stringify({ tileSize: TILE, tiles: ATLAS_TILES }, null, 2) + '\n');
const models = [
  ...Object.values(CLASSES).map((c) => ({ key: `class_${c.id}`, name: c.name, kind: 'player' })),
  ...MONSTERS.map((m) => ({ key: `monster_${m.id}`, name: m.name, kind: m.mvp ? 'mvp' : 'monster', level: m.level })),
  { key: 'npc_shop', name: '道具商人', kind: 'npc' },
  { key: 'npc_market', name: '交易所管理員', kind: 'npc' },
  { key: 'npc_guide', name: '新手導覽員', kind: 'npc' },
];
writeFileSync(join(out, 'models.json'), JSON.stringify({ clips: ['idle', 'walk', 'attack'], models }, null, 2) + '\n');
console.log(`已匯出 ${ATLAS_TILES.length} 個材質到 ${out}`);
