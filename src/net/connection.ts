import type { ClientMsg, ServerMsg } from './protocol';
import { GameServer } from '../server/GameServer';
import { BrowserStorage } from '../server/browserStorage';

export interface Connection {
  send(msg: ClientMsg): void;
  onMessage(cb: (msg: ServerMsg) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
  readonly online: boolean;
}

/**
 * 單機模式：遊戲伺服器直接在瀏覽器裡跑（與連線版同一份程式碼），存檔到 localStorage。
 */
export class LocalConnection implements Connection {
  readonly online = false;
  private server: GameServer;
  private handlers: ((msg: ServerMsg) => void)[] = [];
  private timer: ReturnType<typeof setInterval>;
  private saveOnUnload = () => void this.server.saveAll();
  private conn = {
    send: (msg: ServerMsg) => {
      // 模擬網路：非同步送達，避免在處理訊息時重入
      const copy = JSON.parse(JSON.stringify(msg)) as ServerMsg;
      queueMicrotask(() => this.handlers.forEach((h) => h(copy)));
    },
  };

  constructor() {
    const storage = new BrowserStorage();
    this.server = new GameServer({ online: false, storage, world: storage.loadWorldSync(), marketBots: true, uidPrefix: 'l' });
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.server.tick(Math.min((now - last) / 1000, 0.2));
      last = now;
    }, 50);
    window.addEventListener('beforeunload', this.saveOnUnload);
  }

  send(msg: ClientMsg): void {
    this.server.handle(this.conn, JSON.parse(JSON.stringify(msg)) as ClientMsg);
  }

  onMessage(cb: (msg: ServerMsg) => void): void {
    this.handlers.push(cb);
  }

  onClose(): void {
    /* 本機伺服器不會斷線 */
  }

  close(): void {
    this.server.disconnect(this.conn);
    void this.server.saveAll();
    clearInterval(this.timer);
    window.removeEventListener('beforeunload', this.saveOnUnload);
  }
}

/** 連線模式：WebSocket */
export class WsConnection implements Connection {
  readonly online = true;
  private ws: WebSocket;
  private handlers: ((msg: ServerMsg) => void)[] = [];
  private closeHandlers: ((reason: string) => void)[] = [];
  private queue: string[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      for (const q of this.queue) this.ws.send(q);
      this.queue = [];
    };
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      this.handlers.forEach((h) => h(msg));
    };
    this.ws.onclose = (ev) => this.closeHandlers.forEach((h) => h(ev.reason || '與伺服器的連線中斷'));
    this.ws.onerror = () => this.closeHandlers.forEach((h) => h('無法連線到伺服器'));
  }

  send(msg: ClientMsg): void {
    const s = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(s);
  }

  onMessage(cb: (msg: ServerMsg) => void): void {
    this.handlers.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    this.ws.close();
  }
}
