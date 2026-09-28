import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { PgStorage, type Queryable } from '../server/storage/pgStorage';
import { steamVerifier } from '../server/steamAuth';
import type { AccountRecord } from '../src/server/GameServer';
import { initialHomestead } from '../src/data';
import { makeChar } from './helpers';

function account(name: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return { name, character: makeChar(name).serialize(), homestead: initialHomestead(), pity: [], createdAt: 1, lastLogin: 2, ...extra };
}

// PGlite 每次啟動要 1.5~2.5 秒（冷快取時更久），預設 5 秒逾時太緊
describe('PgStorage (real Postgres engine via PGlite)', { timeout: 30_000 }, () => {
  it('migrates, saves and loads accounts, world state and audit log', async () => {
    const db = new PGlite();
    const st = new PgStorage(db as unknown as Queryable);
    await st.migrate();
    await st.migrate(); // 可重複執行
    expect(await st.loadAccount('無名')).toBeUndefined();

    const rec = account('小明', { passwordHash: 'scrypt:x:y' });
    rec.character.gold = 12345;
    await st.saveAccount(rec);
    const loaded = await st.loadAccount('小明');
    expect(loaded?.character.gold).toBe(12345);
    expect(loaded?.character.inventory.items.length).toBe(rec.character.inventory.items.length);

    // 更新（upsert）
    rec.character.gold = 1;
    rec.steamId = '76561198000000001';
    await st.saveAccount(rec);
    expect((await st.loadAccount('小明'))?.character.gold).toBe(1);
    expect((await st.loadAccountBySteamId('76561198000000001'))?.name).toBe('小明');
    expect(await st.loadAccountBySteamId('nope')).toBeUndefined();

    expect(await st.loadWorld()).toBeUndefined();
    await st.saveWorld({ uidCounter: 42, market: { listings: [], history: [], stats: { goldSunkFees: 1, goldSunkTax: 2, volume: 3, trades: 4 }, pendingPayouts: [['a', 5]] } });
    expect((await st.loadWorld())?.uidCounter).toBe(42);

    await st.audit('trade', '小明', { gold: 100 });
    await st.audit('rare_drop', '小明', { defId: 'frost_whisper' });
    const log = await st.recentAudit('小明');
    expect(log.map((l) => l.kind).sort()).toEqual(['rare_drop', 'trade']);
    await db.close();
  });

  it('steam ids are unique across accounts', async () => {
    const db = new PGlite();
    const st = new PgStorage(db as unknown as Queryable);
    await st.migrate();
    await st.saveAccount(account('甲', { steamId: '1' }));
    await expect(st.saveAccount(account('乙', { steamId: '1' }))).rejects.toThrow();
    await db.close();
  });
});

describe('Steam ticket verification', () => {
  const fakeFetch = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('accepts a valid ticket and returns the SteamID', async () => {
    const v = steamVerifier({ apiKey: 'k', appId: 480, fetchImpl: fakeFetch({ response: { params: { result: 'OK', steamid: '7656', vacbanned: false, publisherbanned: false } } }) });
    expect(await v('abcdef0123456789')).toEqual({ steamId: '7656' });
  });

  it('rejects malformed tickets, invalid tickets, bans and network errors', async () => {
    const ok = steamVerifier({ apiKey: 'k', appId: 480, fetchImpl: fakeFetch({}) });
    expect(await ok('not-hex!')).toHaveProperty('error');
    expect(await ok('abcdef0123456789')).toHaveProperty('error');
    const banned = steamVerifier({ apiKey: 'k', appId: 480, fetchImpl: fakeFetch({ response: { params: { result: 'OK', steamid: '1', vacbanned: true } } }) });
    expect(await banned('abcdef0123456789')).toEqual({ error: '此帳號已被封鎖' });
    const down = steamVerifier({ apiKey: 'k', appId: 480, fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    expect(await down('abcdef0123456789')).toEqual({ error: '無法連線到 Steam' });
    const http500 = steamVerifier({ apiKey: 'k', appId: 480, fetchImpl: fakeFetch({}, 500) });
    expect(await http500('abcdef0123456789')).toHaveProperty('error');
  });
});
