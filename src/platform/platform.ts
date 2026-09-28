/**
 * 平台抽象層：瀏覽器版什麼都不做；Electron + Steam 版由 preload 注入 window.steam。
 * 遊戲程式只呼叫這裡，不直接碰 Steam SDK。
 */
export interface SteamBridge {
  available: boolean;
  personaName?: string;
  steamId?: string;
  activateAchievement(id: string): void;
  setRichPresence(key: string, value: string): void;
}

export interface DesktopBridge {
  toggleFullscreen(): void;
  quit(): void;
  version: string;
}

declare global {
  interface Window {
    steam?: SteamBridge;
    desktop?: DesktopBridge;
  }
}

export const platform = {
  get isDesktop(): boolean {
    return !!window.desktop;
  },
  get steam(): SteamBridge | undefined {
    return window.steam?.available ? window.steam : undefined;
  },
  unlockAchievement(id: string): void {
    try {
      this.steam?.activateAchievement(id);
    } catch (e) {
      console.warn('Steam 成就同步失敗', e);
    }
  },
  setStatus(text: string): void {
    try {
      this.steam?.setRichPresence('steam_display', '#Status');
      this.steam?.setRichPresence('status', text);
    } catch {
      /* ignore */
    }
  },
  toggleFullscreen(): void {
    if (window.desktop) window.desktop.toggleFullscreen();
    else if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  },
};
