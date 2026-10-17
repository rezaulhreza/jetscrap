import type { WeaponId } from '../shared/weapons';

/**
 * Procedural sound effects with Web Audio. No audio files: every sound is built from
 * filtered noise and oscillators, so the game stays self-contained. Sounds are panned
 * and attenuated by their distance from the listener.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private noise!: AudioBuffer;
  private jet: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private volumes = { master: 0.8, effects: 0.9 };
  listenerX = 0;
  listenerY = 0;
  private lastPlay = new Map<string, number>();

  /** Must run from a user gesture (browser autoplay rules). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.sfx = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.sfx.connect(this.master);
    this.master.connect(comp);
    comp.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.setVolumes(this.volumes.master, this.volumes.effects);
  }

  setVolumes(master: number, effects: number): void {
    this.volumes = { master, effects };
    if (!this.ctx) return;
    this.master.gain.value = master;
    this.sfx.gain.value = effects;
  }

  dispose(): void {
    this.stopJet();
    void this.ctx?.close();
    this.ctx = null;
  }

  private spatial(x?: number, y?: number): { gain: number; pan: number } | null {
    if (x === undefined || y === undefined) return { gain: 1, pan: 0 };
    const dx = x - this.listenerX;
    const d = Math.hypot(dx, y - this.listenerY);
    if (d > 60) return null;
    return { gain: 1 / (1 + d * d * 0.004), pan: Math.max(-1, Math.min(1, dx / 25)) };
  }

  /** Avoids stacking the same sound many times in one frame. */
  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.lastPlay.get(key) ?? 0) + ms > now) return false;
    this.lastPlay.set(key, now);
    return true;
  }

  private out(gain: number, pan: number): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(this.sfx);
    return g;
  }

  private noiseBurst(dest: AudioNode, opts: { type: BiquadFilterType; freq: number; q?: number; dur: number; vol: number; freqEnd?: number }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + opts.dur + 0.05);
  }

  private tone(dest: AudioNode, opts: { type: OscillatorType; freq: number; freqEnd?: number; dur: number; vol: number; delay?: number }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type;
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) o.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + opts.dur + 0.05);
  }

  shot(w: WeaponId, x: number, y: number, mine: boolean): void {
    if (!this.ctx) return;
    const s = this.spatial(x, y);
    if (!s || !this.throttle(`shot${w}${mine}`, 30)) return;
    const out = this.out(s.gain * (mine ? 1 : 0.7), s.pan);
    switch (w) {
      case 'pistol':
        this.noiseBurst(out, { type: 'bandpass', freq: 2200, freqEnd: 700, dur: 0.12, vol: 0.5, q: 0.6 });
        this.tone(out, { type: 'square', freq: 380, freqEnd: 120, dur: 0.06, vol: 0.12 });
        break;
      case 'rifle':
        this.noiseBurst(out, { type: 'bandpass', freq: 1500, freqEnd: 500, dur: 0.1, vol: 0.45, q: 0.7 });
        this.tone(out, { type: 'sawtooth', freq: 160, freqEnd: 60, dur: 0.07, vol: 0.12 });
        break;
      case 'shotgun':
        this.noiseBurst(out, { type: 'lowpass', freq: 2600, freqEnd: 300, dur: 0.32, vol: 0.85 });
        this.tone(out, { type: 'sine', freq: 110, freqEnd: 40, dur: 0.2, vol: 0.4 });
        break;
      case 'sniper':
        this.noiseBurst(out, { type: 'highpass', freq: 1200, dur: 0.25, vol: 0.6 });
        this.tone(out, { type: 'sawtooth', freq: 900, freqEnd: 90, dur: 0.35, vol: 0.18 });
        this.tone(out, { type: 'sine', freq: 90, freqEnd: 40, dur: 0.3, vol: 0.35 });
        break;
      case 'rocket':
        this.noiseBurst(out, { type: 'lowpass', freq: 900, freqEnd: 200, dur: 0.45, vol: 0.6 });
        this.tone(out, { type: 'triangle', freq: 220, freqEnd: 70, dur: 0.3, vol: 0.2 });
        break;
    }
  }

  boom(x: number, y: number, big = 1): void {
    if (!this.ctx) return;
    const s = this.spatial(x, y);
    if (!s || !this.throttle('boom', 40)) return;
    const out = this.out(Math.min(1.2, s.gain * 1.4 * big), s.pan);
    this.noiseBurst(out, { type: 'lowpass', freq: 1800, freqEnd: 90, dur: 0.9, vol: 1 });
    this.tone(out, { type: 'sine', freq: 70, freqEnd: 28, dur: 0.7, vol: 0.8 });
  }

  impact(x: number, y: number, flesh: boolean): void {
    if (!this.ctx) return;
    const s = this.spatial(x, y);
    if (!s || !this.throttle(flesh ? 'flesh' : 'ric', 45)) return;
    const out = this.out(s.gain * 0.5, s.pan);
    if (flesh) this.noiseBurst(out, { type: 'lowpass', freq: 900, dur: 0.08, vol: 0.5 });
    else this.tone(out, { type: 'triangle', freq: 2400 + Math.random() * 1600, freqEnd: 900, dur: 0.07, vol: 0.08 });
  }

  /** Confirmation that your shot landed. */
  hitMarker(head: boolean): void {
    if (!this.ctx || !this.throttle('hm', 40)) return;
    const out = this.out(0.5, 0);
    this.tone(out, { type: 'square', freq: head ? 1900 : 1300, dur: 0.05, vol: 0.12 });
  }

  killConfirm(): void {
    if (!this.ctx) return;
    const out = this.out(0.6, 0);
    this.tone(out, { type: 'triangle', freq: 660, dur: 0.12, vol: 0.25 });
    this.tone(out, { type: 'triangle', freq: 990, dur: 0.18, vol: 0.25, delay: 0.08 });
  }

  hurt(): void {
    if (!this.ctx || !this.throttle('hurt', 120)) return;
    const out = this.out(0.6, 0);
    this.noiseBurst(out, { type: 'lowpass', freq: 500, dur: 0.15, vol: 0.6 });
    this.tone(out, { type: 'sine', freq: 140, freqEnd: 80, dur: 0.15, vol: 0.3 });
  }

  pickup(kind: string): void {
    if (!this.ctx) return;
    const out = this.out(0.5, 0);
    const base = kind === 'health' ? 520 : kind === 'armor' ? 440 : kind === 'overdrive' || kind === 'haste' ? 700 : 600;
    this.tone(out, { type: 'sine', freq: base, dur: 0.1, vol: 0.25 });
    this.tone(out, { type: 'sine', freq: base * 1.5, dur: 0.16, vol: 0.22, delay: 0.07 });
  }

  click(): void {
    if (!this.ctx) return;
    this.tone(this.out(0.35, 0), { type: 'square', freq: 1800, dur: 0.025, vol: 0.08 });
  }

  reload(): void {
    if (!this.ctx) return;
    const out = this.out(0.45, 0);
    this.noiseBurst(out, { type: 'bandpass', freq: 3000, dur: 0.05, vol: 0.4, q: 3 });
    const ctx = this.ctx;
    setTimeout(() => ctx === this.ctx && this.noiseBurst(out, { type: 'bandpass', freq: 2200, dur: 0.06, vol: 0.4, q: 3 }), 260);
  }

  beep(high: boolean): void {
    if (!this.ctx) return;
    this.tone(this.out(0.5, 0), { type: 'square', freq: high ? 880 : 440, dur: high ? 0.35 : 0.15, vol: 0.12 });
  }

  /** Continuous jetpack hiss for the local player. */
  setJet(on: boolean): void {
    if (!this.ctx) return;
    if (!this.jet) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 700;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfx);
      src.start();
      this.jet = { src, gain, filter };
    }
    const t = this.ctx.currentTime;
    this.jet.gain.gain.setTargetAtTime(on ? 0.16 : 0, t, on ? 0.03 : 0.08);
    this.jet.filter.frequency.setTargetAtTime(on ? 900 + Math.random() * 200 : 500, t, 0.05);
  }

  stopJet(): void {
    if (!this.jet) return;
    try {
      this.jet.src.stop();
    } catch {
      // Already stopped.
    }
    this.jet = null;
  }
}
