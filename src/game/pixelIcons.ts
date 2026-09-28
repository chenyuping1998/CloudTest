/** UI 用的小型像素圖示（12×12），以字元圖定義 */
const PALETTE: Record<string, string> = {
  k: '#1a1320', f: '#ff8a20', F: '#ffd24a', c: '#9adfff', C: '#e0f8ff', l: '#ffe860', L: '#fffbd0', h: '#fff4b0', b: '#6b4a2a', B: '#9a6e3a', y: '#e8c050', Y: '#ffe68a', g: '#8d9199', G: '#c9d1dc', r: '#c8302a', R: '#e86a4a',
  w: '#f0ead8', p: '#9a4af0', P: '#d0a0ff', n: '#3a6fd8', N: '#8fb8ff', e: '#5f9a3a', E: '#8fcf5a', s: '#e8b48a',
};

const ICONS: Record<string, string[]> = {
  bag: [
    '....kkkk....',
    '...kBBBBk...',
    '..kk....kk..',
    '.kbbbbbbbbk.',
    'kbBBBBBBBBbk',
    'kbByyyyyyBbk',
    'kbBBBYYBBBbk',
    'kbBBBBBBBBbk',
    'kbBBBBBBBBbk',
    'kbbBBBBBBbbk',
    '.kbbbbbbbbk.',
    '..kkkkkkkk..',
  ],
  char: [
    '...kkkkkk...',
    '..kggggggk..',
    '.kgGGGGGGgk.',
    '.kgGkssskgk.',
    '.kggssssggk.',
    '..kkssssk...',
    '.knnnnnnnnk.',
    'knnNnnnnNnnk',
    'kssnnnnnnssk',
    '.k.nnnnnn.k.',
    '...bbkkbb...',
    '...kk..kk...',
  ],
  home: [
    '.....kk.....',
    '....krRk....',
    '...krRRRk...',
    '..krRRRRRk..',
    '.krRRRRRRRk.',
    'kkkkkkkkkkkk',
    '.kBBBBBBBBk.',
    '.kBnnBBnnBk.',
    '.kBNnBBNnBk.',
    '.kBBBkkBBBk.',
    '.kBBBkyBBBk.',
    '.kkkkkkkkkk.',
  ],
  book: [
    '.kkkkkkkkk..',
    'krrrrrrrrrk.',
    'krRRRRRRRrk.',
    'krRyyyyyRrk.',
    'krRRRRRRRrk.',
    'krRyyyyRRrk.',
    'krRRRRRRRrk.',
    'krRRRRRRRrk.',
    'krrrrrrrrrk.',
    'kwwwwwwwwwk.',
    '.kkkkkkkkkk.',
    '............',
  ],
  help: [
    '...kkkkkk...',
    '..kPPPPPPk..',
    '.kPpppppPPk.',
    '.kPpkkkppPk.',
    '.kkk..kppPk.',
    '.....kppPk..',
    '....kppPk...',
    '....kpPk....',
    '....kkkk....',
    '....kppk....',
    '....kPPk....',
    '....kkkk....',
  ],
  gear: [
    '.....kk.....',
    '..k.kGGk.k..',
    '.kGkGGGGkGk.',
    '..kGGggGGk..',
    '.kGGk..kGGk.',
    'kGGk....kGGk',
    'kGGk....kGGk',
    '.kGGk..kGGk.',
    '..kGGggGGk..',
    '.kGkGGGGkGk.',
    '..k.kGGk.k..',
    '.....kk.....',
  ],
  coin: [
    '............',
    '...kkkkkk...',
    '..kyyyyyyk..',
    '.kyYYYYYyyk.',
    '.kyYyyyyyyk.',
    '.kyYyykyyyk.',
    '.kyYyykyyyk.',
    '.kyyyyyyyyk.',
    '.kyyyyyyyyk.',
    '..kyyyyyyk..',
    '...kkkkkk...',
    '............',
  ],
  weight: [
    '....kkkk....',
    '...k....k...',
    '...k....k...',
    '..kkkkkkkk..',
    '.kggggggggk.',
    '.kgGGGGGGgk.',
    'kgGGGGGGGGgk',
    'kgGGggggGGgk',
    'kgGGGGGGGGgk',
    'kggggggggggk',
    '.kkkkkkkkkk.',
    '............',
  ],
};

// ---- 技能圖示（依元素）----
Object.assign(ICONS, {
  sk_physical: [
    '..........kk',
    '.........kGk',
    '........kGk.',
    '.......kGk..',
    '......kGk...',
    '.....kGk....',
    '..k.kGk.....',
    '..kkGk......',
    '...kk.......',
    '..kykk......',
    '.kyk........',
    '.kk.........',
  ],
  sk_fire: [
    '.....k......',
    '....kFk.....',
    '....kFk..k..',
    '...kFfFk.kk.',
    '..kFffFk.kFk',
    '..kFffrFkFFk',
    '.kFfrrrfFFk.',
    '.kFfrrrrfFk.',
    '.kFfrRRrfFk.',
    '..kFfRRfFk..',
    '...kFffFk...',
    '....kkkk....',
  ],
  sk_ice: [
    '.....kk.....',
    '..k..kCk..k.',
    '..kk.kCk.kk.',
    '...kkcCkkk..',
    '.kkkccCcckkk',
    'kCCCCcCcCCCk',
    '.kkkccCcckkk',
    '...kkcCkkk..',
    '..kk.kCk.kk.',
    '..k..kCk..k.',
    '.....kCk....',
    '.....kk.....',
  ],
  sk_lightning: [
    '......kkkk..',
    '.....kLlk...',
    '....kLlk....',
    '...kLlk.....',
    '..kLlkkkk...',
    '.kLlllllk...',
    '..kkkklLk...',
    '....kLlk....',
    '...kLlk.....',
    '..kLlk......',
    '..kLk.......',
    '..kk........',
  ],
  sk_holy: [
    '.....kk.....',
    '....khhk....',
    '..k.khhk.k..',
    '.khkkhhkkhk.',
    '.khhhhhhhhk.',
    'kkkhhwwhhkkk',
    'khhhhwwhhhhk',
    '.kkkhhhhkkk.',
    '...khhhhk...',
    '....khhk....',
    '....khhk....',
    '.....kk.....',
  ],
  sk_gold: ICONS_COIN(),
  sk_passive: [
    '....kkkk....',
    '...kggggk...',
    '..kgGGGGgk..',
    '.kgGnnnnGgk.',
    '.kgGnNNnGgk.',
    '.kgGnNNnGgk.',
    '.kgGnnnnGgk.',
    '..kgGGGGgk..',
    '...kggggk...',
    '....kggk....',
    '.....kk.....',
    '............',
  ],
});

function ICONS_COIN(): string[] {
  return [
    '............', '...kkkkkk...', '..kyyyyyyk..', '.kyYYYYYyyk.', '.kyYyykyyyk.', '.kyYykkkyyk.',
    '.kyYyykyyyk.', '.kyyykkkyyk.', '.kyyyykyyyk.', '..kyyyyyyk..', '...kkkkkk...', '............',
  ];
}

const cache = new Map<string, string>();

export function pixelIcon(name: keyof typeof ICONS | string, scale = 3): string {
  const key = `${name}@${scale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = ICONS[name];
  const c = document.createElement('canvas');
  c.width = c.height = 12 * scale;
  const g = c.getContext('2d')!;
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const col = PALETTE[ch];
    if (!col) return;
    g.fillStyle = col;
    g.fillRect(x * scale, y * scale, scale, scale);
  }));
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}
