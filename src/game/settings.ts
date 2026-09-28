/**
 * 玩家設定（音量、畫質）。存在本機；改變時通知訂閱者立即套用。
 */
export interface Settings {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
  /** 即時陰影（關掉可大幅提升低階顯卡的效能） */
  shadows: boolean;
  /** 繪圖解析度倍率：0.5 / 0.75 / 1 / 1.5 / 2（相對於螢幕） */
  renderScale: number;
  /** 天氣粒子（雪、火星） */
  weather: boolean;
}

const KEY = 'roe:settings';

export const DEFAULT_SETTINGS: Settings = { master: 0.8, music: 0.5, sfx: 0.8, muted: false, shadows: true, renderScale: 1, weather: true };

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS, ...raw };
    const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    return {
      master: clamp(s.master, 0, 1, DEFAULT_SETTINGS.master),
      music: clamp(s.music, 0, 1, DEFAULT_SETTINGS.music),
      sfx: clamp(s.sfx, 0, 1, DEFAULT_SETTINGS.sfx),
      muted: !!s.muted,
      shadows: s.shadows !== false,
      renderScale: clamp(s.renderScale, 0.5, 2, 1),
      weather: s.weather !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class SettingsStore {
  private value = load();
  private listeners = new Set<(s: Settings) => void>();

  get(): Settings {
    return this.value;
  }

  set(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* 無痕模式等情況：只在本次有效 */
    }
    for (const fn of this.listeners) fn(this.value);
  }

  subscribe(fn: (s: Settings) => void): void {
    this.listeners.add(fn);
  }
}

export const settings = new SettingsStore();
