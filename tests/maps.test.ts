import { describe, expect, it } from 'vitest';
import { MONSTER_DB } from '../src/data/monsters';
import { worldLayout, ZONE_SPAWNS, type MapLayout, type WorldZoneId } from '../src/shared/maps';

/** 與伺服器移動規則相同：不能走進 blocked / 水，往上最多爬 1 格，往下不限 */
function reachable(layout: MapLayout): Set<number> {
  const g = layout.grid;
  const half = g.size / 2;
  const start = Math.floor(layout.spawn.z + half) * g.size + Math.floor(layout.spawn.x + half);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    const i = cur % g.size;
    const j = Math.floor(cur / g.size);
    const h = g.col(i, j)!.height;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = g.col(i + di, j + dj);
      const key = (j + dj) * g.size + i + di;
      if (!n || seen.has(key) || n.blocked || n.water || n.height - h > 1.2) continue;
      seen.add(key);
      queue.push(key);
    }
  }
  return seen;
}

const cellKey = (layout: MapLayout, x: number, z: number) =>
  Math.floor(z + layout.grid.size / 2) * layout.grid.size + Math.floor(x + layout.grid.size / 2);

describe.each(['field', 'frost', 'ember'] as WorldZoneId[])('map %s', (zone) => {
  const layout = worldLayout(zone);
  const ok = reachable(layout);

  it('every portal can be reached from the spawn point', () => {
    for (const p of layout.portals) {
      const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => ok.has(cellKey(layout, p.x + dx, p.z + dz)));
      expect(near, `portal to ${p.to} at (${p.x}, ${p.z})`).toBe(true);
    }
  });

  it('every monster spawn area is mostly reachable', () => {
    for (const [id, , [cx, cz], r] of ZONE_SPAWNS[zone]) {
      let total = 0;
      let reach = 0;
      for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) {
        if (Math.hypot(x - cx, z - cz) > r || !layout.grid.walkable(x, z)) continue;
        total++;
        if (ok.has(cellKey(layout, x, z))) reach++;
      }
      expect(total, `${id} has walkable ground`).toBeGreaterThan(5);
      expect(reach / total, `${id} (${MONSTER_DB.get(id)!.name}) reachable ratio`).toBeGreaterThan(0.8);
    }
  });
});
