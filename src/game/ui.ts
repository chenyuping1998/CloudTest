/** 小型 DOM 工具：建立元素、可拖曳視窗、確認對話框 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void) | undefined> = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== undefined && c !== false) el.append(c);
  return el;
}

export class Panel {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  private titleEl: HTMLSpanElement;

  constructor(
    root: HTMLElement,
    title: string,
    opts: { x: number; y: number; w: number },
    private readonly onClose?: () => void,
  ) {
    this.titleEl = h('span', {}, title);
    const close = h('button', { class: 'panel-close', title: '關閉 (Esc)', onclick: () => this.hide() }, '×');
    const bar = h('div', { class: 'panel-title' }, this.titleEl, close);
    this.body = h('div', { class: 'panel-body' });
    this.el = h('div', { class: 'panel', style: `left:${opts.x}px;top:${opts.y}px;width:${opts.w}px;display:none` }, bar, this.body);
    root.appendChild(this.el);
    this.el.addEventListener('mousedown', () => Panel.bringToFront(this.el));
    let drag: { dx: number; dy: number } | undefined;
    bar.addEventListener('mousedown', (e) => {
      drag = { dx: e.clientX - this.el.offsetLeft, dy: e.clientY - this.el.offsetTop };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      this.el.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
      this.el.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
    });
    window.addEventListener('mouseup', () => (drag = undefined));
  }

  private static z = 20;
  static bringToFront(el: HTMLElement): void {
    el.style.zIndex = String(++Panel.z);
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  setTitle(t: string): void {
    this.titleEl.textContent = t;
  }

  show(): void {
    this.el.style.display = 'block';
    Panel.bringToFront(this.el);
  }

  hide(): void {
    if (!this.visible) return;
    this.el.style.display = 'none';
    this.onClose?.();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  set(...children: (Node | string | undefined | false)[]): void {
    this.body.replaceChildren(...children.filter((c): c is Node | string => c !== undefined && c !== false));
  }
}

export function ask(root: HTMLElement, text: string, okLabel = '確定'): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = h(
      'div',
      { class: 'modal-overlay' },
      h('div', { class: 'modal' }, h('div', { class: 'modal-text', html: text }), h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => done(false) }, '取消'),
        h('button', { class: 'btn btn-primary', onclick: () => done(true) }, okLabel),
      )),
    );
    root.appendChild(overlay);
  });
}

export function bar(ratio: number, cls: string, label: string): HTMLDivElement {
  return h('div', { class: `bar ${cls}` }, h('div', { class: 'bar-fill', style: `width:${Math.max(0, Math.min(1, ratio)) * 100}%` }), h('span', { class: 'bar-label' }, label));
}

export const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');
