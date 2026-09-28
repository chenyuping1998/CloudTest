/**
 * 程序化音效與背景音樂（WebAudio 即時合成，不需要任何音檔）。
 *
 * - 音效：振盪器 + 雜訊 + 包絡線，依距離衰減
 * - 音樂：每張地圖一段 8 小節的晶片音樂（8-bit），由固定種子產生，重複播放；換地圖時淡入淡出
 * - 瀏覽器規定要使用者操作過才能發聲，所以第一次點擊 / 按鍵時才建立 AudioContext
 *
 * 之後有正式音樂時，只要把 playMusic() 換成播放音檔即可，呼叫端不用改。
 */
import { SeededRng } from '../core/rng';
import type { ZoneId } from '../shared/maps';
import { settings } from './settings';

export type Sfx =
  | 'hit' | 'crit' | 'miss' | 'hurt' | 'heal' | 'levelup' | 'pickup' | 'coin' | 'ui' | 'error' | 'death'
  | 'mine' | 'chop' | 'enchantOk' | 'enchantFail' | 'portal' | 'achievement' | 'rare'
  | 'skill_physical' | 'skill_fire' | 'skill_ice' | 'skill_lightning' | 'skill_holy' | 'skill_gold';

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

interface Song {
  bpm: number;
  /** 以 MIDI 音高表示的音階（兩個八度內） */
  scale: number[];
  /** 每小節的和弦根音（音階索引） */
  chords: number[];
  lead: OscillatorType;
  drums: boolean;
  seed: number;
}

const SONGS: Record<ZoneId, Song> = {
  // 晨曦平原：明亮的大調
  field: { bpm: 104, scale: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76], chords: [0, 5, 3, 4, 0, 5, 3, 4], lead: 'square', drums: true, seed: 11 },
  // 家園：五聲音階、慢、溫暖
  homestead: { bpm: 84, scale: [60, 62, 64, 67, 69, 72, 74, 76], chords: [0, 3, 4, 0, 0, 3, 4, 2], lead: 'triangle', drums: false, seed: 23 },
  // 霜語山脈：多利安小調、清冷
  frost: { bpm: 76, scale: [62, 64, 65, 67, 69, 71, 72, 74, 76, 77], chords: [0, 3, 6, 4, 0, 3, 5, 4], lead: 'sine', drums: false, seed: 37 },
  // 餘燼深淵：弗里吉安、低沉急促
  ember: { bpm: 118, scale: [52, 53, 55, 57, 59, 60, 62, 64, 65, 67], chords: [0, 1, 0, 6, 0, 1, 5, 4], lead: 'sawtooth', drums: true, seed: 53 },
};

class AudioEngine {
  private ctx?: AudioContext;
  private master?: GainNode;
  private sfxBus?: GainNode;
  private musicBus?: GainNode;
  private noise?: AudioBuffer;
  private songGain?: GainNode;
  private songTimer?: number;
  private currentZone?: ZoneId;
  private wantedZone?: ZoneId;
  private lastPlayed = new Map<Sfx, number>();

  /** 第一次使用者操作時呼叫（瀏覽器的自動播放規定） */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    const rng = new SeededRng(99);
    for (let i = 0; i < len; i++) data[i] = rng.next() * 2 - 1;
    this.applyVolumes();
    if (this.wantedZone) this.playMusic(this.wantedZone);
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    const s = settings.get();
    const t = this.ctx.currentTime;
    this.master!.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    this.sfxBus!.gain.setTargetAtTime(s.sfx, t, 0.05);
    this.musicBus!.gain.setTargetAtTime(s.music * 0.55, t, 0.05);
  }

  // ------------------------------------------------------------ 音效

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, opts: { slide?: number; delay?: number; attack?: number } = {}): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, vol: number, filter: { type: BiquadFilterType; freq: number; q?: number }, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.value = filter.freq;
    f.Q.value = filter.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /**
   * 播放音效。
   * @param distance 與畫面中心的距離（格）；越遠越小聲，超過 30 格不播
   */
  play(name: Sfx, distance = 0): void {
    if (!this.ctx || !this.sfxBus) return;
    if (distance > 30) return;
    // 同一種音效 40ms 內只播一次，避免一群怪同時被打時爆音
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? 0) < 40) return;
    this.lastPlayed.set(name, now);
    const v = Math.max(0.15, 1 - distance / 30);
    switch (name) {
      case 'hit': this.burst(0.08, 0.35 * v, { type: 'bandpass', freq: 1800, q: 1.5 }); this.tone(180, 0.08, 'square', 0.12 * v, { slide: 0.5 }); break;
      case 'crit': this.burst(0.14, 0.45 * v, { type: 'bandpass', freq: 2600, q: 1 }); this.tone(520, 0.12, 'square', 0.14 * v, { slide: 0.4 }); this.tone(1040, 0.1, 'square', 0.08 * v, { delay: 0.03 }); break;
      case 'miss': this.burst(0.12, 0.18 * v, { type: 'highpass', freq: 3000 }); break;
      case 'hurt': this.tone(220, 0.16, 'sawtooth', 0.16 * v, { slide: 0.5 }); this.burst(0.1, 0.2 * v, { type: 'lowpass', freq: 900 }); break;
      case 'death': this.tone(300, 0.35, 'square', 0.12 * v, { slide: 0.25 }); this.burst(0.3, 0.2 * v, { type: 'lowpass', freq: 600 }); break;
      case 'heal': [72, 76, 79].forEach((n, i) => this.tone(NOTE(n), 0.25, 'sine', 0.12 * v, { delay: i * 0.06 })); break;
      case 'levelup': [60, 64, 67, 72, 76, 79, 84].forEach((n, i) => this.tone(NOTE(n), 0.3, 'square', 0.1, { delay: i * 0.07 })); break;
      case 'achievement': [67, 72, 76, 84].forEach((n, i) => this.tone(NOTE(n), 0.45, 'triangle', 0.16, { delay: i * 0.1 })); break;
      case 'rare': [79, 84, 88, 91, 96].forEach((n, i) => this.tone(NOTE(n), 0.35, 'square', 0.07, { delay: i * 0.05 })); break;
      case 'pickup': this.tone(NOTE(84), 0.06, 'square', 0.08); this.tone(NOTE(91), 0.08, 'square', 0.07, { delay: 0.05 }); break;
      case 'coin': this.tone(NOTE(88), 0.05, 'square', 0.07); this.tone(NOTE(93), 0.14, 'square', 0.07, { delay: 0.05 }); break;
      case 'ui': this.tone(NOTE(79), 0.035, 'square', 0.045); break;
      case 'error': this.tone(NOTE(50), 0.12, 'square', 0.08); this.tone(NOTE(47), 0.16, 'square', 0.08, { delay: 0.1 }); break;
      case 'mine': this.burst(0.07, 0.4 * v, { type: 'bandpass', freq: 3200, q: 3 }); this.tone(1400, 0.05, 'square', 0.06 * v, { slide: 0.7 }); break;
      case 'chop': this.burst(0.09, 0.4 * v, { type: 'bandpass', freq: 700, q: 2 }); this.tone(160, 0.07, 'triangle', 0.15 * v); break;
      case 'enchantOk': [72, 79, 84, 91].forEach((n, i) => this.tone(NOTE(n), 0.4, 'sine', 0.12, { delay: i * 0.08 })); break;
      case 'enchantFail': this.tone(NOTE(55), 0.6, 'sawtooth', 0.14, { slide: 0.3 }); this.burst(0.5, 0.25, { type: 'lowpass', freq: 400 }); break;
      case 'portal': this.tone(200, 0.6, 'sine', 0.14, { slide: 4, attack: 0.1 }); this.tone(300, 0.6, 'triangle', 0.08, { slide: 3, attack: 0.1, delay: 0.05 }); break;
      case 'skill_physical': this.burst(0.18, 0.4 * v, { type: 'bandpass', freq: 1200, q: 0.8 }); this.tone(140, 0.15, 'square', 0.12 * v, { slide: 0.5 }); break;
      case 'skill_fire': this.burst(0.45, 0.45 * v, { type: 'lowpass', freq: 1400 }); this.tone(90, 0.4, 'sawtooth', 0.12 * v, { slide: 0.6 }); break;
      case 'skill_ice': [88, 91, 96].forEach((n, i) => this.tone(NOTE(n), 0.3, 'sine', 0.1 * v, { delay: i * 0.04 })); this.burst(0.2, 0.15 * v, { type: 'highpass', freq: 5000 }); break;
      case 'skill_lightning': this.burst(0.3, 0.5 * v, { type: 'highpass', freq: 1500 }); this.tone(60, 0.3, 'sawtooth', 0.15 * v); break;
      case 'skill_holy': [76, 83, 88].forEach((n, i) => this.tone(NOTE(n), 0.5, 'triangle', 0.1 * v, { delay: i * 0.05, attack: 0.05 })); break;
      case 'skill_gold': this.play('coin'); this.burst(0.15, 0.3 * v, { type: 'bandpass', freq: 2500, q: 2 }); break;
    }
  }

  // ------------------------------------------------------------ 音樂

  playMusic(zone: ZoneId): void {
    this.wantedZone = zone;
    if (!this.ctx || this.currentZone === zone) return;
    this.currentZone = zone;
    const ctx = this.ctx;
    // 舊的淡出
    if (this.songGain) {
      const old = this.songGain;
      old.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
      setTimeout(() => old.disconnect(), 3000);
    }
    if (this.songTimer) clearInterval(this.songTimer);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.setTargetAtTime(1, ctx.currentTime + 0.5, 1.2);
    gain.connect(this.musicBus!);
    this.songGain = gain;
    const song = SONGS[zone];
    const pattern = composeLoop(song);
    const step = 60 / song.bpm / 2; // 八分音符
    let nextTime = ctx.currentTime + 0.3;
    let i = 0;
    // 預排程：每 100ms 把接下來 0.4 秒內的音符排好（不受 setInterval 抖動影響）
    const schedule = () => {
      while (nextTime < ctx.currentTime + 0.4) {
        for (const n of pattern[i % pattern.length]) this.musicNote(gain, n, nextTime, step, song);
        nextTime += step;
        i++;
      }
    };
    schedule();
    this.songTimer = window.setInterval(schedule, 100);
  }

  private musicNote(bus: GainNode, n: MusicNote, t: number, step: number, song: Song): void {
    const ctx = this.ctx!;
    if (n.kind === 'kick' || n.kind === 'hat') {
      const src = ctx.createBufferSource();
      src.buffer = this.noise!;
      const f = ctx.createBiquadFilter();
      f.type = n.kind === 'kick' ? 'lowpass' : 'highpass';
      f.frequency.value = n.kind === 'kick' ? 180 : 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(n.kind === 'kick' ? 0.5 : 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (n.kind === 'kick' ? 0.12 : 0.04));
      src.connect(f).connect(g).connect(bus);
      src.start(t);
      src.stop(t + 0.15);
      return;
    }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = n.kind === 'bass' ? 'triangle' : n.kind === 'arp' ? 'square' : song.lead;
    o.frequency.setValueAtTime(NOTE(n.pitch), t);
    const vol = n.kind === 'bass' ? 0.16 : n.kind === 'arp' ? 0.035 : song.lead === 'sawtooth' ? 0.045 : 0.07;
    const dur = step * n.len * 0.95;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}

interface MusicNote {
  kind: 'bass' | 'arp' | 'lead' | 'kick' | 'hat';
  pitch: number;
  /** 長度（八分音符數） */
  len: number;
}

/** 由種子產生 8 小節（64 個八分音符）的循環：低音、分解和弦、旋律、鼓 */
export function composeLoop(song: Song): MusicNote[][] {
  const rng = new SeededRng(song.seed);
  const steps: MusicNote[][] = Array.from({ length: 64 }, () => []);
  const deg = (root: number, k: number) => song.scale[(root + k) % song.scale.length];
  let prev = 4;
  song.chords.forEach((root, bar) => {
    const base = bar * 8;
    steps[base].push({ kind: 'bass', pitch: deg(root, 0) - 24, len: 4 });
    steps[base + 4].push({ kind: 'bass', pitch: deg(root, 0) - 12, len: 4 });
    for (let k = 0; k < 8; k++) steps[base + k].push({ kind: 'arp', pitch: deg(root, [0, 2, 4, 2][k % 4]), len: 1 });
    // 旋律：在和弦音附近隨機走動，第 4、8 小節收在長音
    for (let k = 0; k < 8; ) {
      if (rng.next() < 0.22 && k > 0) {
        k++;
        continue;
      }
      prev = Math.max(0, Math.min(song.scale.length - 1, prev + Math.round((rng.next() - 0.5) * 4)));
      if (k === 0) prev = (root + [0, 2, 4][Math.floor(rng.next() * 3)]) % song.scale.length;
      // 不跨小節：最後一拍的音符不能延伸到下一小節的第一個音
      const len = bar % 4 === 3 && k >= 4 ? 8 - k : Math.min(8 - k, rng.next() < 0.3 ? 2 : 1);
      steps[base + k].push({ kind: 'lead', pitch: song.scale[prev] + 12, len });
      k += len;
    }
    if (song.drums) {
      for (let k = 0; k < 8; k += 4) steps[base + k].push({ kind: 'kick', pitch: 0, len: 1 });
      for (let k = 2; k < 8; k += 4) steps[base + k].push({ kind: 'hat', pitch: 0, len: 1 });
    }
  });
  return steps;
}

export const audio = new AudioEngine();
