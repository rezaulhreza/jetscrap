import { describe, expect, it } from 'vitest';
import { Btn, DT, PLAYER_H, PLAYER_W, RESPAWN_TIME, SHOULDER_Y, TICK_RATE } from '../src/shared/constants';
import { MAPS } from '../src/shared/maps';
import { navFor } from '../src/shared/nav';
import { boxOverlapsRect, groundBelow, lineOfSight } from '../src/shared/physics';
import { mulberry32 } from '../src/shared/rng';
import { World } from '../src/shared/sim';
import { DEFAULT_SETTINGS, type Difficulty, type InputFrame, type MatchSettings } from '../src/shared/types';

const settings = (over: Partial<MatchSettings> = {}): MatchSettings => ({ ...DEFAULT_SETTINGS, bots: 0, ...over });

function run(world: World, seconds: number, each?: () => void) {
  for (let i = 0; i < seconds * TICK_RATE; i++) {
    each?.();
    world.step();
    world.drainEvents();
  }
}

function skipCountdown(world: World) {
  run(world, 3.1);
  expect(world.match.phase).toBe('live');
}

describe('maps', () => {
  for (const map of Object.values(MAPS)) {
    it(`${map.id}: spawns and items sit on free ground`, () => {
      for (const s of map.spawns) {
        const blocked = map.solids.some((r) => boxOverlapsRect(s.x - PLAYER_W / 2, s.y + 0.01, PLAYER_W, PLAYER_H, r));
        expect(blocked, `spawn ${s.x},${s.y} inside a solid`).toBe(false);
        expect(Math.abs(groundBelow(map, s.x, s.y) - s.y), `spawn ${s.x},${s.y} floats`).toBeLessThan(0.05);
      }
      for (const it of map.items) {
        expect(Math.abs(groundBelow(map, it.x, it.y) - it.y), `item ${it.kind} at ${it.x},${it.y} floats`).toBeLessThan(0.05);
      }
      expect(map.spawns.filter((s) => s.team === 0).length).toBeGreaterThanOrEqual(4);
    });

    it(`${map.id}: every spawn can reach every other spawn`, () => {
      const nav = navFor(map);
      const [a, ...rest] = map.spawns;
      for (const b of rest) expect(nav.findPath(a.x, a.y, b.x, b.y, 20000), `${a.x},${a.y} -> ${b.x},${b.y}`).not.toBeNull();
    });
  }
});

describe('movement', () => {
  it('lands on the floor, runs, and jumps', () => {
    const w = new World(settings(), 1);
    const p = w.addPlayer({ name: 'A' })!;
    skipCountdown(w);
    expect(p.grounded).toBe(true);
    const x0 = p.x;
    run(w, 0.5, () => w.setInput(p.id, { seq: 0, b: 0, mx: 1, aim: 0 }));
    expect(p.x).toBeGreaterThan(x0 + 2);
    w.setInput(p.id, { seq: 0, b: Btn.Up, mx: 0, aim: 0 });
    w.step();
    expect(p.vy).toBeGreaterThan(5);
  });

  it('burns fuel while the jetpack fires and refills on the ground', () => {
    const w = new World(settings(), 2);
    const p = w.addPlayer({ name: 'A' })!;
    skipCountdown(w);
    run(w, 1, () => w.setInput(p.id, { seq: 0, b: Btn.Up, mx: 0, aim: 0 }));
    expect(p.fuel).toBeLessThan(70);
    run(w, 3, () => w.setInput(p.id, { seq: 0, b: 0, mx: 0, aim: 0 }));
    expect(p.fuel).toBe(100);
  });
});

describe('combat', () => {
  function duel() {
    const w = new World(settings({ map: 'foundry' }), 3);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    skipCountdown(w);
    run(w, 2.1);
    // Put both on the open floor, 6 units apart, facing each other.
    Object.assign(a, { x: 18, y: 2, vx: 0, vy: 0, protect: 0 });
    Object.assign(b, { x: 24, y: 2, vx: 0, vy: 0, protect: 0 });
    return { w, a, b };
  }

  it('rate-limits fire to the weapon interval', () => {
    const { w, a } = duel();
    let shots = 0;
    for (let i = 0; i < TICK_RATE; i++) {
      w.setInput(a.id, { seq: i, b: Btn.Fire, mx: 0, aim: Math.PI / 2 });
      w.step();
      shots += w.drainEvents().filter((e) => e.k === 'shot' && e.p === a.id).length;
    }
    // Hornet AR: 0.095 s interval, 30 rounds, so about 11 shots in one second.
    expect(shots).toBeGreaterThanOrEqual(10);
    expect(shots).toBeLessThanOrEqual(11);
  });

  it('stops bullets at one-way platforms from below and above', () => {
    const { w, a, b } = duel();
    const plat = w.map.platforms.find((r) => r.y > 15 && r.y < 21)!;
    const top = plat.y + plat.h;
    const x = plat.x + plat.w / 2;
    const shoot = (from: typeof a, to: typeof a, aim: number) => {
      to.hp = 100;
      for (let i = 0; i < TICK_RATE; i++) {
        w.setInput(from.id, { seq: i, b: Btn.Fire, mx: 0, aim });
        Object.assign(from, { x, vx: 0 });
        Object.assign(to, { x, vx: 0 });
        w.step();
        w.drainEvents();
      }
      return to.hp;
    };
    Object.assign(a, { y: groundBelow(w.map, x, plat.y - 0.1), vy: 0 });
    Object.assign(b, { y: top, vy: 0 });
    expect(shoot(a, b, Math.PI / 2)).toBe(100);
    expect(shoot(b, a, -Math.PI / 2)).toBe(100);
  });

  it('kills, credits the killer, drops the weapon and respawns the victim', () => {
    const { w, a, b } = duel();
    let killed = false;
    for (let i = 0; i < 3 * TICK_RATE && !killed; i++) {
      w.setInput(a.id, { seq: i, b: Btn.Fire, mx: 0, aim: 0.06 });
      w.setInput(b.id, { seq: i, b: 0, mx: 0, aim: Math.PI });
      b.x = 24;
      w.step();
      killed = w.drainEvents().some((e) => e.k === 'kill' && e.p === b.id && e.by === a.id);
    }
    expect(killed).toBe(true);
    expect(a.kills).toBe(1);
    expect(b.deaths).toBe(1);
    expect(b.alive).toBe(false);
    expect(w.pickupStates.some((p) => p.dropped && p.weapon === 'rifle')).toBe(true);
    run(w, RESPAWN_TIME + 0.1);
    expect(b.alive).toBe(true);
    expect(b.protect).toBeGreaterThan(0);
  });

  it('ignores damage during spawn protection and between teammates', () => {
    const w = new World(settings({ mode: 'tdm' }), 4);
    const a = w.addPlayer({ name: 'A', team: 0 })!;
    const b = w.addPlayer({ name: 'B', team: 0 })!;
    const c = w.addPlayer({ name: 'C', team: 1 })!;
    skipCountdown(w);
    c.protect = 1;
    w.damage(c, 50, a.id, 'rifle', false, 0, 0);
    expect(c.hp).toBe(100);
    b.protect = 0;
    w.damage(b, 50, a.id, 'rifle', false, 0, 0);
    expect(b.hp).toBe(100);
  });

  it('armour absorbs part of the damage', () => {
    const w = new World(settings(), 5);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    skipCountdown(w);
    Object.assign(b, { protect: 0, armor: 50 });
    w.damage(b, 40, a.id, 'rifle', false, 0, 0);
    expect(b.armor).toBeCloseTo(26);
    expect(b.hp).toBeCloseTo(84);
  });

  it('credits assists', () => {
    const w = new World(settings(), 6);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    const c = w.addPlayer({ name: 'C' })!;
    skipCountdown(w);
    for (const p of [a, b, c]) p.protect = 0;
    w.damage(c, 40, b.id, 'rifle', false, 0, 0);
    w.damage(c, 70, a.id, 'rifle', false, 0, 0);
    expect(c.alive).toBe(false);
    expect(a.kills).toBe(1);
    expect(b.assists).toBe(1);
  });

  it('ends the match at the kill limit', () => {
    const w = new World(settings({ killLimit: 2 }), 7);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    skipCountdown(w);
    for (let i = 0; i < 2; i++) {
      b.protect = 0;
      w.damage(b, 200, a.id, 'sniper', true, 0, 0);
      run(w, RESPAWN_TIME + 0.1);
    }
    expect(w.match.phase).toBe('ended');
    expect(w.match.winner).toBe(a.id);
  });

  it('ignores malformed input values', () => {
    const w = new World(settings(), 8);
    const a = w.addPlayer({ name: 'A' })!;
    skipCountdown(w);
    const bad = { seq: 1, b: 0, mx: 50, aim: Number.NaN } as InputFrame;
    run(w, 1, () => w.setInput(a.id, bad));
    expect(Number.isFinite(a.aim)).toBe(true);
    expect(Math.abs(a.vx)).toBeLessThanOrEqual(8.5 + 1e-6);
  });
});

describe('bots', () => {
  for (const mode of ['ffa', 'tdm'] as const) {
    for (const map of Object.keys(MAPS)) {
      it(`fight a full ${mode} match on ${map}`, () => {
        const w = new World(settings({ mode, map, timeLimit: 120, killLimit: 999 }), 42);
        for (let i = 0; i < 8; i++) w.addPlayer({ name: `Bot${i}`, bot: (['easy', 'normal', 'hard', 'elite'] as const)[i % 4] });
        let shots = 0;
        let pickups = 0;
        const start = performance.now();
        for (let t = 0; t < 125 * TICK_RATE && w.match.phase !== 'ended'; t++) {
          w.step();
          for (const e of w.drainEvents()) {
            if (e.k === 'shot') shots++;
            if (e.k === 'pickup') pickups++;
          }
        }
        const ms = performance.now() - start;
        const kills = [...w.players.values()].reduce((s, p) => s + p.kills, 0);
        expect(w.match.phase).toBe('ended');
        expect(shots).toBeGreaterThan(200);
        expect(kills).toBeGreaterThan(8);
        expect(pickups).toBeGreaterThan(3);
        // 2 minutes of game time with 8 bots must simulate far faster than real time.
        expect(ms).toBeLessThan(8000);
        // eslint-disable-next-line no-console
        console.log(`${mode}/${map}: ${kills} kills, ${shots} shots, ${pickups} pickups, ${ms.toFixed(0)} ms, ${(ms / (120 * TICK_RATE)).toFixed(3)} ms/tick`);
      });
    }
  }
});

describe('bot aim', () => {
  /** One bot against a scripted target on open ground. The target cannot die. Returns the bot's hit rate. */
  function hitRate(diff: 'easy' | 'normal' | 'hard' | 'elite', strafe: boolean): number {
    let shots = 0;
    let hits = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const w = new World(settings({ killLimit: 999, timeLimit: 600 }), seed);
      const h = w.addPlayer({ name: 'Target' })!;
      const b = w.addPlayer({ name: 'Bot', bot: diff })!;
      run(w, 3.4);
      Object.assign(h, { x: 20, y: 2, vx: 0, vy: 0 });
      Object.assign(b, { x: 32, y: 2, vx: 0, vy: 0, protect: 0 });
      for (let t = 0; t < 10 * TICK_RATE; t++) {
        Object.assign(h, { hp: 100, protect: 0, alive: true });
        const mx = strafe ? (Math.floor(t / 40) % 2 ? 1 : -1) : 0;
        const hop = strafe && t % 90 < 20 ? Btn.Up : 0;
        w.setInput(h.id, { seq: t, b: hop, mx, aim: 0 });
        h.x = Math.min(26, Math.max(16, h.x));
        w.step();
        for (const e of w.drainEvents()) {
          if (e.k === 'bullet' && e.p === b.id) shots++;
          if (e.k === 'hit' && e.by === b.id && e.p === h.id) hits++;
        }
      }
    }
    return hits / Math.max(1, shots);
  }

  it('misses a strafing player most of the time below elite', () => {
    expect(hitRate('easy', true)).toBeLessThan(0.3);
    expect(hitRate('normal', true)).toBeLessThan(0.4);
    expect(hitRate('hard', true)).toBeLessThan(0.45);
  });

  it('gets more accurate with difficulty', () => {
    const easy = hitRate('easy', false);
    const elite = hitRate('elite', false);
    expect(easy).toBeLessThan(0.6);
    expect(elite).toBeGreaterThan(easy + 0.15);
  });
});

describe('bot difficulty', () => {
  /**
   * One duel on open ground between a bot and a scripted human with touchpad-like aim:
   * it aims 0.3 s behind the bot with a drifting error, needs 0.6 s to react and seldom
   * strafes. Returns the winner of the first kill.
   */
  function duel(diff: Difficulty, seed: number): 'human' | 'bot' | 'draw' {
    const w = new World(settings({ killLimit: 999, timeLimit: 600, difficulty: diff }), seed);
    const rand = mulberry32(seed * 7 + 1);
    const h = w.addPlayer({ name: 'Human' })!;
    const b = w.addPlayer({ name: 'Bot', bot: diff })!;
    run(w, 3.4);
    Object.assign(h, { x: 18, y: 2, vx: 0, vy: 0, protect: 0 });
    Object.assign(b, { x: 30, y: 2, vx: 0, vy: 0, protect: 0 });
    const seen: { x: number; y: number }[] = [];
    let off = 0;
    let offTarget = 0;
    let nextOff = 0;
    let seenAt = -1;
    let mx = 0;
    let moveUntil = 0;
    for (let t = 0; t < 12 * TICK_RATE; t++) {
      const now = t * DT;
      const visible = lineOfSight(w.map, h.x, h.y + 1.55, b.x, b.y + 1.0);
      let buttons = 0;
      let aim = b.x > h.x ? 0 : Math.PI;
      if (visible) {
        if (seenAt < 0) seenAt = now;
        seen.push({ x: b.x, y: b.y });
        if (now >= nextOff) {
          offTarget = (rand() * 2 - 1) * 2;
          nextOff = now + 0.25 + rand() * 0.3;
        }
        off += (offTarget - off) * Math.min(1, DT * 6);
        const s = seen[Math.max(0, seen.length - 1 - Math.round(0.3 / DT))];
        const lx = s.x - h.x;
        const ly = s.y + 1.05 - (h.y + SHOULDER_Y);
        const d = Math.hypot(lx, ly) || 1;
        aim = Math.atan2(ly + (lx / d) * off, lx - (ly / d) * off);
        if (now - seenAt > 0.6) buttons |= Btn.Fire;
      } else {
        seenAt = -1;
      }
      if (now > moveUntil) {
        mx = rand() < 0.2 ? (rand() < 0.5 ? -1 : 1) : 0;
        moveUntil = now + 0.4 + rand() * 0.6;
      }
      if (!visible) mx = b.x > h.x ? 1 : -1;
      w.setInput(h.id, { seq: t, b: buttons, mx, aim });
      w.step();
      for (const e of w.drainEvents()) if (e.k === 'kill') return e.p === b.id ? 'human' : 'bot';
    }
    return 'draw';
  }

  function humanWinRate(diff: Difficulty): number {
    let human = 0;
    let bot = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = duel(diff, seed);
      if (r === 'human') human++;
      if (r === 'bot') bot++;
    }
    return human / Math.max(1, human + bot);
  }

  it('lets a player with touchpad aim win most duels on easy and about half on normal', () => {
    const easy = humanWinRate('easy');
    const normal = humanWinRate('normal');
    const hard = humanWinRate('hard');
    const elite = humanWinRate('elite');
    expect(easy).toBeGreaterThan(0.8);
    expect(normal).toBeGreaterThan(0.35);
    expect(normal).toBeLessThan(0.75);
    expect(hard).toBeLessThan(normal - 0.15);
    expect(elite).toBeLessThan(hard);
  });
});
