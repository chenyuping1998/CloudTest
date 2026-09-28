import { describe, expect, it } from 'vitest';
import { craft, gather, Homestead, type NodeState } from '../src/core/homestead';
import { SeededRng } from '../src/core/rng';
import { HOMESTEAD_UPGRADES, initialHomestead, ITEM_DB, NODE_DB, RECIPE_DB } from '../src/data';
import { give, makeChar, uids } from './helpers';

describe('gathering', () => {
  it('requires a tool of sufficient tier', () => {
    const c = makeChar('Miner');
    const node: NodeState = { defId: 'copper_vein', hitsLeft: 6 };
    const r = gather(c, node, NODE_DB.get('copper_vein')!, ITEM_DB, uids, new SeededRng(1), 0);
    expect(r.ok).toBe(false);
  });

  it('yields ore, grants exp, depletes and respawns', () => {
    const c = makeChar('Miner2');
    give(c, 'stone_pickaxe');
    const def = NODE_DB.get('copper_vein')!;
    const node: NodeState = { defId: def.id, hitsLeft: def.hits };
    const rng = new SeededRng(2);
    for (let i = 0; i < def.hits; i++) expect(gather(c, node, def, ITEM_DB, uids, rng, 1000).ok).toBe(true);
    expect(c.inventory.count('copper_ore')).toBeGreaterThanOrEqual(def.hits);
    expect(node.depletedAt).toBe(1000);
    expect(gather(c, node, def, ITEM_DB, uids, rng, 2000).ok).toBe(false);
    expect(gather(c, node, def, ITEM_DB, uids, rng, 1000 + def.respawnSec * 1000).ok).toBe(true);
    expect(c.data.lifeSkills.mining.level).toBeGreaterThan(1);
  });
});

describe('crafting', () => {
  it('consumes inputs and produces signed output', () => {
    const c = makeChar('Smith');
    c.data.lifeSkills.smithing.level = 30;
    give(c, 'iron_ingot', 8);
    give(c, 'oak_plank', 2);
    const hs = new Homestead(initialHomestead());
    const res = craft(c, RECIPE_DB.get('craft_iron_sword')!, hs, ITEM_DB, uids, { next: () => 0 }, 0);
    expect(res.ok && res.success).toBe(true);
    expect(res.item!.crafter).toBe('Smith');
    expect(c.inventory.count('iron_ingot')).toBe(0);
  });

  it('failure still consumes materials (item sink)', () => {
    const c = makeChar('Smith2');
    c.data.lifeSkills.smithing.level = 10;
    give(c, 'iron_ingot', 8);
    give(c, 'oak_plank', 2);
    const hs = new Homestead(initialHomestead());
    const res = craft(c, RECIPE_DB.get('craft_iron_sword')!, hs, ITEM_DB, uids, { next: () => 0.9999 }, 0);
    expect(res.ok).toBe(true);
    expect(res.success).toBe(false);
    expect(c.inventory.count('iron_ingot')).toBe(0);
  });

  it('station level gates recipes', () => {
    const c = makeChar('Smith3');
    c.data.lifeSkills.smithing.level = 50;
    const hs = new Homestead(initialHomestead());
    expect(craft(c, RECIPE_DB.get('craft_mithril_armor')!, hs, ITEM_DB, uids, new SeededRng(1), 0).reason).toBe('設施等級不足');
  });
});

describe('homestead upgrade', () => {
  it('consumes resources and unlocks new nodes', () => {
    const c = makeChar('Owner');
    c.data.gold = 10_000;
    give(c, 'oak_plank', 20);
    give(c, 'copper_ingot', 20);
    const hs = new Homestead(initialHomestead());
    const before = hs.data.nodes.length;
    expect(hs.upgrade(c, HOMESTEAD_UPGRADES[0], NODE_DB).ok).toBe(true);
    expect(hs.data.level).toBe(2);
    expect(hs.data.nodes.length).toBe(before + 4);
    expect(c.data.gold).toBe(5_000);
  });
});
