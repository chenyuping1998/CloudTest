/**
 * Steam 登入票證驗證（ISteamUserAuth/AuthenticateUserTicket）。
 * 用戶端（Electron + steamworks.js）以 getAuthTicketForWebApi(STEAM_TICKET_IDENTITY) 取得票證，
 * 伺服器用發行商 Web API 金鑰向 Steam 驗證，取得可信的 SteamID。
 */
import type { SteamVerifier } from '../src/server/GameServer';

export const STEAM_TICKET_IDENTITY = 'realm-of-embers';

interface AuthResponse {
  response?: {
    params?: { result?: string; steamid?: string; vacbanned?: boolean; publisherbanned?: boolean };
    error?: { errorcode?: number; errordesc?: string };
  };
}

export function steamVerifier(opts: { apiKey: string; appId: number; fetchImpl?: typeof fetch }): SteamVerifier {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (ticketHex) => {
    if (!/^[0-9a-fA-F]{16,4096}$/.test(ticketHex)) return { error: '票證格式錯誤' };
    const url = new URL('https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/');
    url.searchParams.set('key', opts.apiKey);
    url.searchParams.set('appid', String(opts.appId));
    url.searchParams.set('ticket', ticketHex);
    url.searchParams.set('identity', STEAM_TICKET_IDENTITY);
    let body: AuthResponse;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { error: `Steam 回應 ${res.status}` };
      body = (await res.json()) as AuthResponse;
    } catch {
      return { error: '無法連線到 Steam' };
    }
    const p = body.response?.params;
    if (!p || p.result !== 'OK' || !p.steamid) return { error: body.response?.error?.errordesc ?? '票證無效' };
    if (p.vacbanned || p.publisherbanned) return { error: '此帳號已被封鎖' };
    return { steamId: p.steamid };
  };
}
